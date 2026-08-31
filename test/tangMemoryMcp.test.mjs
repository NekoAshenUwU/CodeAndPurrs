import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function rpcClient(child) {
  let buffer = '';
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  return (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 3000);
      waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

test('local stdio bridge lists, reads and writes through Tang internal endpoints', async (t) => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, key: req.headers['x-internal-key'], body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/internal/diary/list')) {
      res.end(JSON.stringify([{ id: 'm1', title: '草莓', content: '老婆喜欢草莓奶' }]));
      return;
    }
    if (req.url === '/internal/diary/m1') {
      res.end(JSON.stringify({ id: 'm1', title: '草莓', content: '老婆喜欢草莓奶' }));
      return;
    }
    if (req.url === '/internal/memory/hold') {
      res.end(JSON.stringify({ ok: true, id: 'm2' }));
      return;
    }
    if (req.url === '/internal/memory/grow') {
      res.end(JSON.stringify({ ok: true, id: 'm1' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;

  const child = spawn(process.execPath, ['server/tangMemoryMcp.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TANG_INTERNAL_KEY: 'test-key', TANG_MCP_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const rpc = rpcClient(child);

  const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(initialized.result.serverInfo.name, 'codeandpurrs-tangyuniang');
  const listed = await rpc(2, 'tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'list_memories', 'read_memory', 'hold_memory', 'grow_memory',
  ]);
  const searched = await rpc(3, 'tools/call', { name: 'list_memories', arguments: { query: '草莓' } });
  assert.match(searched.result.content[0].text, /草莓奶/);
  const read = await rpc(4, 'tools/call', { name: 'read_memory', arguments: { id: 'm1' } });
  assert.match(read.result.content[0].text, /老婆喜欢草莓奶/);
  const held = await rpc(5, 'tools/call', {
    name: 'hold_memory',
    arguments: { title: '约定', content: '周末一起看电影', category: '约定', importance: 8 },
  });
  assert.match(held.result.content[0].text, /"ok": true/);
  const grown = await rpc(6, 'tools/call', {
    name: 'grow_memory', arguments: { id: 'm1', content: '更喜欢冰的草莓奶' },
  });
  assert.match(grown.result.content[0].text, /"ok": true/);

  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.key === 'test-key'));
  assert.equal(calls[2].method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].body), {
    title: '约定', content: '周末一起看电影', category: '约定', importance: 8, source: 'codeandpurrs',
  });
});
