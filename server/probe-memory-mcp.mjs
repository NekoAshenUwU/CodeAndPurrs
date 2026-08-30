#!/usr/bin/env node
// 探针：只【读】不改。看清楚棠予酿的 MCP over HTTP 到底怎么说话，
// 再决定服务端预取那段代码怎么写——不看清楚就写，写出来的是猜的。
//
// 干三件事，每一步都把原始响应打出来：
//   1) initialize        → 拿 Mcp-Session-Id、看返回是 JSON 还是 SSE
//   2) tools/list        → 确认 memory_reflex 在不在、叫什么名字
//   3) tools/call        → 真调一次 memory_reflex，看返回长什么样
//
// 跑法（在 VPS 上）：
//   cd /var/www/codeandpurrs && node server/probe-memory-mcp.mjs
//
// 用的是 proxy.mjs 同一份 .env 里的 CC_MEMORY_MCP_URL / CC_MEMORY_MCP_TOKEN，
// 不新增任何配置，也不写任何文件。

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  console.log('（没读到 .env，只能靠 shell 里的环境变量）');
}

const URL_ = (process.env.CC_MEMORY_MCP_URL || '').trim();
const TOKEN = (process.env.CC_MEMORY_MCP_TOKEN || '').trim();
const NAME = (process.env.CC_MEMORY_MCP || '').trim();

console.log('CC_MEMORY_MCP      =', NAME || '(空)');
console.log('CC_MEMORY_MCP_URL  =', URL_ || '(空)');
console.log('CC_MEMORY_MCP_TOKEN=', TOKEN ? `(有，${TOKEN.length} 字符)` : '(空)');
if (!URL_) {
  console.error('\n× CC_MEMORY_MCP_URL 是空的，后面没法探。');
  process.exit(1);
}

const headers = () => ({
  'Content-Type': 'application/json',
  // 流式 HTTP 传输要求两个都收，服务端可能回 JSON 也可能回 SSE
  Accept: 'application/json, text/event-stream',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

let sessionId = '';

async function rpc(label, body, notify = false) {
  console.log(`\n===== ${label} =====`);
  const h = headers();
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  let r;
  try {
    r = await fetch(URL_, { method: 'POST', headers: h, body: JSON.stringify(body) });
  } catch (err) {
    console.log('× 连不上：', err?.message || err);
    return null;
  }
  console.log('HTTP', r.status, r.statusText);
  for (const [k, v] of r.headers) {
    if (/^(content-type|mcp-session-id|www-authenticate)$/i.test(k)) console.log(`  ${k}: ${v}`);
  }
  const sid = r.headers.get('mcp-session-id');
  if (sid && !sessionId) {
    sessionId = sid;
    console.log('  → 记下 session id');
  }
  const text = await r.text();
  console.log('--- body（最多 3000 字）---');
  console.log(text.slice(0, 3000));
  if (notify) return null;
  return text;
}

await rpc('1) initialize', {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codeandpurrs-probe', version: '0' },
  },
});

// 有些实现要求收到这条通知之后才肯干活
await rpc('2) notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' }, true);

await rpc('3) tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

await rpc('4) tools/call memory_reflex', {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'memory_reflex', arguments: { text: '今天心情不太好，有点累', brief: true } },
});

console.log('\n完事。上面这些原样贴给我就行——一个字都没改过任何东西。');
