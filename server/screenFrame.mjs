import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data', 'screen');
const MAX_JSON_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 1_250_000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('screen frame payload too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON');
  }
}

function constantToken(req, header, expected) {
  const supplied = String(req.headers[header] || '').trim();
  return Boolean(expected && supplied && supplied === expected);
}

function latestFile(dataDir) {
  return join(dataDir, 'latest.json');
}

function removeLatest(dataDir) {
  rmSync(latestFile(dataDir), { force: true });
}

function normalizeFrame(body, receivedAt) {
  const schemaVersion = Number(body?.schemaVersion || 0);
  const deviceId = String(body?.deviceId || '').trim();
  const mimeType = String(body?.mimeType || '').trim().toLowerCase();
  const data = String(body?.data || '').replace(/\s+/g, '');
  const capturedAt = Number(body?.capturedAt || receivedAt);
  if (schemaVersion !== 1) throw new Error('unsupported schemaVersion');
  if (!deviceId || deviceId.length > 80) throw new Error('invalid deviceId');
  if (!ALLOWED_MIME.has(mimeType)) throw new Error('unsupported image type');
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) throw new Error('invalid capturedAt');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('invalid image data');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('screen frame image too large');
  return { schemaVersion, deviceId, mimeType, data, capturedAt, receivedAt };
}

function persistFrame(dataDir, frame) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = latestFile(dataDir);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(frame), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

function loadFrame(dataDir) {
  const target = latestFile(dataDir);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    removeLatest(dataDir);
    return null;
  }
}

export async function handleScreenFrameRequest(req, res, requestUrl, options = {}) {
  const path = requestUrl.pathname;
  if (path !== '/api/screen/ingest' && path !== '/api/screen/latest' && path !== '/api/screen/stop') return false;

  const dataDir = options.dataDir || process.env.SCREEN_FRAME_DATA_DIR || DEFAULT_DATA_DIR;
  const bridgeToken = String(options.bridgeToken ?? process.env.USAGE_BRIDGE_TOKEN ?? '').trim();
  const viewerKey = String(options.viewerKey ?? process.env.CHAT_SAVE_KEY ?? '').trim();
  const ttlMs = Number(options.ttlMs ?? Number(process.env.SCREEN_FRAME_TTL_SECONDS || 60) * 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  if (path === '/api/screen/ingest' && req.method === 'POST') {
    if (!bridgeToken) {
      json(res, 503, { error: 'screen bridge token is not configured' });
      return true;
    }
    if (!constantToken(req, 'x-bridge-token', bridgeToken)) {
      json(res, 401, { error: 'invalid bridge token' });
      return true;
    }
    try {
      const body = await readJson(req);
      const frame = normalizeFrame(body, now());
      persistFrame(dataDir, frame);
      json(res, 200, { ok: true, capturedAt: frame.capturedAt, receivedAt: frame.receivedAt });
    } catch (err) {
      json(res, 400, { error: String(err?.message || err) });
    }
    return true;
  }

  if (path === '/api/screen/stop' && req.method === 'POST') {
    if (!constantToken(req, 'x-bridge-token', bridgeToken)) {
      json(res, 401, { error: 'invalid bridge token' });
      return true;
    }
    removeLatest(dataDir);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/screen/latest' && req.method === 'GET') {
    if (!viewerKey) {
      json(res, 503, { error: 'screen viewer key is not configured' });
      return true;
    }
    if (!constantToken(req, 'x-chat-save-key', viewerKey)) {
      json(res, 401, { error: '存档密码不正确' });
      return true;
    }
    const frame = loadFrame(dataDir);
    if (!frame) {
      json(res, 404, { error: '手机还没有共享画面' });
      return true;
    }
    if (!Number.isFinite(frame.receivedAt) || now() - frame.receivedAt > ttlMs) {
      removeLatest(dataDir);
      json(res, 404, { error: '共享画面已经过期', stale: true });
      return true;
    }
    json(res, 200, {
      ok: true,
      deviceId: frame.deviceId,
      capturedAt: frame.capturedAt,
      receivedAt: frame.receivedAt,
      dataUrl: `data:${frame.mimeType};base64,${frame.data}`,
    });
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}
