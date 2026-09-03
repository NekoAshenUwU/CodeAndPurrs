import assert from 'node:assert/strict';
import { createPublicKey, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { handleScreenFrameRequest } from '../server/screenFrame.mjs';

const temp = mkdtempSync(join(tmpdir(), 'codeandpurrs-autowake-test-'));
process.env.AUTOWAKE_DATA_DIR = temp;
process.env.SCREEN_FRAME_DATA_DIR = join(temp, 'screen');
process.env.AUTOWAKE_MCP_INTERNAL_KEY = 'mcp-internal-secret';
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

test('weekday work hours, sleep hours and idle guards are enforced', () => {
  const sixPMMalaysia = Date.parse('2026-08-31T10:00:00.000Z');
  const client = {
    enabled: true,
    subscription: { endpoint: 'https://example.invalid/push' },
    state: { windowId: 'room', lastUserAt: sixPMMalaysia - 2 * 60 * 60_000 },
    nextWakeAt: sixPMMalaysia - 1,
    wakeDate: '2026-08-31',
    wakeCount: 0,
  };
  assert.equal(autowake.eligibility(client, sixPMMalaysia).ok, true);
  assert.equal(
    autowake.eligibility({ ...client, state: { ...client.state, lastUserAt: sixPMMalaysia - 15 * 60_000 } }, sixPMMalaysia).reason,
    'recent-chat',
  );
  const noonMondayMalaysia = Date.parse('2026-08-31T04:00:00.000Z');
  assert.equal(autowake.eligibility(client, noonMondayMalaysia).reason, 'schedule-blocked');
  const threeAMMalaysia = Date.parse('2026-08-30T19:00:00.000Z');
  assert.equal(autowake.eligibility({ ...client, state: { ...client.state, lastUserAt: threeAMMalaysia - 4 * 60 * 60_000 } }, threeAMMalaysia).reason, 'schedule-blocked');
  const noonSaturdayMalaysia = Date.parse('2026-08-29T04:00:00.000Z');
  assert.equal(autowake.isWakeWindow({ weekday: 'Sat', time: '12:00' }), true);
  assert.equal(autowake.eligibility({
    ...client,
    state: { ...client.state, lastUserAt: noonSaturdayMalaysia - 2 * 60 * 60_000 },
    nextWakeAt: noonSaturdayMalaysia - 1,
  }, noonSaturdayMalaysia).ok, true);
});

test('old 4-7 hour schedules are clamped to the livelier policy', () => {
  const lastUserAt = Date.parse('2026-08-31T04:00:00.000Z');
  const afterChat = {
    state: { lastUserAt },
    lastWakeAt: 0,
    nextWakeAt: lastUserAt + 7 * 60 * 60_000,
  };
  autowake.clampLegacyWakeSchedule(afterChat);
  assert.equal(afterChat.nextWakeAt, lastUserAt + 60 * 60_000);

  const afterWake = {
    state: { lastUserAt: lastUserAt - 60_000 },
    lastWakeAt: lastUserAt,
    nextWakeAt: lastUserAt + 7 * 60 * 60_000,
  };
  autowake.clampLegacyWakeSchedule(afterWake);
  assert.equal(afterWake.nextWakeAt, lastUserAt + 75 * 60_000);
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
  let chatRequestBody = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/chat') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      chatRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"content","text":"忽然想你了，来让我抱一会儿。"}\n\ndata: {"type":"done"}\n\n');
      return;
    }
    if (url.pathname.startsWith('/api/screen/')) {
      await handleScreenFrameRequest(req, res, url, {
        dataDir: process.env.SCREEN_FRAME_DATA_DIR,
        bridgeToken: 'bridge-secret',
        viewerKey: 'viewer-secret',
      });
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
    assert.deepEqual(config.wakeWindows, { weekdays: '17:00-23:00', weekends: '09:00-23:00' });
    assert.equal(config.minIdleMinutes, 30);
    assert.equal(config.maxIdleMinutes, 60);
    assert.equal(config.minGapMinutes, 45);
    assert.equal(config.maxGapMinutes, 75);
    assert.equal(config.maxPerDay, 10);
    assert.deepEqual(config.screenStory, { enabled: true, windowSeconds: 60, maxFrames: 4 });

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

    const deniedMcp = await fetch(`${base}/api/autowake/mcp/status`);
    assert.equal(deniedMcp.status, 401);
    const mcpHeaders = { 'X-Autowake-MCP-Key': 'mcp-internal-secret' };
    const mcpStatus = await fetch(`${base}/api/autowake/mcp/status`, { headers: mcpHeaders });
    const mcpStatusBody = await mcpStatus.json();
    assert.equal(mcpStatus.status, 200);
    assert.equal(mcpStatusBody.devices.length, 1);
    assert.equal(mcpStatusBody.devices[0].windowId, 'opus5-room');
    assert.equal(mcpStatusBody.devices[0].device.length, 12);

    const dryRun = await fetch(`${base}/api/autowake/mcp/run`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const dryRunBody = await dryRun.json();
    assert.equal(dryRun.status, 200);
    assert.equal(dryRunBody.checked, 1);
    assert.equal(dryRunBody.sent, 0);

    for (let index = 1; index <= 5; index++) {
      const capturedAt = Date.now() - (5 - index) * 5_000;
      const frameResponse = await fetch(`${base}/api/screen/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'bridge-secret' },
        body: JSON.stringify({
          schemaVersion: 1,
          deviceId: 'android-neko',
          sceneVersion: index,
          capturedAt,
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, index, 0xd9]).toString('base64'),
        }),
      });
      assert.equal(frameResponse.status, 200);
    }

    const mcpScreen = await fetch(`${base}/api/autowake/mcp/screen?seconds=60&maxFrames=4`, {
      headers: mcpHeaders,
    });
    const mcpScreenBody = await mcpScreen.json();
    assert.equal(mcpScreen.status, 200);
    assert.equal(mcpScreenBody.captured, 4);
    assert.ok(mcpScreenBody.frames.every((frame) => frame.dataUrl.startsWith('data:image/jpeg;base64,')));

    const run = await fetch(`${base}/api/autowake/run?force=1`, { method: 'POST' });
    assert.equal(run.status, 200);
    const runBody = await run.json();
    assert.equal(runBody.sent, 1);
    assert.equal(runBody.results[0].screenFrameCount, 4);
    const wakeContent = chatRequestBody.messages.at(-1).content;
    assert.equal(wakeContent.filter((part) => part.type === 'image_url').length, 4);
    assert.match(wakeContent[1].text, /屏幕轨迹 1\/4/);

    const inbox = await fetch(`${base}/api/autowake/inbox`, { headers: { Cookie: cookie } });
    const messages = (await inbox.json()).messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].windowId, 'opus5-room');
    assert.equal(messages[0].content, '忽然想你了，来让我抱一会儿。');
    assert.equal(messages[0].screenFrameCount, 4);

    const deliveries = await fetch(`${base}/api/autowake/mcp/deliveries?limit=5`, { headers: mcpHeaders });
    const deliveriesBody = await deliveries.json();
    assert.equal(deliveries.status, 200);
    assert.equal(deliveriesBody.messages.length, 1);
    assert.equal(deliveriesBody.messages[0].deviceId, undefined);
    assert.equal(deliveriesBody.messages[0].content, '忽然想你了，来让我抱一会儿。');

    const ack = await fetch(`${base}/api/autowake/ack`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [messages[0].id] }),
    });
    assert.equal((await ack.json()).acknowledged, 1);
    const empty = await fetch(`${base}/api/autowake/inbox`, { headers: { Cookie: cookie } });
    assert.deepEqual((await empty.json()).messages, []);

    const disabled = await fetch(`${base}/api/autowake/mcp/enabled`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).enabled, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
