import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleScreenFrameRequest } from '../server/screenFrame.mjs';

const frameBody = {
  schemaVersion: 1,
  deviceId: 'redmi-turbo-4',
  capturedAt: 1_780_000_000_000,
  mimeType: 'image/jpeg',
  data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
};

async function withServer(run, clock = { now: 1_780_000_000_500 }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'codeandpurrs-screen-'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!(await handleScreenFrameRequest(req, res, url, {
      dataDir,
      bridgeToken: 'bridge-secret',
      viewerKey: 'viewer-secret',
      ttlMs: 60_000,
      now: () => clock.now,
    }))) {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, clock);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const ingest = (base, token = 'bridge-secret') => fetch(`${base}/api/screen/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
  body: JSON.stringify(frameBody),
});

test('screen ingest rejects a wrong bridge token', async () => {
  await withServer(async (base) => {
    const response = await ingest(base, 'wrong');
    assert.equal(response.status, 401);
  });
});

test('latest frame is private and returned only with the viewer key', async () => {
  await withServer(async (base) => {
    assert.equal((await ingest(base)).status, 200);
    assert.equal((await fetch(`${base}/api/screen/latest`)).status, 401);
    const response = await fetch(`${base}/api/screen/latest`, {
      headers: { 'X-Chat-Save-Key': 'viewer-secret' },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.deviceId, frameBody.deviceId);
    assert.equal(body.dataUrl, `data:image/jpeg;base64,${frameBody.data}`);
  });
});

test('stale frames expire and stop removes the latest frame', async () => {
  await withServer(async (base, clock) => {
    assert.equal((await ingest(base)).status, 200);
    clock.now += 60_001;
    const stale = await fetch(`${base}/api/screen/latest`, {
      headers: { 'X-Chat-Save-Key': 'viewer-secret' },
    });
    assert.equal(stale.status, 404);
    assert.equal((await stale.json()).stale, true);

    clock.now += 1;
    assert.equal((await ingest(base)).status, 200);
    const stopped = await fetch(`${base}/api/screen/stop`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': 'bridge-secret' },
    });
    assert.equal(stopped.status, 200);
    const empty = await fetch(`${base}/api/screen/latest`, {
      headers: { 'X-Chat-Save-Key': 'viewer-secret' },
    });
    assert.equal(empty.status, 404);
  });
});
