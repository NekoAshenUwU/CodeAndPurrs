// CodeAndPurrs → 棠予酿的本机 stdio MCP 桥。
// Claude Code 在 VPS 上直接 spawn 本文件；这里再用 TANG_INTERNAL_KEY 调
// 127.0.0.1:8890 的 internal 白名单接口，所以全程没有浏览器 OAuth/callback。

import readline from 'node:readline';

const BASE = String(process.env.TANG_MCP_BASE_URL || 'http://127.0.0.1:8890').replace(/\/$/, '');
const KEY = String(process.env.TANG_INTERNAL_KEY || '').trim();

const tools = [
  {
    name: 'list_memories',
    description: '读取或搜索棠予酿长期记忆。query 为空时返回最新/最重要的一批；有关键词时只返回标题或正文命中的记录。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的人、事、日期或关键词；留空表示列出记忆。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_memory',
    description: '按记忆 id 读取棠予酿中的单条完整记录。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'hold_memory',
    description: '把一件明确、值得长期保存的新事实或约定写入棠予酿。日常寒暄和临时情绪不要写，已有内容不要重复写。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短标题。' },
        content: { type: 'string', description: '要长期保存的完整内容。' },
        category: { type: 'string', description: '例如约定、喜好、纪念日、近况。' },
        importance: { type: 'integer', minimum: 1, maximum: 10, default: 7 },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'grow_memory',
    description: '更新或加深棠予酿里已有的一条记忆；必须提供已有记忆 id。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        content: { type: 'string', description: '补充或更新后的内容。' },
        importance: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function tang(path, init = {}) {
  if (!KEY) throw new Error('TANG_INTERNAL_KEY is not configured');
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'X-Internal-Key': KEY,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  const raw = await response.text();
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 JSON 错误原样交回模型，不能假装成功。
  }
  if (!response.ok) throw new Error(`棠予酿返回 ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function searchableText(row) {
  return [row?.title, row?.content, row?.category, row?.mood_label, row?.created_at]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase('zh-CN');
}

async function callTool(name, args = {}) {
  if (name === 'list_memories') {
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
    const rows = await tang(`/internal/diary/list?limit=${limit}`);
    if (!Array.isArray(rows)) return textResult(rows);
    const query = String(args.query || '').trim().toLocaleLowerCase('zh-CN');
    const selected = query ? rows.filter((row) => searchableText(row).includes(query)) : rows;
    return textResult(selected);
  }
  if (name === 'read_memory') {
    const id = String(args.id || '').trim();
    if (!id) throw new Error('read_memory requires id');
    return textResult(await tang(`/internal/diary/${encodeURIComponent(id)}`));
  }
  if (name === 'hold_memory') {
    const content = String(args.content || '').trim();
    if (!content) throw new Error('hold_memory requires content');
    const payload = {
      title: String(args.title || args.category || 'CodeAndPurrs 记忆').trim(),
      content,
      category: String(args.category || '其它').trim(),
      importance: Math.max(1, Math.min(10, Number(args.importance) || 7)),
      source: 'codeandpurrs',
    };
    return textResult(await tang('/internal/memory/hold', { method: 'POST', body: JSON.stringify(payload) }));
  }
  if (name === 'grow_memory') {
    const id = String(args.id || '').trim();
    if (!id) throw new Error('grow_memory requires id');
    const payload = { id };
    if (String(args.content || '').trim()) payload.content = String(args.content).trim();
    if (Number.isFinite(Number(args.importance))) {
      payload.importance = Math.max(1, Math.min(10, Number(args.importance)));
    }
    return textResult(await tang('/internal/memory/grow', { method: 'POST', body: JSON.stringify(payload) }));
  }
  throw new Error(`unknown tool: ${name}`);
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: String(error?.message || error) },
  })}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return;
  try {
    if (request.method === 'initialize') {
      reply(request.id, {
        protocolVersion: request.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codeandpurrs-tangyuniang', version: '1.0.0' },
      });
      return;
    }
    if (request.method === 'ping') {
      reply(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      reply(request.id, { tools });
      return;
    }
    if (request.method === 'tools/call') {
      reply(request.id, await callTool(request.params?.name, request.params?.arguments || {}));
      return;
    }
    if (request.id !== undefined) fail(request.id, new Error(`method not found: ${request.method}`));
  } catch (error) {
    if (request.id !== undefined) reply(request.id, textResult(String(error?.message || error), true));
  }
});
