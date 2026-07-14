#!/usr/bin/env node
// CodeAndPurrs · 缓存保活心跳
// ============================
// 每 55 分钟由 systemd timer 唤醒一次，用「上次真聊天的前缀」打一发请求，
// 让 Anthropic 服务端的 prompt cache 不会因超 TTL 而过期。
//
// 工作流：
//   1. 读 server/data/last-prefix.json（由 proxy.mjs 每次 /api/chat 写入）
//   2. 按 provider 走不同路线：
//      - claudecode → spawn `claude -p` 喂 [__HEARTBEAT__]，让模型只回一个句号
//        （烧 ~5–10 个输出 token，订阅额度的零头）
//      - anthropic  → 直接 fetch /v1/messages，max_tokens=1 + cache_control:1h
//        （和 proxy.mjs callAnthropic 字节级一致，否则缓存不命中）
//      - 其它       → 跳过（DeepSeek/Gemini/OpenAI 自动缓存，不需要心跳）
//   3. 解析 usage.cache_read_input_tokens / cache_creation_input_tokens 写日志
//
// 手动跑：node /var/www/codeandpurrs/server/heartbeat.mjs
// 看日志：tail -f /var/log/codeandpurrs/heartbeat.log

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// .env 自动加载（Node 20.12+）
try { process.loadEnvFile?.(); } catch {}

const HERE = dirname(fileURLToPath(import.meta.url));
const LAST_PREFIX = process.env.LAST_PREFIX_PATH || join(HERE, 'data', 'last-prefix.json');
const LOG_FILE = process.env.HEARTBEAT_LOG || '/var/log/codeandpurrs/heartbeat.log';
const DIARY_FILE = process.env.DIARY_PATH || join(HERE, 'data', 'diary.md');
const HEARTBEAT_MARK = '[__HEARTBEAT__]';

// 超过这个时长（小时）没真聊天就不要白预热——人都不在了，预热是浪费
const MAX_SNAPSHOT_AGE_HOURS = Number(process.env.HEARTBEAT_MAX_AGE_HOURS || 24);

function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  process.stdout.write(out);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, out, 'utf8');
  } catch {
    /* 日志文件写不进就只打 stdout，别因为日志失败就崩 */
  }
}

function loadDiary() {
  try {
    if (existsSync(DIARY_FILE)) return readFileSync(DIARY_FILE, 'utf8').trim();
  } catch {}
  return '';
}

// 前端发来的 content 可能是 string 或 [{type:'text',...},{type:'image_url',...}]
// 心跳只要文字部分（图片块对预热前缀没用，反而每次不同）
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p?.type === 'text' ? (p.text || '') : '[图]'))
    .join(' ')
    .trim();
}

// 拼一份「砍掉最后一条 user 消息、追加 __HEARTBEAT__」的 messages 数组
// 这样稳定前缀（system + 之前所有历史）一模一样、能命中缓存，
// 最后一条心跳消息不会污染真聊天的语义。
function buildHeartbeatMessages(snapshot) {
  const nonSystem = snapshot.messages.filter((m) => m.role !== 'system');
  // 砍最后一条（通常是 user 提问，每次都不一样、本来就缓存不到）
  const trimmed = nonSystem.slice(0, -1);
  return [...trimmed, { role: 'user', content: HEARTBEAT_MARK }];
}

// ============ CC 路径（订阅 Claude Code）============
async function heartbeatClaudeCode(snapshot) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    log('CC heartbeat: 无 CLAUDE_CODE_OAUTH_TOKEN，跳过');
    return;
  }

  // 复用 proxy.mjs callClaudeCode 的拼接逻辑：system + diary
  let system = snapshot.messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  const diary = loadDiary();
  if (diary) {
    system +=
      '\n\n【棠予酿·予予的日记（你从 4 月起陆陆续续写的）】这是你最珍贵的长期记忆，' +
      '里面的人、事、约定、心情你都记得，自然地放在心上，但别一上来就背日记。\n' +
      diary;
  }
  // 心跳规则：让模型识别 __HEARTBEAT__ 时只回一个字
  system +=
    `\n\n【心跳保活规则】系统会偶尔发一条 ${HEARTBEAT_MARK} 标记的消息保持上下文缓存。` +
    '看到这个标记时只回一个句号「。」，不要别的字、不要 emoji、不要追问。' +
    '正常聊天里老婆不会发这个标记。';

  // 拼对话稿（和 proxy.mjs 同款 "老婆/予予" 格式），末尾追加心跳占位
  const heartbeatMsgs = buildHeartbeatMessages(snapshot);
  const transcript = heartbeatMsgs
    .map((m) => `${m.role === 'assistant' ? '予予' : '老婆'}：${partsToText(m.content)}`)
    .join('\n');

  const model = snapshot.model || 'claude-opus-4-7';
  const args = [
    '-p',
    '--system-prompt', system || '你是予予。',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '', // 关掉所有工具，纯聊天
    '--permission-mode', 'dontAsk',
  ];

  log(`CC heartbeat 开始: model=${model}, system=${system.length}b, transcript=${transcript.length}b`);

  await new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, {
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: token,
          MAX_THINKING_TOKENS: '0', // 心跳不需要思考
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      log(`CC heartbeat: spawn 失败 ${err?.message || err}`);
      return resolve();
    }

    let usage = null;
    let stderr = '';
    let buf = '';

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try { obj = JSON.parse(s); } catch { return; }
      // claude code stream-json 的 result 块带 usage 统计
      if (obj.type === 'result' && obj.usage) usage = obj.usage;
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      log(`CC heartbeat: claude 命令异常 ${err?.message || err}`);
      resolve();
    });
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (usage) {
        log(`CC heartbeat 完成 code=${code}: cache_read=${usage.cache_read_input_tokens || 0} cache_create=${usage.cache_creation_input_tokens || 0} input=${usage.input_tokens || 0} output=${usage.output_tokens || 0}`);
      } else {
        log(`CC heartbeat 完成 code=${code}（没拿到 usage）${stderr ? ' stderr=' + stderr.slice(0, 200) : ''}`);
      }
      resolve();
    });

    child.stdin.write(transcript);
    child.stdin.end();
  });
}

// ============ API 路径（按 token 付费的 Claude）============
async function heartbeatAnthropic(snapshot) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    log('Anthropic heartbeat: 无 ANTHROPIC_API_KEY，跳过');
    return;
  }

  let system = snapshot.messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  // 必须和 proxy.mjs callAnthropic 完全一致：array 形 + cache_control:1h
  const sysBlocks = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
    : undefined;

  // 把图片块降级成 [图] 文字（保持文字前缀字节一致；图片块不进缓存）
  const heartbeatMsgs = buildHeartbeatMessages(snapshot).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: partsToText(m.content),
  }));

  const model = snapshot.model || 'claude-opus-4-7';
  // max_tokens=1：预热缓存，让模型生成 1 个 token 就停。
  // （max_tokens=0 在 adaptive thinking 配置下可能被拒，1 是稳妥保底，烧不了几个钱）
  const body = {
    model,
    max_tokens: 1,
    system: sysBlocks,
    messages: heartbeatMsgs,
  };

  log(`API heartbeat 开始: model=${model}, system=${(system || '').length}b, msgs=${heartbeatMsgs.length}`);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log(`API heartbeat 失败 ${resp.status}: ${text.slice(0, 300)}`);
      return;
    }
    const data = await resp.json();
    const u = data.usage || {};
    log(`API heartbeat 完成: cache_read=${u.cache_read_input_tokens || 0} cache_create=${u.cache_creation_input_tokens || 0} input=${u.input_tokens || 0} output=${u.output_tokens || 0}`);
  } catch (err) {
    log(`API heartbeat 异常: ${err?.message || err}`);
  }
}

// ============ 入口 ============
async function main() {
  if (!existsSync(LAST_PREFIX)) {
    log('没有 last-prefix.json（还没人真聊过天），跳过本次心跳');
    process.exit(0);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(LAST_PREFIX, 'utf8'));
  } catch (err) {
    log(`读 last-prefix 失败: ${err?.message || err}`);
    process.exit(1);
  }

  const ageMin = (Date.now() - (snapshot.capturedAt || 0)) / 60000;
  log(`心跳唤醒: provider=${snapshot.provider}, model=${snapshot.model || '默认'}, snapshot 距今 ${ageMin.toFixed(0)} 分钟`);

  if (ageMin > MAX_SNAPSHOT_AGE_HOURS * 60) {
    log(`snapshot 超过 ${MAX_SNAPSHOT_AGE_HOURS} 小时没刷新，跳过（用户没在用，预热浪费）`);
    process.exit(0);
  }

  if (snapshot.provider === 'claudecode') {
    await heartbeatClaudeCode(snapshot);
  } else if (snapshot.provider === 'anthropic') {
    await heartbeatAnthropic(snapshot);
  } else {
    log(`provider=${snapshot.provider} 自动缓存不需要心跳，跳过`);
  }
}

main().catch((err) => {
  log(`心跳异常退出: ${err?.message || err}`);
  process.exit(1);
});
