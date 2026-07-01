// 端到端本地验证：起一个临时 bridge → 跑 smoke → 清理。
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = '127.0.0.1';
const port = process.env.BRIDGE_VERIFY_PORT ?? String(18000 + Math.floor(Math.random() * 10000));
const token = process.env.BRIDGE_TOKEN ?? process.env.USAGE_BRIDGE_TOKEN ?? 'verify-token';
const baseUrl = `http://${host}:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), 'neko-usage-bridge-verify-'));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/usage/health`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await wait(150);
  }

  throw new Error(`bridge did not become healthy at ${baseUrl}: ${lastError}`);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`));
    });
  });
}

const server = spawn(process.execPath, ['server/usageBridge.mjs'], {
  env: {
    ...process.env,
    HOST: host,
    BRIDGE_PORT: port,
    USAGE_BRIDGE_TOKEN: token,
    USAGE_BRIDGE_RETENTION_DAYS: '30',
    USAGE_BRIDGE_ALLOWED_ORIGINS: '*',
    USAGE_BRIDGE_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));

try {
  console.log(`Starting local bridge verification on ${baseUrl}`);
  await waitForHealth();
  await runCommand('npm', ['run', 'bridge:smoke'], {
    BRIDGE_BASE_URL: baseUrl,
    BRIDGE_TOKEN: token,
    BRIDGE_OWNER: 'neko-verify',
    BRIDGE_DATE: '2026-06-13',
    BRIDGE_DELETE_AFTER_SMOKE: '1',
  });
  console.log('Bridge verify passed. Local server + smoke flow are healthy.');
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
