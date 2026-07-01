import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageBridgeServer } from '../server/usageBridgeServer.mjs';

// 契约见 docs/neko-usage-bridge-spec.md §4（schemaVersion 1）。
function createPayload(date, totalForegroundMs = 3600000) {
  return {
    schemaVersion: 1,
    device: { id: 'redmi-test', owner: 'neko', model: 'Redmi Turbo 4', os: 'HyperOS 2 / Android 15' },
    date,
    tz: 'Asia/Kuching',
    generatedAt: `${date}T20:42:00+08:00`,
    summary: {
      totalForegroundMs,
      unlocks: 12,
      firstUseAt: `${date}T08:12:00+08:00`,
      lastUseAt: `${date}T20:30:00+08:00`,
      notifications: 87,
    },
    hourly: Array.from({ length: 24 }, (_, hour) => (hour === 20 ? totalForegroundMs : 0)),
    apps: [
      {
        package: 'com.example.app',
        label: 'Example',
        category: 'social',
        foregroundMs: totalForegroundMs,
        lastUsedAt: `${date}T19:30:00+08:00`,
        iconBase64: null,
      },
    ],
    sessions: [
      { package: 'com.example.app', label: 'Example', category: 'social', startAt: `${date}T19:00:00+08:00`, endAt: `${date}T20:00:00+08:00` },
    ],
  };
}

async function withServer(callback, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'neko-usage-bridge-'));
  const server = createUsageBridgeServer({ dataDir, bridgeToken: 'test-token', ...options });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

const ingest = (baseUrl, payload, token = 'test-token') =>
  fetch(`${baseUrl}/api/usage/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
    body: JSON.stringify(payload),
  });

test('health endpoint reports service and storage status without a token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/usage/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'neko-usage-bridge');
    assert.equal(body.storage.ok, true);
    assert.equal(body.tokenConfigured, true);
  });
});

test('ping requires a valid token then succeeds', async () => {
  await withServer(async (baseUrl) => {
    const bad = await fetch(`${baseUrl}/api/usage/ping`, { method: 'POST', headers: { 'X-Bridge-Token': 'nope' } });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${baseUrl}/api/usage/ping`, { method: 'POST', headers: { 'X-Bridge-Token': 'test-token' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  });
});

test('rejects ingest requests with an invalid bridge token', async () => {
  await withServer(async (baseUrl) => {
    const response = await ingest(baseUrl, createPayload('2026-06-13'), 'wrong-token');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid bridge token');
  });
});

test('stores payloads and exposes latest/day/trend in the {ok,meta,data} wrapper', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-12', 1800000), createPayload('2026-06-13', 3600000)]) {
      const response = await ingest(baseUrl, payload);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).ok, true);
    }

    const latest = await fetch(`${baseUrl}/api/usage/latest?owner=neko`).then((r) => r.json());
    assert.equal(latest.ok, true);
    assert.equal(latest.data.date, '2026-06-13');
    assert.equal(latest.data.summary.totalForegroundMs, 3600000);
    assert.equal(latest.meta.owner, 'neko');
    assert.equal(typeof latest.meta.stale, 'boolean');
    assert.equal(latest.meta.stale, false); // 刚写入，不该 stale
    // sessions[] 原样存回
    assert.equal(Array.isArray(latest.data.sessions), true);
    assert.equal(latest.data.sessions[0].package, 'com.example.app');

    const day = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`).then((r) => r.json());
    assert.equal(day.data.date, '2026-06-12');

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((r) => r.json());
    assert.deepEqual(trend.data.map((item) => item.date), ['2026-06-12', '2026-06-13']);
    assert.equal(trend.data[1].totalForegroundMs, 3600000);
    assert.equal(trend.data[1].unlocks, 12);
  });
});

test('accepts payload addressed via device.owner and stores under that owner', async () => {
  await withServer(async (baseUrl) => {
    const payload = createPayload('2026-06-13');
    payload.device.owner = 'ashen';
    const response = await ingest(baseUrl, payload);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).owner, 'ashen');

    const latest = await fetch(`${baseUrl}/api/usage/latest?owner=ashen`).then((r) => r.json());
    assert.equal(latest.data.date, '2026-06-13');
  });
});

test('deletes a single usage day with the bridge token', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-12', 1800000), createPayload('2026-06-13', 3600000)]) {
      await ingest(baseUrl, payload);
    }

    const deleteResponse = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`, {
      method: 'DELETE',
      headers: { 'X-Bridge-Token': 'test-token' },
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).deleted, true);

    const deletedDay = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`);
    assert.equal(deletedDay.status, 404);
  });
});

test('clears all usage data for an owner with the bridge token', async () => {
  await withServer(async (baseUrl) => {
    await ingest(baseUrl, createPayload('2026-06-13'));

    const deleteResponse = await fetch(`${baseUrl}/api/usage/owner?owner=neko`, {
      method: 'DELETE',
      headers: { 'X-Bridge-Token': 'test-token' },
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).deleted, true);

    const latest = await fetch(`${baseUrl}/api/usage/latest?owner=neko`);
    assert.equal(latest.status, 404);
  });
});

test('prunes usage data before a cutoff date with the bridge token', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-10', 900000), createPayload('2026-06-11', 1800000), createPayload('2026-06-12', 2700000)]) {
      await ingest(baseUrl, payload);
    }

    const pruneResponse = await fetch(`${baseUrl}/api/usage/prune?owner=neko&before=2026-06-12`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': 'test-token' },
    });
    const pruneBody = await pruneResponse.json();
    assert.equal(pruneResponse.status, 200);
    assert.deepEqual(pruneBody.deletedDates, ['2026-06-10', '2026-06-11']);

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((r) => r.json());
    assert.deepEqual(trend.data.map((item) => item.date), ['2026-06-12']);
  });
});

test('auto-prunes old usage data after ingest when retentionDays is set', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-10', 900000), createPayload('2026-06-11', 1800000), createPayload('2026-06-12', 2700000)]) {
      await ingest(baseUrl, payload);
    }

    const ingestResponse = await ingest(baseUrl, createPayload('2026-06-13', 3600000));
    const ingestBody = await ingestResponse.json();
    assert.equal(ingestResponse.status, 201);
    assert.deepEqual(ingestBody.prunedDates, ['2026-06-11']);

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((r) => r.json());
    assert.deepEqual(trend.data.map((item) => item.date), ['2026-06-12', '2026-06-13']);
  }, { retentionDays: 2 });
});

test('validates schemaVersion and hourly shape', async () => {
  await withServer(async (baseUrl) => {
    const response = await ingest(baseUrl, { ...createPayload('2026-06-13'), hourly: [1, 2, 3] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'hourly must be an array of 24 numbers');
  });
});

test('rejects payload missing device.owner', async () => {
  await withServer(async (baseUrl) => {
    const payload = createPayload('2026-06-13');
    delete payload.device;
    const response = await ingest(baseUrl, payload);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'device.owner is required');
  });
});
