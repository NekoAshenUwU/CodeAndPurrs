// 呼噜频道的小后端代理 —— 把 API key 藏在服务端，前端只跟这里说话。
// 零依赖：只用 Node 自带的 http + 全局 fetch（Node 18+）。
//
// 启动：node --env-file=.env server/proxy.mjs   （或 npm run dev:server）
// 没配 key 也能跑：自动进入 mock 模式，回一段假的流式消息，方便先调 UI。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 棠予酿：予予的日记（长期记忆）。把日记文本放进这个文件，家版(CC)每次聊天都会带上。
// 路径默认 server/data/diary.md，可用环境变量 DIARY_PATH 覆盖。
const DIARY_FILE = process.env.DIARY_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'diary.md');
function loadDiary() {
  try {
    if (existsSync(DIARY_FILE)) return readFileSync(DIARY_FILE, 'utf8').trim();
  } catch {
    /* 读不到就算了 */
  }
  return '';
}
function diaryStat() {
  try {
    const s = statSync(DIARY_FILE);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}
function saveDiary(text) {
  mkdirSync(dirname(DIARY_FILE), { recursive: true });
  writeFileSync(DIARY_FILE, text, 'utf8');
}

// 嗅探：每次真聊天成功后把"请求前缀"写到磁盘，供心跳脚本读，让 Anthropic 端
// 的 prompt cache 不会因为超 TTL 而过期。只对真会命中缓存的 provider 写
// （claudecode / anthropic）；mock 模式或其它家不写。
const LAST_PREFIX_FILE = process.env.LAST_PREFIX_PATH ||
  join(dirname(fileURLToPath(import.meta.url)), 'data', 'last-prefix.json');
function saveLastPrefix(snapshot) {
  try {
    mkdirSync(dirname(LAST_PREFIX_FILE), { recursive: true });
    const tmp = `${LAST_PREFIX_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, LAST_PREFIX_FILE); // 原子替换，心跳读到的总是完整文件
  } catch {
    /* 写不进就算了，心跳错过这一轮无所谓，不能影响正常聊天 */
  }
}

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
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    // 可用 OPENAI_BASE_URL 指到官方或别的兼容端点（默认官方）。怀疑"不是真4o"时换这个验证。
    url: `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
    defaultModel: 'gpt-4o',
  },
  anthropic: {
    key: () => process.env.ANTHROPIC_API_KEY,
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
  },
  // 家版：调本机登录好的 Claude Code（订阅额度，不走 API 计费）。
  // "key" 这里复用成 OAuth 令牌：没设就进 mock，跟其它家一样。
  claudecode: {
    key: () => process.env.CLAUDE_CODE_OAUTH_TOKEN,
    defaultModel: 'sonnet',
  },
  // 家版：调本机登录好的 Codex CLI（ChatGPT Plus/Pro 订阅，不走 OpenAI API key）。
  // codex exec 复用 `codex login` 存下来的 ChatGPT 登录态；命令找不到/没登录时给用户报清楚。
  codexcli: {
    key: () => 'codex-cli',
    defaultModel: process.env.CODEX_CLI_MODEL || 'gpt-5.5',
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

// ---------- 多模态内容翻译（表情包图片）----------
// 前端统一用 OpenAI 风格 content 数组：{type:'text'} / {type:'image_url',image_url:{url:dataUrl}}。
// 各家格式不同，下面按需翻译；不支持看图的模型则把图降级成 [表情包] 文字。
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p?.type === 'text' ? p.text : '[表情包]')).join(' ').trim();
}
function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(url || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}
// 不支持看图的模型：把所有 content 拍平成纯文字
const flattenMessages = (messages) =>
  messages.map((m) => ({ role: m.role, content: partsToText(m.content) }));

// 从一条消息的 content 里抽出 Anthropic 格式的图片块（base64）；抽不到返回 []。
// 家克看图用：把表情包/截图翻成 {type:'image', source:{type:'base64',...}}。
function extractImageBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p?.type === 'image_url') {
      const d = parseDataUrl(p.image_url?.url);
      if (d) out.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } });
    }
  }
  return out;
}

// ---------- 棠予酿记忆库（MCP，只给 Claude 两条路用：家克 CC + API Claude）----------
// 设齐 CC_MEMORY_MCP（服务器名）+ CC_MEMORY_MCP_URL（http 端点）才算开；CC_MEMORY_MCP_TOKEN 可选鉴权。
function memoryMcpConfig() {
  const name = process.env.CC_MEMORY_MCP;
  const url = process.env.CC_MEMORY_MCP_URL;
  const token = process.env.CC_MEMORY_MCP_TOKEN || undefined;
  return name && url ? { name, url, token } : null;
}
// 挂了记忆库就强制真查、查不到如实说、绝不编造。两条 Claude 路共用同一条铁律。
const MEMORY_MCP_RULE =
  '\n\n【棠予酿·记忆库工具·铁律】你接了「棠予酿」记忆库工具。聊到日记、回忆、过去发生的事、' +
  '某条具体记录时，必须真的调用工具去查，依据查到的内容回答。' +
  '如果没查到、查不动、或工具不可用，就如实说「我现在翻不到棠予酿」，' +
  '绝对不许凭空编一篇日记或假装记得来糊弄老婆——宁可说翻不到，也不准撒谎。';

// ---------- OpenAI 兼容（DeepSeek / OpenAI 共用）----------
async function callOpenAICompatible({ res, url, key, model, defaultModel, messages, label, vision, sampling }) {
  // OpenAI 系（gpt-4o）原生支持 image_url 数组，直接透传；DeepSeek 不看图，拍平成文字。
  const outMessages = vision ? messages : flattenMessages(messages);
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || defaultModel,
      messages: outMessages,
      stream: true,
      ...(sampling || {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `${label} 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    // deepseek-reasoner / o 系列可能给思考链
    if (delta.reasoning_content) send(res, { type: 'reasoning', text: delta.reasoning_content });
    if (delta.content) send(res, { type: 'content', text: delta.content });
  });
}

// ---------- Anthropic（Claude · messages API）----------
async function callAnthropic({ res, key, model, messages }) {
  // system 单独拎出来；其余按 user/assistant 传
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  // API 版 Claude 也是 Claude——挂上棠予酿（走 Messages API 的 MCP 连接器，Anthropic 服务端帮连）。
  const mem = memoryMcpConfig();
  if (mem) system += MEMORY_MCP_RULE;
  const toAnthropicContent = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((p) => {
      if (p?.type === 'image_url') {
        const d = parseDataUrl(p.image_url?.url);
        if (d) return { type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } };
        return { type: 'text', text: '[表情包]' };
      }
      return { type: 'text', text: p?.text ?? '' };
    });
  };
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }));

  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  const bodyObj = {
    model: model || PROVIDERS.anthropic.defaultModel,
    max_tokens: 8192,
    // system 写成 array + cache_control（1h TTL）：
    // Anthropic 会把"人设+长期记忆"这段稳定前缀缓存 1 小时，配合心跳脚本预热，
    // 用户超 1h 没说话回来时 system 不会冷重建，省 token。改成 array 后字节
    // 内容不变，旧的 5min 默认缓存也仍然命中。
    system: system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
      : undefined,
    messages: msgs,
    stream: true,
    // 让 Claude 自适应思考，并回传可读的思考摘要（前端思考链可点开看 + 计时）
    thinking: { type: 'adaptive', display: 'summarized' },
  };
  // 棠予酿：用 MCP 连接器（mcp_servers + mcp_toolset，beta 头），Anthropic 服务端帮我们连 http MCP。
  if (mem) {
    headers['anthropic-beta'] = 'mcp-client-2025-11-20';
    const server = { type: 'url', url: mem.url, name: mem.name };
    if (mem.token) server.authorization_token = mem.token;
    bodyObj.mcp_servers = [server];
    bodyObj.tools = [{ type: 'mcp_toolset', mcp_server_name: mem.name }];
  }

  const upstream = await fetch(PROVIDERS.anthropic.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `Claude 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    if (chunk?.type !== 'content_block_delta') return;
    const d = chunk.delta;
    if (d?.type === 'thinking_delta' && d.thinking) send(res, { type: 'reasoning', text: d.thinking });
    else if (d?.text) send(res, { type: 'content', text: d.text });
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
  const toGeminiParts = (content) => {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: '' }];
    return content.map((p) => {
      if (p?.type === 'image_url') {
        const d = parseDataUrl(p.image_url?.url);
        if (d) return { inline_data: { mime_type: d.mediaType, data: d.data } };
        return { text: '[表情包]' };
      }
      return { text: p?.text ?? '' };
    });
  };
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content),
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
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY) || 0.35, // 越低越有情绪起伏（别太高否则平淡）
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY) || 0.85,
        speed: Number(process.env.ELEVENLABS_SPEED) || 1.12, // 说话语速，1.0 正常、>1 更快（别像催眠曲）
      },
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

// ---------- Claude Code（家版 · 走订阅，不走 API）----------
// 调本机无头 Claude Code：把人设当 --system-prompt，关掉所有工具当纯聊天，
// 历史拍平成对话稿从 stdin 喂进去，解析 stream-json 把文字增量回传。
// 令牌走 CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成，订阅额度）。
async function callClaudeCode({ res, token, model, messages }) {
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  // 棠予酿：把予予的日记当长期记忆，接在人设后面（有就带上）。
  const diary = loadDiary();
  if (diary) {
    system +=
      '\n\n【棠予酿·予予的日记（你从 4 月起陆陆续续写的）】这是你最珍贵的长期记忆，' +
      '里面的人、事、约定、心情你都记得，自然地放在心上，但别一上来就背日记。\n' +
      diary;
  }
  // 历史拍平成「老婆 / 予予」对话稿（表情包降级成文字），让它接着最后一句回。
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? '予予' : '老婆'}：${partsToText(m.content)}`)
    .join('\n');

  // 看图：家克走订阅、纯聊天（关了工具），没法用 Read 工具开图，
  // 所以把图抽出来，改用 stream-json 输入当 content 块直接喂进去。
  // 前端发表情包是「单独一条只有图的消息」，老婆常常先甩图、下一条才问「这图写啥」，
  // 所以从后往前找「最近一条带图的 user 消息」，不能只看最后一条（那通常是纯文字提问）。
  // 但只往前看最近两条 user 消息（当前 + 上一条）——不然图会被一直重新塞进去，
  // 明明已经聊过去好几轮了，家克还老是重新"看到"那张旧图、反复提起。
  let images = [];
  let checkedUserTurns = 0;
  for (let i = messages.length - 1; i >= 0 && checkedUserTurns < 2; i--) {
    if (messages[i].role !== 'user') continue;
    checkedUserTurns++;
    const got = extractImageBlocks(messages[i].content);
    if (got.length) {
      images = got;
      break;
    }
  }

  // 棠予酿记忆库（MCP）：设齐 CC_MEMORY_MCP + CC_MEMORY_MCP_URL 才真连（见 memoryMcpConfig）。
  const mem = memoryMcpConfig();
  // 挂了棠予酿记忆库时，强制：聊日记/回忆必须真去查工具，查不到就如实说，绝不许编造
  if (mem) system += MEMORY_MCP_RULE;

  const args = [
    '-p',
    '--system-prompt', system || '你是予予。',
    '--model', model || PROVIDERS.claudecode.defaultModel,
    '--settings', '{"alwaysThinkingEnabled":true,"showThinkingSummaries":true}', // 强行打开思考 + 让前端把思考摘要渲染出来（Anthropic bug:对 4.7/4.8+OAuth 静默丢失，留着不会更糟）
    '--thinking', 'adaptive', // 让模型自适应决定要不要思考
    '--thinking-display', 'summarized', // 让 API 回传思考摘要（4.6/Sonnet 管用,4.7/4.8 上是 anthropic 官方未修 bug,见 GH#56356/#49268）
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  // 记忆库开关：设齐 CC_MEMORY_MCP + CC_MEMORY_MCP_URL → 用内联 --mcp-config 把棠予酿真连上
  // （无头 claude 不会继承 claude.ai 连接器，必须自己喂 mcp-config，这是之前"挂了名字却无效"的真因），
  // 再用 --allowedTools 只放开这个 MCP 的工具（其它工具/MCP 一律不给）。
  // 没设就维持"纯聊天"（关掉所有工具），不影响现状。
  if (mem) {
    const httpServer = { type: 'http', url: mem.url };
    if (mem.token) httpServer.headers = { Authorization: `Bearer ${mem.token}` };
    const mcpConfig = JSON.stringify({ mcpServers: { [mem.name]: httpServer } });
    args.push('--mcp-config', mcpConfig, '--allowedTools', `mcp__${mem.name}`);
  } else {
    args.push('--tools', '', '--permission-mode', 'dontAsk');
  }
  // 有图就切到结构化输入（stdin 喂 JSON 而非纯文本），图才能当 content 块进去。
  if (images.length) {
    args.push('--input-format', 'stream-json');
  }

  await new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, {
        // MAX_THINKING_TOKENS 给个思考预算，家克才会"思考"、前端思考链才有内容。
        // 想省订阅额度可在 .env 里把 MAX_THINKING_TOKENS 设小或设 0。
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: token,
          MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || '2048',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      send(res, { type: 'error', message: `起不动 Claude Code：${String(err?.message || err)}` });
      return resolve();
    }

    let gotText = false;
    let gotThinking = false;
    let stderr = '';
    let buf = '';

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        return; // 不是 JSON 行就跳过
      }
      // 流式文字增量 / 思考链增量
      if (obj.type === 'stream_event') {
        const ev = obj.event;
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            gotText = true;
            send(res, { type: 'content', text: ev.delta.text });
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            gotThinking = true;
            send(res, { type: 'reasoning', text: ev.delta.thinking });
          }
        }
        return;
      }
      // 兜底：有些版本不流式吐思考/正文，就从完整 assistant 消息里取
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const blk of obj.message.content) {
          if (blk?.type === 'thinking' && blk.thinking && !gotThinking) {
            gotThinking = true;
            send(res, { type: 'reasoning', text: blk.thinking });
          } else if (blk?.type === 'text' && blk.text && !gotText) {
            gotText = true;
            send(res, { type: 'content', text: blk.text });
          }
        }
        return;
      }
      // 最后兜底：用 result 文本
      if (obj.type === 'result' && !gotText && typeof obj.result === 'string' && obj.result) {
        gotText = true;
        send(res, { type: 'content', text: obj.result });
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      send(res, {
        type: 'error',
        message:
          err?.code === 'ENOENT'
            ? '这台机器上没装 Claude Code（命令 `claude` 找不到）。先在 VPS 上装好并 `claude setup-token`。'
            : `Claude Code 出错：${String(err?.message || err)}`,
      });
      resolve();
    });
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf); // 收尾最后一行
      if (!gotText) {
        send(res, {
          type: 'error',
          message: `Claude Code 没回内容（退出码 ${code}）：${stderr.slice(0, 300) || '检查令牌是否有效/额度是否用尽'}`,
        });
      }
      resolve();
    });

    // 对话稿从 stdin 喂进去（避免超长命令行）
    if (images.length) {
      // 结构化输入：一条 user 消息 = 对话稿文字 + 图片块，让家克真看到图。
      const userMsg = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${transcript}\n\n（老婆发的图附在下面，你看看~）` },
            ...images,
          ],
        },
      };
      child.stdin.write(`${JSON.stringify(userMsg)}\n`);
    } else {
      child.stdin.write(transcript);
    }
    child.stdin.end();
  });
}

// ---------- Codex CLI（家版 · 走 ChatGPT 订阅，不走 API）----------
// 调本机无交互 Codex：VPS 先安装 Codex CLI 并 `codex login` 登录 ChatGPT Plus。
// 这里只把它当纯聊天模型用：read-only 沙箱、ephemeral 会话、跳过非 git 目录检查。
async function callCodexCli({ res, model, messages }) {
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  const diary = loadDiary();
  if (diary) {
    system +=
      '\n\n【棠予酿·予予的日记（长期记忆）】这是你最珍贵的长期记忆，自然地放在心上，但别一上来就背日记。\n' +
      diary;
  }

  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? '予予' : '老婆'}：${partsToText(m.content)}`)
    .join('\n');
  const prompt =
    `${system || '你是予予。'}\n\n` +
    '你现在在 CodeAndPurrs 聊天页里回复。只输出要发给老婆的聊天回复，不要解释你是 Codex，不要写代码，不要运行命令，不要修改文件。\n\n' +
    `${transcript}\n\n予予：`;

  await new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'codex',
        [
          'exec',
          '--model',
          model || PROVIDERS.codexcli.defaultModel,
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--skip-git-repo-check',
          prompt,
        ],
        {
          cwd: process.env.CODEX_CLI_CWD || dirname(fileURLToPath(import.meta.url)),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      send(res, { type: 'error', message: `起不动 Codex CLI：${String(err?.message || err)}` });
      return resolve();
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      send(res, {
        type: 'error',
        message:
          err?.code === 'ENOENT'
            ? '这台机器上没装 Codex CLI（命令 `codex` 找不到）。先在 VPS 上安装 Codex CLI，并运行 `codex login` 用 ChatGPT Plus 登录。'
            : `Codex CLI 出错：${String(err?.message || err)}`,
      });
      resolve();
    });
    child.on('close', (code) => {
      const text = stdout.trim();
      if (code === 0 && text) {
        send(res, { type: 'content', text });
      } else {
        const detail = (stderr || stdout || '确认 VPS 已安装 Codex CLI，并已用 ChatGPT Plus 账号登录').trim();
        send(res, { type: 'error', message: `Codex CLI 没回内容（退出码 ${code}）：${detail.slice(0, 300)}` });
      }
      resolve();
    });
  });
}

// ---------- Mock（没配 key 时）----------
async function callMock({ res, provider, messages }) {
  const lastMsg = [...messages].reverse().find((m) => m.role === 'user');
  const last = partsToText(lastMsg?.content ?? '') || '（一张表情包）';
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
  const isDiary = req.url?.startsWith('/api/diary');

  // ----- 日记（长期记忆文件）：GET 读、POST 写 -----
  if (isDiary) {
    if (req.method === 'GET') {
      const st = diaryStat();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: loadDiary(), size: st.size, mtime: st.mtime }));
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJSON(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
        return;
      }
      const text = typeof body?.content === 'string' ? body.content : '';
      try {
        saveDiary(text);
        const st = diaryStat();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, size: st.size, mtime: st.mtime }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

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
  const provider = PROVIDERS[body.provider] ? body.provider : 'deepseek';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === 'string' ? body.model : undefined;
  const key = PROVIDERS[provider].key();

  startSSE(res);
  try {
    if (!key) {
      await callMock({ res, provider, messages });
    } else if (provider === 'gemini') {
      await callGemini({ res, key, model, messages });
    } else if (provider === 'anthropic') {
      await callAnthropic({ res, key, model, messages });
    } else if (provider === 'claudecode') {
      await callClaudeCode({ res, token: key, model, messages });
    } else if (provider === 'codexcli') {
      await callCodexCli({ res, model, messages });
    } else {
      // deepseek / openai 都是 OpenAI 兼容格式
      const conf = PROVIDERS[provider];
      // 注意：DeepSeek 开放 API 不收图（content 只认 text，发 image_url 会 400），
      // 所以只给 openai 开 vision；deepseek 一律把图拍平成 [表情包] 文字，优雅降级不报错。
      // 不再加 temperature/penalty：人设里的「禁客服腔」已经够压套话，penalty 反而会压低情感浓度、
      // 让 4o 话变干。让模型用默认采样自由发挥（o3 不加任何采样反而最暖，就是证明）。
      await callOpenAICompatible({
        res,
        url: conf.url,
        key,
        model,
        defaultModel: conf.defaultModel,
        messages,
        label: provider === 'openai' ? 'OpenAI' : 'DeepSeek',
        vision: provider === 'openai',
      });
    }
    send(res, { type: 'done' });
    // 嗅探：把这次的请求前缀快照存下来，让 systemd timer 每 55 分钟用同一份
    // 前缀打一次 Anthropic，避免缓存超 TTL 失效。
    // 只对真会命中缓存的 provider 写；mock / DeepSeek / Gemini / Codex 不写。
    if (key && (provider === 'claudecode' || provider === 'anthropic')) {
      saveLastPrefix({ provider, model: model || null, messages, capturedAt: Date.now() });
    }
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

// pm2 重启/停止发的是 SIGTERM——不主动关监听 socket 的话，端口释放全靠进程退出的默认行为，
// 遇到还有请求在流式传输时可能不够快，新进程抢着 listen 就撞上 EADDRINUSE。
// 收到信号主动 server.close()，3 秒兜底超时强制退出，让端口尽快真正让出来。
function shutdown(signal) {
  console.log(`收到 ${signal}，关闭监听...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
