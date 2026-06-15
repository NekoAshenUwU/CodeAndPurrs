import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_ALLOWED_ORIGIN = '*';
const DEFAULT_DATA_DIR = new URL('./data/usage/', import.meta.url).pathname;
const DEFAULT_RETENTION_DAYS = 0;

function jsonResponse(response, status, body, origin = DEFAULT_ALLOWED_ORIGIN) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
    'Access-Control-Allow-Methods': 'DELETE, GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  response.end(JSON.stringify(body));
}

function getAllowedOrigin(requestOrigin, allowedOrigins) {
  if (allowedOrigins.includes('*')) {
    return '*';
  }

  return requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
}

function sanitizePathPart(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return text.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRetentionDays(value) {
  const parsed = Number(value ?? DEFAULT_RETENTION_DAYS);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETENTION_DAYS;
  }

  return Math.min(Math.floor(parsed), 3660);
}

function shiftIsoDate(date, days) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);

  if (Number.isNaN(timestamp)) {
    return '';
  }

  const shifted = new Date(timestamp + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function getRetentionCutoffDate(anchorDate, retentionDays) {
  if (!isIsoDate(anchorDate) || retentionDays <= 0) {
    return '';
  }

  return shiftIsoDate(anchorDate, -(retentionDays - 1));
}

function assertUsagePayload(payload) {
  if (!isRecord(payload)) {
    return 'payload must be a JSON object';
  }

  if (payload.schemaVersion !== 1) {
    return 'schemaVersion must be 1';
  }

  if (typeof payload.owner !== 'string' || !payload.owner.trim()) {
    return 'owner is required';
  }

  if (!isIsoDate(payload.date)) {
    return 'date must be YYYY-MM-DD';
  }

  if (typeof payload.tz !== 'string' || !payload.tz.trim()) {
    return 'tz is required';
  }

  if (typeof payload.generatedAt !== 'string' || Number.isNaN(Date.parse(payload.generatedAt))) {
    return 'generatedAt must be an ISO8601 timestamp';
  }

  if (!isRecord(payload.summary)) {
    return 'summary is required';
  }

  if (typeof payload.summary.totalScreenMs !== 'number' || payload.summary.totalScreenMs < 0) {
    return 'summary.totalScreenMs must be a non-negative number';
  }

  if (typeof payload.summary.unlockCount !== 'number' || payload.summary.unlockCount < 0) {
    return 'summary.unlockCount must be a non-negative number';
  }

  if (!Array.isArray(payload.apps)) {
    return 'apps must be an array';
  }

  if (!Array.isArray(payload.hourly) || payload.hourly.length !== 24) {
    return 'hourly must be an array of 24 numbers';
  }

  if (payload.hourly.some((value) => typeof value !== 'number' || value < 0)) {
    return 'hourly must contain non-negative numbers';
  }

  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.byteLength;

    if (size > MAX_BODY_BYTES) {
      throw new Error('request body is too large');
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : {};
}

async function writeUsagePayload(dataDir, payload) {
  const owner = sanitizePathPart(payload.owner, 'neko');
  const ownerDir = join(dataDir, owner);
  const filePath = join(ownerDir, `${payload.date}.json`);
  const storedPayload = {
    ...payload,
    ingestedAt: new Date().toISOString(),
  };

  await mkdir(ownerDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storedPayload, null, 2)}\n`, 'utf8');

  return storedPayload;
}

async function readUsageDay(dataDir, owner, date) {
  const safeOwner = sanitizePathPart(owner, 'neko');
  const safeDate = isIsoDate(date) ? date : '';

  if (!safeDate) {
    return null;
  }

  try {
    return JSON.parse(await readFile(join(dataDir, safeOwner, `${safeDate}.json`), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function deleteUsageDay(dataDir, owner, date) {
  const safeOwner = sanitizePathPart(owner, 'neko');
  const safeDate = isIsoDate(date) ? date : '';

  if (!safeDate) {
    return { deleted: false, reason: 'date must be YYYY-MM-DD' };
  }

  try {
    await rm(join(dataDir, safeOwner, `${safeDate}.json`));
    return { deleted: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { deleted: false, reason: 'usage data not found' };
    }

    throw error;
  }
}

async function pruneUsageBeforeDate(dataDir, owner, beforeDate) {
  const safeOwner = sanitizePathPart(owner, 'neko');

  if (!isIsoDate(beforeDate)) {
    return { deletedDates: [], reason: 'before must be YYYY-MM-DD' };
  }

  let files;

  try {
    files = await readdir(join(dataDir, safeOwner));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { deletedDates: [] };
    }

    throw error;
  }

  const deletedDates = [];
  const staleFiles = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file.slice(0, 10) < beforeDate);

  for (const file of staleFiles) {
    await rm(join(dataDir, safeOwner, file));
    deletedDates.push(file.slice(0, 10));
  }

  return { deletedDates };
}

async function deleteOwnerUsage(dataDir, owner) {
  const safeOwner = sanitizePathPart(owner, 'neko');

  try {
    await rm(join(dataDir, safeOwner), { recursive: true });
    return { deleted: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { deleted: false, reason: 'usage data not found' };
    }

    throw error;
  }
}

async function listUsagePayloads(dataDir, owner) {
  const safeOwner = sanitizePathPart(owner, 'neko');
  const ownerDir = join(dataDir, safeOwner);

  let files;

  try {
    files = await readdir(ownerDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const dateFiles = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  const payloads = await Promise.all(dateFiles.map((file) => readFile(join(ownerDir, file), 'utf8').then(JSON.parse)));

  return payloads.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function requireBridgeToken(request, bridgeToken) {
  if (!bridgeToken) {
    return true;
  }

  return request.headers['x-bridge-token'] === bridgeToken;
}

function buildTrend(payloads, days) {
  return payloads.slice(-days).map((payload) => ({
    date: payload.date,
    tz: payload.tz,
    totalScreenMs: payload.summary?.totalScreenMs ?? 0,
    unlockCount: payload.summary?.unlockCount ?? 0,
    generatedAt: payload.generatedAt,
  }));
}

async function getStorageHealth(dataDir) {
  try {
    await mkdir(dataDir, { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'storage unavailable' };
  }
}

export function createUsageBridgeServer({
  dataDir = process.env.USAGE_BRIDGE_DATA_DIR ?? DEFAULT_DATA_DIR,
  bridgeToken = process.env.USAGE_BRIDGE_TOKEN ?? '',
  allowedOrigins = (process.env.USAGE_BRIDGE_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGIN).split(',').map((origin) => origin.trim()).filter(Boolean),
  retentionDays = readRetentionDays(process.env.USAGE_BRIDGE_RETENTION_DAYS),
} = {}) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const origin = getAllowedOrigin(request.headers.origin, allowedOrigins.length ? allowedOrigins : [DEFAULT_ALLOWED_ORIGIN]);

    if (request.method === 'OPTIONS') {
      jsonResponse(response, 204, {}, origin);
      return;
    }

    try {
      if (requestUrl.pathname === '/api/usage/health' && request.method === 'GET') {
        const storage = await getStorageHealth(dataDir);
        jsonResponse(response, storage.ok ? 200 : 503, {
          ok: storage.ok,
          service: 'neko-usage-bridge',
          storage,
          tokenConfigured: Boolean(bridgeToken),
          retentionDays,
          checkedAt: new Date().toISOString(),
        }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/ping' && request.method === 'POST') {
        if (!requireBridgeToken(request, bridgeToken)) {
          jsonResponse(response, 401, { ok: false, error: 'invalid bridge token' }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, service: 'neko-usage-bridge', receivedAt: new Date().toISOString() }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/ingest' && request.method === 'POST') {
        if (!requireBridgeToken(request, bridgeToken)) {
          jsonResponse(response, 401, { ok: false, error: 'invalid bridge token' }, origin);
          return;
        }

        const payload = await readJsonBody(request);
        const validationError = assertUsagePayload(payload);

        if (validationError) {
          jsonResponse(response, 400, { ok: false, error: validationError }, origin);
          return;
        }

        const storedPayload = await writeUsagePayload(dataDir, payload);
        const retentionCutoffDate = getRetentionCutoffDate(storedPayload.date, retentionDays);
        const pruneResult = retentionCutoffDate ? await pruneUsageBeforeDate(dataDir, storedPayload.owner, retentionCutoffDate) : { deletedDates: [] };

        jsonResponse(response, 201, {
          ok: true,
          owner: storedPayload.owner,
          date: storedPayload.date,
          ingestedAt: storedPayload.ingestedAt,
          retentionDays,
          prunedDates: pruneResult.deletedDates,
        }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/latest' && request.method === 'GET') {
        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const payloads = await listUsagePayloads(dataDir, owner);
        const payload = payloads.at(-1) ?? null;

        if (!payload) {
          jsonResponse(response, 404, { ok: false, error: 'usage data not found' }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, payload }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/day' && request.method === 'GET') {
        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const date = requestUrl.searchParams.get('date') ?? '';
        const payload = await readUsageDay(dataDir, owner, date);

        if (!payload) {
          jsonResponse(response, 404, { ok: false, error: 'usage data not found' }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, payload }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/trend' && request.method === 'GET') {
        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const days = Math.min(Math.max(Number(requestUrl.searchParams.get('days') ?? 7), 1), 30);
        const payloads = await listUsagePayloads(dataDir, owner);

        jsonResponse(response, 200, { ok: true, owner, days, trend: buildTrend(payloads, days) }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/prune' && request.method === 'POST') {
        if (!requireBridgeToken(request, bridgeToken)) {
          jsonResponse(response, 401, { ok: false, error: 'invalid bridge token' }, origin);
          return;
        }

        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const before = requestUrl.searchParams.get('before') ?? '';
        const result = await pruneUsageBeforeDate(dataDir, owner, before);

        if (result.reason) {
          jsonResponse(response, 400, { ok: false, error: result.reason }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, owner, before, deletedDates: result.deletedDates }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/day' && request.method === 'DELETE') {
        if (!requireBridgeToken(request, bridgeToken)) {
          jsonResponse(response, 401, { ok: false, error: 'invalid bridge token' }, origin);
          return;
        }

        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const date = requestUrl.searchParams.get('date') ?? '';
        const result = await deleteUsageDay(dataDir, owner, date);

        if (!result.deleted) {
          jsonResponse(response, result.reason === 'usage data not found' ? 404 : 400, { ok: false, error: result.reason }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, owner, date, deleted: true }, origin);
        return;
      }

      if (requestUrl.pathname === '/api/usage/owner' && request.method === 'DELETE') {
        if (!requireBridgeToken(request, bridgeToken)) {
          jsonResponse(response, 401, { ok: false, error: 'invalid bridge token' }, origin);
          return;
        }

        const owner = requestUrl.searchParams.get('owner') ?? 'neko';
        const result = await deleteOwnerUsage(dataDir, owner);

        if (!result.deleted) {
          jsonResponse(response, 404, { ok: false, error: result.reason }, origin);
          return;
        }

        jsonResponse(response, 200, { ok: true, owner, deleted: true }, origin);
        return;
      }

      jsonResponse(response, 404, { ok: false, error: 'not found' }, origin);
    } catch (error) {
      jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : 'internal server error' }, origin);
    }
  });
}
