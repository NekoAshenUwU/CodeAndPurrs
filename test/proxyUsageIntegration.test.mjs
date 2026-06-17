import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitForUsageHealth(baseUrl) {
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const response = await fetch(`${baseUrl}/api/usage/health`);
      const body = await response.json();
      if (response.ok && body.service === 'neko-usage-bridge') {
        return body;
      }
      lastError = new Error(`unexpected health response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('proxy usage health endpoint did not become ready');
}

test('main proxy serves integrated /api/usage routes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'neko-proxy-usage-'));
  const port = String(19000 + Math.floor(Math.random() * 1000));
  const server = spawn(process.execPath, ['server/proxy.mjs'], {
    env: {
      ...process.env,
      PORT: port,
      USAGE_BRIDGE_DATA_DIR: dataDir,
      USAGE_BRIDGE_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const body = await waitForUsageHealth(`http://127.0.0.1:${port}`);
    assert.equal(body.ok, true);
    assert.equal(body.tokenConfigured, true);
    assert.equal(body.storage.ok, true);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr, '');
});
