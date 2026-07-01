// 一发烟雾测试：ingest → latest/day/trend → 可选 prune/delete。契约 §4。
const baseUrl = (process.env.BRIDGE_BASE_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const token = process.env.BRIDGE_TOKEN ?? process.env.USAGE_BRIDGE_TOKEN ?? 'test-token';
const owner = process.env.BRIDGE_OWNER ?? 'neko';
const date = process.env.BRIDGE_DATE ?? '2026-06-13';

function makePayload(payloadDate, totalForegroundMs = 3600000) {
  return {
    schemaVersion: 1,
    device: { id: 'redmi-smoke', owner, model: 'Redmi smoke test', os: 'MIUI/HyperOS' },
    date: payloadDate,
    tz: 'Asia/Kuching',
    generatedAt: `${payloadDate}T20:42:00+08:00`,
    summary: {
      totalForegroundMs,
      unlocks: 12,
      firstUseAt: `${payloadDate}T08:12:00+08:00`,
      lastUseAt: `${payloadDate}T20:30:00+08:00`,
      notifications: 87,
    },
    hourly: Array.from({ length: 24 }, (_, hour) => (hour === 20 ? totalForegroundMs : 0)),
    apps: [
      {
        package: 'com.codeandpurrs.smoke',
        label: 'CodeAndPurrs Smoke',
        category: 'tool',
        foregroundMs: totalForegroundMs,
        lastUsedAt: `${payloadDate}T19:30:00+08:00`,
        iconBase64: null,
      },
    ],
    sessions: [
      { package: 'com.codeandpurrs.smoke', label: 'CodeAndPurrs Smoke', category: 'tool', startAt: `${payloadDate}T19:00:00+08:00`, endAt: `${payloadDate}T20:00:00+08:00` },
    ],
  };
}

function buildUrl(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function requestJson(label, path, options = {}, expectedStatus = 200) {
  const response = await fetch(path, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (response.status !== expectedStatus) {
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${response.status}: ${text}`);
  }

  console.log(`✓ ${label}`);
  return body;
}

async function main() {
  console.log(`Neko Usage Bridge smoke test: ${baseUrl}`);
  console.log(`Owner: ${owner}; Date: ${date}`);

  await requestJson('health', buildUrl('/api/usage/health'));
  await requestJson('ping', buildUrl('/api/usage/ping'), { method: 'POST', headers: { 'X-Bridge-Token': token } });

  const ingestBody = await requestJson('ingest', buildUrl('/api/usage/ingest'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
    body: JSON.stringify(makePayload(date)),
  }, 201);

  if (ingestBody.owner !== owner || ingestBody.date !== date) {
    throw new Error(`ingest returned unexpected owner/date: ${JSON.stringify(ingestBody)}`);
  }

  const latestBody = await requestJson('latest', buildUrl('/api/usage/latest', { owner }));
  if (latestBody.data?.date !== date) {
    throw new Error(`latest did not return smoke date ${date}`);
  }
  if (typeof latestBody.meta?.stale !== 'boolean') {
    throw new Error('latest missing meta.stale');
  }

  const dayBody = await requestJson('day', buildUrl('/api/usage/day', { owner, date }));
  if (dayBody.data?.summary?.totalForegroundMs !== 3600000) {
    throw new Error('day returned unexpected totalForegroundMs');
  }

  const trendBody = await requestJson('trend', buildUrl('/api/usage/trend', { owner, days: '7' }));
  if (!Array.isArray(trendBody.data) || !trendBody.data.some((item) => item.date === date)) {
    throw new Error('trend did not include smoke date');
  }

  const pruneBefore = process.env.BRIDGE_PRUNE_BEFORE;
  if (pruneBefore) {
    await requestJson('prune', buildUrl('/api/usage/prune', { owner, before: pruneBefore }), {
      method: 'POST',
      headers: { 'X-Bridge-Token': token },
    });
  }

  if (process.env.BRIDGE_DELETE_AFTER_SMOKE === '1') {
    await requestJson('delete smoke day', buildUrl('/api/usage/day', { owner, date }), {
      method: 'DELETE',
      headers: { 'X-Bridge-Token': token },
    });
  }

  console.log('Smoke test passed. Bridge is ready for Paw Trail reads.');
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
