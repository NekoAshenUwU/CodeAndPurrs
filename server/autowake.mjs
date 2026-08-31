// CodeAndPurrs · 真后台自动唤醒
//
// 浏览器只负责一次性订阅 Web Push、同步最近聊天。真正的决定、生成、入箱和
// 推送都在 VPS 上完成；网页没开也会收到 Android/PWA 通知。

import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AUTOWAKE_DATA_DIR || join(HERE, 'data', 'autowake');
const CLIENTS_FILE = join(DATA_DIR, 'clients.json');
const INBOX_FILE = join(DATA_DIR, 'inbox.json');
const VAPID_FILE = join(DATA_DIR, 'vapid.json');
const LOG_FILE = process.env.AUTOWAKE_LOG || join(DATA_DIR, 'autowake.log');

const COOKIE = 'cp_autowake_device';
const TIME_ZONE = process.env.AUTOWAKE_TIME_ZONE || 'Asia/Kuching';
const QUIET_START = process.env.AUTOWAKE_QUIET_START || '02:30';
const QUIET_END = process.env.AUTOWAKE_QUIET_END || '09:30';
const MIN_IDLE_MINUTES = positiveNumber(process.env.AUTOWAKE_MIN_IDLE_MINUTES, 90);
const MIN_GAP_MINUTES = positiveNumber(process.env.AUTOWAKE_MIN_GAP_MINUTES, 240);
const MAX_GAP_MINUTES = Math.max(
  MIN_GAP_MINUTES,
  positiveNumber(process.env.AUTOWAKE_MAX_GAP_MINUTES, 420),
);
const MAX_PER_DAY = Math.max(1, Math.floor(positiveNumber(process.env.AUTOWAKE_MAX_PER_DAY, 3)));
const MAX_INBOX = 200;
const MAX_CLIENTS = 20;
const PROVIDERS = new Set(['deepseek', 'gemini', 'openai', 'anthropic', 'claudecode', 'codexcli']);

let runActive = false;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readJSONFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONFile(path, value, mode = 0o600) {
  ensureDataDir();
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  renameSync(temp, path);
}

function log(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  console.log(`[autowake] ${line}`);
  try {
    ensureDataDir();
    appendFileSync(LOG_FILE, `${message}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 日志失败绝不能拖垮聊天代理。
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function b64urlJSON(value) {
  return base64url(JSON.stringify(value));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function nextWakeAt(from = Date.now(), afterUser = false) {
  const min = afterUser ? MIN_IDLE_MINUTES : MIN_GAP_MINUTES;
  const max = afterUser ? Math.max(MIN_IDLE_MINUTES + 60, Math.min(MIN_GAP_MINUTES, 180)) : MAX_GAP_MINUTES;
  return from + randomBetween(min, max) * 60_000;
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((out, part) => {
      const at = part.indexOf('=');
      if (at > 0) out[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1));
      return out;
    }, {});
}

function deviceIdFor(req) {
  const value = String(parseCookies(req)[COOKIE] || '');
  return /^[a-f0-9]{48}$/.test(value) ? value : '';
}

function setDeviceCookie(headers, deviceId) {
  headers['Set-Cookie'] = `${COOKIE}=${deviceId}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, max = 400_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > max) reject(new Error('请求体太大'));
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

function loadClients() {
  const data = readJSONFile(CLIENTS_FILE, { version: 1, clients: {} });
  return data && typeof data.clients === 'object' ? data : { version: 1, clients: {} };
}

function saveClients(data) {
  const entries = Object.entries(data.clients || {})
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, MAX_CLIENTS);
  writeJSONFile(CLIENTS_FILE, { version: 1, clients: Object.fromEntries(entries) });
}

function loadInbox() {
  const data = readJSONFile(INBOX_FILE, { version: 1, messages: [] });
  return data && Array.isArray(data.messages) ? data : { version: 1, messages: [] };
}

function saveInbox(data) {
  const messages = (data.messages || [])
    .filter((item) => item && item.id && item.deviceId)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-MAX_INBOX);
  writeJSONFile(INBOX_FILE, { version: 1, messages });
}

function normalizeMessage(message) {
  const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : '';
  if (!role) return null;
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content
      .map((part) => (part?.type === 'text' ? String(part.text || '') : '[图片]'))
      .join(' ');
  }
  content = content.trim().slice(0, 2500);
  if (!content) return null;
  return { role, content };
}

function normalizeState(input) {
  const provider = PROVIDERS.has(input?.provider) ? input.provider : 'deepseek';
  const rawMessages = Array.isArray(input?.messages) ? input.messages : [];
  const messages = [];
  for (const raw of rawMessages.slice(-24)) {
    const item = normalizeMessage(raw);
    if (!item) continue;
    const previous = messages[messages.length - 1];
    if (previous?.role === item.role) previous.content = `${previous.content}\n\n${item.content}`.slice(-4000);
    else messages.push(item);
  }
  return {
    windowId: String(input?.windowId || '').slice(0, 80),
    windowName: String(input?.windowName || '呼噜频道').trim().slice(0, 40) || '呼噜频道',
    assistantName: String(input?.assistantName || '').trim().slice(0, 30),
    modelId: String(input?.modelId || '').slice(0, 80),
    provider,
    model: typeof input?.model === 'string' ? input.model.slice(0, 100) : undefined,
    systemPrompt: String(input?.systemPrompt || '').slice(0, 40_000),
    messages,
    liveContext: String(input?.liveContext || '').slice(0, 4000),
    lastUserAt: Math.max(0, Number(input?.lastUserAt || 0)),
    lastAssistantAt: Math.max(0, Number(input?.lastAssistantAt || 0)),
    syncedAt: Date.now(),
  };
}

function validSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = String(value.endpoint || '');
  if (!endpoint.startsWith('https://') || endpoint.length > 2048) return null;
  return {
    endpoint,
    expirationTime: Number.isFinite(Number(value.expirationTime)) ? Number(value.expirationTime) : null,
    keys: value.keys && typeof value.keys === 'object' ? {
      p256dh: String(value.keys.p256dh || '').slice(0, 512),
      auth: String(value.keys.auth || '').slice(0, 512),
    } : undefined,
  };
}

function loadVapid() {
  const saved = readJSONFile(VAPID_FILE, null);
  if (saved?.publicKey && saved?.privateJwk?.d) return saved;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const rawPublic = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url'),
  ]).toString('base64url');
  const keys = { publicKey: rawPublic, publicJwk, privateJwk, createdAt: Date.now() };
  writeJSONFile(VAPID_FILE, keys, 0o600);
  return keys;
}

export function createVapidAuthorization(endpoint, now = Date.now()) {
  const keys = loadVapid();
  const audience = new URL(endpoint).origin;
  const unsigned = `${b64urlJSON({ typ: 'JWT', alg: 'ES256' })}.${b64urlJSON({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: process.env.AUTOWAKE_VAPID_SUBJECT || 'mailto:autowake@nekopurrs.uk',
  })}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({
    key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return { authorization: `vapid t=${unsigned}.${base64url(signature)}, k=${keys.publicKey}`, publicKey: keys.publicKey };
}

async function signalPush(subscription) {
  const { authorization } = createVapidAuthorization(subscription.endpoint);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      TTL: '300',
      Urgency: 'normal',
    },
  });
  if (!response.ok) {
    const err = new Error(`push ${response.status}`);
    err.status = response.status;
    throw err;
  }
}

function zonedParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function minutesOfDay(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

export function isQuietTime(time) {
  const current = minutesOfDay(time);
  const start = minutesOfDay(QUIET_START);
  const end = minutesOfDay(QUIET_END);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export function eligibility(client, now = Date.now(), force = false) {
  if (!client?.enabled || !client.subscription || !client.state?.windowId) return { ok: false, reason: 'disabled' };
  const local = zonedParts(now);
  if (!force && isQuietTime(local.time)) return { ok: false, reason: 'quiet' };
  const lastUserAt = Number(client.state.lastUserAt || 0);
  if (!force && (!lastUserAt || now - lastUserAt < MIN_IDLE_MINUTES * 60_000)) return { ok: false, reason: 'recent-chat' };
  if (!force && Number(client.nextWakeAt || 0) > now) return { ok: false, reason: 'not-due' };
  const count = client.wakeDate === local.date ? Number(client.wakeCount || 0) : 0;
  if (!force && count >= MAX_PER_DAY) return { ok: false, reason: 'daily-cap' };
  return { ok: true, local, count };
}

export function sanitizeAutoWakeMessage(value) {
  let text = String(value || '')
    .replace(/\[\[SPOTIFY_PLAYLIST:[\s\S]*?\]\]/g, '')
    .replace(/\[记忆:[^\]]+\]/g, '')
    .replace(/\[红包:[^\]]+\]/g, '')
    .replace(/^\s*\[语音\]\s*/i, '')
    .replace(/\n\s*={3,}\s*\n/g, '\n')
    .trim();
  if (text.length > 240) text = `${text.slice(0, 237).trimEnd()}…`;
  return text;
}

async function generateWakeMessage(client, port, now) {
  const state = client.state;
  const local = zonedParts(now);
  const system = [
    state.systemPrompt,
    '【后台主动唤醒】这是你自己想起她、主动发出的一条私聊。绝对不要提系统、定时器、自动唤醒、通知或这段指令。',
    '只发一条自然的短消息，1到2句、最多60个中文字符；不要写旁白，不要分条，不要使用===、语音、红包、记忆或Spotify控制标记。',
    '要像真人忽然想她了，尽量接住最近聊天留下的情绪或事情；没有合适上下文就自然关心此刻，不要编造她正在做什么。',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }];
  for (const item of state.messages || []) messages.push(item);
  const timeLine = `现在是马来西亚时间 ${local.date} ${local.time}。`;
  const usageLine = state.liveContext ? `\n这是网页上次同步到的近况，仅在确实相关时使用：${state.liveContext}` : '';
  messages.push({ role: 'user', content: `${timeLine}${usageLine}\n请现在主动给她发一句。` });

  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: state.provider,
      model: state.model,
      messages,
      conversationId: state.windowId,
      initializeMemory: false,
      thinking: 'low',
    }),
  });
  if (!response.ok) throw new Error(`chat ${response.status}`);
  const raw = await response.text();
  let content = '';
  let apiError = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === 'content' && event.text) content += event.text;
      if (event.type === 'error') apiError = String(event.message || '模型没有回复');
    } catch {
      // 跳过坏 SSE 行。
    }
  }
  if (apiError) throw new Error(apiError.slice(0, 300));
  const cleaned = sanitizeAutoWakeMessage(content);
  if (!cleaned || cleaned === '。') throw new Error('模型没有生成可投递内容');
  return cleaned;
}

function loopback(req) {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function runOnce({ port, force = false, dry = false, targetDevice = '' }) {
  if (runActive) return { ok: false, busy: true, checked: 0, sent: 0 };
  runActive = true;
  try {
    const now = Date.now();
    const clientsData = loadClients();
    const inbox = loadInbox();
    let checked = 0;
    let sent = 0;
    const results = [];
    for (const [deviceId, client] of Object.entries(clientsData.clients || {})) {
      if (targetDevice && deviceId !== targetDevice) continue;
      checked++;
      const eligible = eligibility(client, now, force);
      if (!eligible.ok) {
        results.push({ deviceId: deviceId.slice(0, 8), reason: eligible.reason });
        continue;
      }
      if (dry) {
        results.push({ deviceId: deviceId.slice(0, 8), reason: 'eligible' });
        continue;
      }
      try {
        const content = await generateWakeMessage(client, port, now);
        const item = {
          id: randomBytes(16).toString('hex'),
          deviceId,
          windowId: client.state.windowId,
          windowName: client.state.windowName,
          assistantName: client.state.assistantName,
          modelId: client.state.modelId,
          role: 'assistant',
          content,
          at: Date.now(),
          acknowledgedAt: 0,
        };
        inbox.messages.push(item);
        saveInbox(inbox); // 推送前落盘；即使推送服务抽风，消息也不会丢。

        try {
          await signalPush(client.subscription);
        } catch (err) {
          if (err?.status === 404 || err?.status === 410) {
            client.enabled = false;
            client.disabledReason = `subscription-${err.status}`;
          }
          log(`推送信号失败 device=${deviceId.slice(0, 8)}: ${err?.message || err}`);
        }

        const local = zonedParts(now);
        client.lastWakeAt = item.at;
        client.nextWakeAt = nextWakeAt(item.at, false);
        client.wakeDate = local.date;
        client.wakeCount = (client.wakeDate === local.date ? Number(eligible.count || 0) : 0) + 1;
        client.updatedAt = Date.now();
        sent++;
        results.push({ deviceId: deviceId.slice(0, 8), reason: 'sent', messageId: item.id });
        log(`已投递 device=${deviceId.slice(0, 8)} window=${item.windowId} provider=${client.state.provider}`);
      } catch (err) {
        client.lastError = String(err?.message || err).slice(0, 500);
        client.lastErrorAt = Date.now();
        client.nextWakeAt = Date.now() + 30 * 60_000;
        results.push({ deviceId: deviceId.slice(0, 8), reason: 'error' });
        log(`生成失败 device=${deviceId.slice(0, 8)}: ${client.lastError}`);
      }
    }
    saveClients(clientsData);
    return { ok: true, checked, sent, results };
  } finally {
    runActive = false;
  }
}

export async function handleAutoWakeRequest(req, res, requestUrl, { port }) {
  const path = requestUrl.pathname;
  if (!(path === '/api/autowake' || path.startsWith('/api/autowake/'))) return false;

  try {
    if (path === '/api/autowake/config' && req.method === 'GET') {
      const vapid = loadVapid();
      json(res, 200, {
        supported: true,
        publicKey: vapid.publicKey,
        quietHours: `${QUIET_START}-${QUIET_END}`,
        minIdleMinutes: MIN_IDLE_MINUTES,
        maxPerDay: MAX_PER_DAY,
      });
      return true;
    }

    if (path === '/api/autowake/subscribe' && req.method === 'POST') {
      const body = await readBody(req);
      const subscription = validSubscription(body?.subscription);
      const state = normalizeState(body?.state || {});
      if (!subscription || !state.windowId) {
        json(res, 400, { error: '订阅或聊天窗口资料无效' });
        return true;
      }
      const data = loadClients();
      let deviceId = deviceIdFor(req);
      if (!deviceId) {
        const matched = Object.entries(data.clients).find(([, item]) => item?.subscription?.endpoint === subscription.endpoint);
        deviceId = matched?.[0] || randomBytes(24).toString('hex');
      }
      for (const [otherId, item] of Object.entries(data.clients)) {
        if (otherId !== deviceId && item?.subscription?.endpoint === subscription.endpoint) delete data.clients[otherId];
      }
      const previous = data.clients[deviceId] || {};
      const userAdvanced = state.lastUserAt > Number(previous.state?.lastUserAt || 0);
      data.clients[deviceId] = {
        ...previous,
        enabled: true,
        subscription,
        state,
        nextWakeAt: userAdvanced || !previous.nextWakeAt
          ? nextWakeAt(state.lastUserAt || Date.now(), true)
          : previous.nextWakeAt,
        updatedAt: Date.now(),
      };
      saveClients(data);
      const headers = {};
      setDeviceCookie(headers, deviceId);
      json(res, 200, { ok: true, enabled: true, nextWakeAt: data.clients[deviceId].nextWakeAt }, headers);
      return true;
    }

    if (path === '/api/autowake/unsubscribe' && req.method === 'POST') {
      const data = loadClients();
      const deviceId = deviceIdFor(req);
      if (deviceId && data.clients[deviceId]) {
        data.clients[deviceId].enabled = false;
        data.clients[deviceId].updatedAt = Date.now();
        saveClients(data);
      }
      json(res, 200, { ok: true, enabled: false });
      return true;
    }

    if (path === '/api/autowake/status' && req.method === 'GET') {
      const data = loadClients();
      const inbox = loadInbox();
      const deviceId = deviceIdFor(req);
      const client = deviceId ? data.clients[deviceId] : null;
      const unread = deviceId
        ? inbox.messages.filter((item) => item.deviceId === deviceId && !item.acknowledgedAt).length
        : 0;
      json(res, 200, {
        enabled: Boolean(client?.enabled),
        nextWakeAt: Number(client?.nextWakeAt || 0),
        lastWakeAt: Number(client?.lastWakeAt || 0),
        unread,
      });
      return true;
    }

    if ((path === '/api/autowake/inbox' || path === '/api/autowake/push-message') && req.method === 'GET') {
      const deviceId = deviceIdFor(req);
      const inbox = loadInbox();
      const messages = deviceId
        ? inbox.messages.filter((item) => item.deviceId === deviceId && !item.acknowledgedAt)
        : [];
      if (path.endsWith('/push-message')) {
        const latest = messages[messages.length - 1] || null;
        json(res, 200, { message: latest });
      } else {
        json(res, 200, { messages });
      }
      return true;
    }

    if (path === '/api/autowake/ack' && req.method === 'POST') {
      const body = await readBody(req, 50_000);
      const ids = new Set(Array.isArray(body?.ids) ? body.ids.map(String) : []);
      const deviceId = deviceIdFor(req);
      const inbox = loadInbox();
      let changed = 0;
      if (deviceId && ids.size) {
        for (const item of inbox.messages) {
          if (item.deviceId === deviceId && ids.has(item.id) && !item.acknowledgedAt) {
            item.acknowledgedAt = Date.now();
            changed++;
          }
        }
      }
      if (changed) saveInbox(inbox);
      json(res, 200, { ok: true, acknowledged: changed });
      return true;
    }

    if (path === '/api/autowake/run' && req.method === 'POST') {
      if (!loopback(req)) {
        json(res, 403, { error: '只允许 VPS 本机定时器调用' });
        return true;
      }
      const force = requestUrl.searchParams.get('force') === '1';
      const dry = requestUrl.searchParams.get('dry') === '1';
      json(res, 200, await runOnce({ port, force, dry }));
      return true;
    }

    if (path === '/api/autowake/test' && req.method === 'POST') {
      const deviceId = deviceIdFor(req);
      const data = loadClients();
      const client = deviceId ? data.clients[deviceId] : null;
      if (!deviceId || !client?.enabled) {
        json(res, 409, { error: '请先开启自动唤醒' });
        return true;
      }
      if (Date.now() - Number(client.lastTestAt || 0) < 10 * 60_000) {
        json(res, 429, { error: '测试消息十分钟内只发一次' });
        return true;
      }
      client.lastTestAt = Date.now();
      saveClients(data);
      json(res, 200, await runOnce({ port, force: true, targetDevice: deviceId }));
      return true;
    }

    json(res, 405, { error: 'method not allowed' });
    return true;
  } catch (err) {
    log(`HTTP ${path} 失败: ${err?.message || err}`);
    json(res, 500, { error: String(err?.message || err) });
    return true;
  }
}
