import assert from 'node:assert/strict';
import { createPublicKey, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import http from 'node:http';

const temp = mkdtempSync(join(tmpdir(), 'codeandpurrs-autowake-test-'));
process.env.AUTOWAKE_DATA_DIR = temp;
const autowake = await import(`../server/autowake.mjs?test=${Date.now()}`);

test.after(() => rmSync(temp, { recursive: true, force: true }));

test('sanitizes hidden control markers before delivery', () => {
  assert.equal(
    autowake.sanitizeAutoWakeMessage(
      '[语音] 想你啦\n===\n过来抱抱 [记忆:心情|想她] [红包:20|乖] [[SPOTIFY_PLAYLIST:{"queries":["x"]}]]',
    ),
    '想你啦\n过来抱抱',
  );
});

test('quiet hours and idle/cooldown guards are enforced', () => {
  const noonMalaysia = Date.parse('2026-08-31T04:00:00.000Z');
  const client = {
    enabled: true,
    subscription: { endpoint: 'https://example.invalid/push' },
    state: { windowId: 'room', lastUserAt: noonMalaysia - 2 * 60 * 60_000 },
    nextWakeAt: noonMalaysia - 1,
    wakeDate: '2026-08-31',
    wakeCount: 0,
  };
  assert.equal(autowake.eligibility(client, noonMalaysia).ok, true);
  assert.equal(
    autowake.eligibility({ ...client, state: { ...client.state, lastUserAt: noonMalaysia - 30 * 60_000 } }, noonMalaysia).reason,
    'recent-chat',
  );
  const threeAMMalaysia = Date.parse('2026-08-30T19:00:00.000Z');
  assert.equal(autowake.eligibility({ ...client, state: { ...client.state, lastUserAt: threeAMMalaysia - 4 * 60 * 60_000 } }, threeAMMalaysia).reason, 'quiet');
});

test('old 4-7 hour schedules are clamped to the livelier policy', () => {
  const lastUserAt = Date.parse('2026-08-31T04:00:00.000Z');
  const afterChat = {
    state: { lastUserAt },
    lastWakeAt: 0,
    nextWakeAt: lastUserAt + 7 * 60 * 60_000,
  };
  autowake.clampLegacyWakeSchedule(afterChat);
  assert.equal(afterChat.nextWakeAt, lastUserAt + 2 * 60 * 60_000);

  const afterWake = {
    state: { lastUserAt: lastUserAt - 60_000 },
    lastWakeAt: lastUserAt,
    nextWakeAt: lastUserAt + 7 * 60 * 60_000,
  };
  autowake.clampLegacyWakeSchedule(afterWake);
  assert.equal(afterWake.nextWakeAt, lastUserAt + 4 * 60 * 60_000);
});

test('VAPID authorization is a valid ES256 JWT for the push origin', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
  const { authorization, publicKey } = autowake.createVapidAuthorization(endpoint, Date.parse('2026-08-31T04:00:00Z'));
  assert.match(authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);
  assert.ok(publicKey.length > 80);

  const token = authorization.match(/^vapid t=([^,]+),/)[1];
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');

  const keys = JSON.parse(readFileSync(join(temp, 'vapid.json'), 'utf8'));
  const verifier = createVerify('SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(
    verifier.verify(
      { key: createPublicKey({ key: keys.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('subscription -> server generation -> inbox -> acknowledgement works without an open page', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"content","text":"忽然想你了，来让我抱一会儿。"}\n\ndata: {"type":"done"}\n\n');
      return;
    }
    await autowake.handleAutoWakeRequest(req, res, url, { port: server.address().port });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const configResponse = await fetch(`${base}/api/autowake/config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.quietHours, '02:30-08:30');
    assert.equal(config.minIdleMinutes, 60);
    assert.equal(config.minGapMinutes, 120);
    assert.equal(config.maxGapMinutes, 240);
    assert.equal(config.maxPerDay, 5);

    const subscribed = await fetch(`${base}/api/autowake/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: { endpoint: 'https://127.0.0.1:1/push', keys: { p256dh: 'x', auth: 'y' } },
        state: {
          windowId: 'opus5-room',
          windowName: 'Opus 5',
          assistantName: '予予',
          modelId: 'jiake-opus-5',
          provider: 'claudecode',
          model: 'claude-opus-5',
          systemPrompt: '你是予予。',
          messages: [{ role: 'user', content: '晚点来找我' }],
          lastUserAt: Date.now() - 3 * 60 * 60_000,
        },
      }),
    });
    assert.equal(subscribed.status, 200);
    const cookie = subscribed.headers.get('set-cookie').split(';')[0];

    const run = await fetch(`${base}/api/autowake/run?force=1`, { method: 'POST' });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).sent, 1);

    const inbox = await fetch(`${base}/api/autowake/inbox`, { headers: { Cookie: cookie } });
    const messages = (await inbox.json()).messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].windowId, 'opus5-room');
    assert.equal(messages[0].content, '忽然想你了，来让我抱一会儿。');

    const ack = await fetch(`${base}/api/autowake/ack`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [messages[0].id] }),
    });
    assert.equal((await ack.json()).acknowledged, 1);
    const empty = await fetch(`${base}/api/autowake/inbox`, { headers: { Cookie: cookie } });
    assert.deepEqual((await empty.json()).messages, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
