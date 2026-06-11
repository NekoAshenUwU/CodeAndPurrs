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

// ElevenLabs：AI 给你发语音用的好音色
const ELEVEN = {
  key: () => process.env.ELEVENLABS_API_KEY,
  voiceId: () => process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  model: () => process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
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

// ---------- 文字转语音（ElevenLabs，AI 给你发语音）----------
// 返回 { audio: Buffer, contentType }。按需调用，不自动每条都生成（省额度）。
async function speak(text) {
  const key = ELEVEN.key();
  if (!key) {
    // 没配 key：回一段 0.4s 的「哔」声占位，让播放流程能跑通
    return { audio: beepWav(), contentType: 'audio/wav' };
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN.voiceId()}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVEN.model(),
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`发声失败 (${resp.status})：${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await resp.arrayBuffer());
  return { audio, contentType: 'audio/mpeg' };
}

// 生成一段很短的正弦「哔」声 WAV（mock 占位用）
function beepWav(freq = 523, ms = 400, rate = 16000) {
  const n = Math.floor((rate * ms) / 1000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400); // 淡入淡出，别太刺耳
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * fade;
    data.writeInt16LE((v * 32767) | 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
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
  const isSpeak = req.url?.startsWith('/api/speak');
  if (req.method !== 'POST' || (!isChat && !isTranscribe && !isSpeak)) {
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

  // ----- 文字转语音 -----
  if (isSpeak) {
    const text = String(body.text || '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '没有要读的文字' }));
      return;
    }
    try {
      const { audio, contentType } = await speak(text.slice(0, 2000));
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': audio.length });
      res.end(audio);
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
