// 呼噜频道的小后端代理 —— 把 API key 藏在服务端，前端只跟这里说话。
// 零依赖：只用 Node 自带的 http + 全局 fetch（Node 18+）。
//
// 启动：node --env-file=.env server/proxy.mjs   （或 npm run dev:server）
// 没配 key 也能跑：自动进入 mock 模式，回一段假的流式消息，方便先调 UI。

import http from 'node:http';

// 尝试读 .env（Node 20.12+ 自带），没有就算了，用已有的环境变量。
try {
  process.loadEnvFile?.();
} catch {
  // 没有 .env 文件，忽略
}

const PORT = Number(process.env.PORT) || 8787;

const PROVIDERS = {
  deepseek: {
    key: () => process.env.DEEPSEEK_API_KEY,
    url: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
  },
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    // url 按 model 拼，见下方 callGemini
    defaultModel: 'gemini-2.5-flash',
  },
};

// ---------- 小工具 ----------
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // 语音转写会带 base64 音频，放宽到 ~20MB
      if (raw.length > 20_000_000) reject(new Error('请求体太大了'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 把上游的 SSE 字节流按 "data: ..." 一行行抠出来，回调每个 JSON 数据块。
async function pumpSSE(upstreamBody, onData) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onData(JSON.parse(payload));
      } catch {
        // 不是完整 JSON 就跳过（极少见的分片）
      }
    }
  }
}

// ---------- DeepSeek（OpenAI 兼容）----------
async function callDeepSeek({ res, key, model, messages }) {
  const upstream = await fetch(PROVIDERS.deepseek.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || PROVIDERS.deepseek.defaultModel,
      messages,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `DeepSeek 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    // deepseek-reasoner 会给思考链
    if (delta.reasoning_content) send(res, { type: 'reasoning', text: delta.reasoning_content });
    if (delta.content) send(res, { type: 'content', text: delta.content });
  });
}

// ---------- Gemini ----------
async function callGemini({ res, key, model, messages }) {
  const useModel = model || PROVIDERS.gemini.defaultModel;
  // 把 OpenAI 风格的 messages 转成 Gemini 的 contents；system 单独拎出来。
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:streamGenerateContent?alt=sse&key=${key}`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `Gemini 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (typeof part.text !== 'string') continue;
      // Gemini 的「思考」部分会带 thought:true
      send(res, { type: part.thought ? 'reasoning' : 'content', text: part.text });
    }
  });
}

// ---------- 语音转文字（复用 Gemini 听音频）----------
async function transcribe({ audioBase64, mimeType }) {
  const key = PROVIDERS.gemini.key();
  if (!key) {
    // 没配 Gemini key：返回一段提示，让前端流程能跑通
    return '（mock 转写）配上 GEMINI_API_KEY 我就能听懂你的语音啦～';
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.defaultModel}:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType || 'audio/webm', data: audioBase64 } },
            { text: '请把这段语音逐字转成文字，只输出文字本身，不要加任何解释或标点说明。' },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`转写失败 (${resp.status})：${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text).filter(Boolean).join('').trim();
}

// ---------- Mock（没配 key 时）----------
async function callMock({ res, provider, messages }) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const reasoning =
    `（mock 模式）还没配 ${provider} 的 API key，所以这条是假的。\n` +
    `我先假装在想：用户说了「${last.slice(0, 40)}」，该怎么温柔地回。`;
  const reply =
    `喵～这是 mock 回复呢。把 ${provider.toUpperCase()}_API_KEY 写进 .env 再重启后端，` +
    `我就会说真话啦。你刚才说的是：「${last.slice(0, 60)}」。`;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const ch of reasoning) {
    send(res, { type: 'reasoning', text: ch });
    await wait(8);
  }
  for (const ch of reply) {
    send(res, { type: 'content', text: ch });
    await wait(14);
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const isChat = req.url?.startsWith('/api/chat');
  const isTranscribe = req.url?.startsWith('/api/transcribe');
  if (req.method !== 'POST' || (!isChat && !isTranscribe)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
    return;
  }

  // ----- 语音转文字 -----
  if (isTranscribe) {
    try {
      const text = await transcribe({ audioBase64: body.audioBase64, mimeType: body.mimeType });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // ----- 聊天 -----
  const provider = body.provider === 'gemini' ? 'gemini' : 'deepseek';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === 'string' ? body.model : undefined;
  const key = PROVIDERS[provider].key();

  startSSE(res);
  try {
    if (!key) {
      await callMock({ res, provider, messages });
    } else if (provider === 'gemini') {
      await callGemini({ res, key, model, messages });
    } else {
      await callDeepSeek({ res, key, model, messages });
    }
    send(res, { type: 'done' });
  } catch (err) {
    send(res, { type: 'error', message: String(err?.message || err) });
  } finally {
    res.end();
  }
});

server.listen(PORT, () => {
  const keys = Object.entries(PROVIDERS)
    .map(([name, p]) => `${name}:${p.key() ? '已配置' : 'mock'}`)
    .join('  ');
  console.log(`🐾 呼噜代理已启动 http://localhost:${PORT}  [${keys}]`);
});
