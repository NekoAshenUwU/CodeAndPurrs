import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageBridgeServer } from '../server/usageBridgeServer.mjs';

function createPayload(date, totalScreenMs = 3600000) {
  return {
    schemaVersion: 1,
    owner: 'neko',
    device: {
      name: 'Redmi',
      platform: 'android',
      osSkin: 'MIUI/HyperOS',
    },
    date,
    tz: 'Asia/Kuching',
    generatedAt: `${date}T20:42:00+08:00`,
    summary: {
      totalScreenMs,
      unlockCount: 12,
      firstUsedAt: `${date}T08:12:00+08:00`,
      lastUsedAt: `${date}T20:30:00+08:00`,
    },
    apps: [
      {
        packageName: 'com.example.app',
        appName: 'Example',
        foregroundMs: totalScreenMs,
        lastUsedAt: `${date}T19:30:00+08:00`,
      },
    ],
    hourly: Array.from({ length: 24 }, (_, hour) => (hour === 20 ? totalScreenMs : 0)),
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

test('rejects ingest requests with an invalid bridge token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'wrong-token' },
      body: JSON.stringify(createPayload('2026-06-13')),
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid bridge token');
  });
});

test('stores usage payloads and exposes latest, day, and trend reads', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-12', 1800000), createPayload('2026-06-13', 3600000)]) {
      const ingestResponse = await fetch(`${baseUrl}/api/usage/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
        body: JSON.stringify(payload),
      });

      assert.equal(ingestResponse.status, 201);
      assert.equal((await ingestResponse.json()).ok, true);
    }

    const latest = await fetch(`${baseUrl}/api/usage/latest?owner=neko`).then((response) => response.json());
    assert.equal(latest.payload.date, '2026-06-13');
    assert.equal(latest.payload.summary.totalScreenMs, 3600000);

    const day = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`).then((response) => response.json());
    assert.equal(day.payload.date, '2026-06-12');

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((response) => response.json());
    assert.deepEqual(trend.trend.map((item) => item.date), ['2026-06-12', '2026-06-13']);
  });
});



test('deletes a single usage day with the bridge token', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-12', 1800000), createPayload('2026-06-13', 3600000)]) {
      await fetch(`${baseUrl}/api/usage/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
        body: JSON.stringify(payload),
      });
    }

    const deleteResponse = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`, {
      method: 'DELETE',
      headers: { 'X-Bridge-Token': 'test-token' },
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).deleted, true);

    const deletedDay = await fetch(`${baseUrl}/api/usage/day?owner=neko&date=2026-06-12`);
    assert.equal(deletedDay.status, 404);

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((response) => response.json());
    assert.deepEqual(trend.trend.map((item) => item.date), ['2026-06-13']);
  });
});

test('clears all usage data for an owner with the bridge token', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
      body: JSON.stringify(createPayload('2026-06-13')),
    });

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
      await fetch(`${baseUrl}/api/usage/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
        body: JSON.stringify(payload),
      });
    }

    const pruneResponse = await fetch(`${baseUrl}/api/usage/prune?owner=neko&before=2026-06-12`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': 'test-token' },
    });
    const pruneBody = await pruneResponse.json();

    assert.equal(pruneResponse.status, 200);
    assert.deepEqual(pruneBody.deletedDates, ['2026-06-10', '2026-06-11']);

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((response) => response.json());
    assert.deepEqual(trend.trend.map((item) => item.date), ['2026-06-12']);
  });
});

test('auto-prunes old usage data after ingest when retentionDays is set', async () => {
  await withServer(async (baseUrl) => {
    for (const payload of [createPayload('2026-06-10', 900000), createPayload('2026-06-11', 1800000), createPayload('2026-06-12', 2700000)]) {
      await fetch(`${baseUrl}/api/usage/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
        body: JSON.stringify(payload),
      });
    }

    const ingestResponse = await fetch(`${baseUrl}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
      body: JSON.stringify(createPayload('2026-06-13', 3600000)),
    });
    const ingestBody = await ingestResponse.json();

    assert.equal(ingestResponse.status, 201);
    assert.deepEqual(ingestBody.prunedDates, ['2026-06-11']);

    const trend = await fetch(`${baseUrl}/api/usage/trend?owner=neko&days=7`).then((response) => response.json());
    assert.deepEqual(trend.trend.map((item) => item.date), ['2026-06-12', '2026-06-13']);
  }, { retentionDays: 2 });
});

test('validates schemaVersion and hourly shape', async () => {
  await withServer(async (baseUrl) => {
    const payload = { ...createPayload('2026-06-13'), hourly: [1, 2, 3] };
    const response = await fetch(`${baseUrl}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test-token' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'hourly must be an array of 24 numbers');
  });
});
