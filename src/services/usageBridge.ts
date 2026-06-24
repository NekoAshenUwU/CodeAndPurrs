// 猫爪足迹前端 ← VPS 接收端读取层。契约见 docs/neko-usage-bridge-spec.md §4。
// bridge 还没上线时：抓取失败会回退到 demo 示例数据，方便先看页面效果。

const DEFAULT_BRIDGE_BASE_URL = 'https://api.nekopurrs.uk';

export type UsageCategory = 'social' | 'work' | 'entertainment' | 'reading' | 'tool' | 'other';

export type UsageApp = {
  package: string;
  label: string;
  category?: UsageCategory | string | null;
  foregroundMs: number;
  lastUsedAt?: string;
  iconBase64?: string | null;
};

export type UsageSession = {
  package: string;
  label?: string;
  category?: UsageCategory | string | null;
  startAt: string;
  endAt: string;
};

export type UsageSummary = {
  totalForegroundMs: number;
  unlocks: number;
  firstUseAt?: string;
  lastUseAt?: string;
  notifications?: number | null;
};

export type UsagePayload = {
  schemaVersion: number;
  device?: { id?: string; owner?: string; model?: string; os?: string };
  date: string;
  tz: string;
  generatedAt: string;
  ingestedAt?: string;
  summary: UsageSummary;
  hourly: number[];
  apps: UsageApp[];
  sessions?: UsageSession[];
};

export type UsageMeta = { owner: string; lastIngestAt: string | null; stale: boolean };
export type UsageEnvelope = { meta: UsageMeta; data: UsagePayload; source: 'live' | 'demo' };
export type TrendPoint = { date: string; totalForegroundMs: number; unlocks: number };
export type TrendResult = { meta: UsageMeta; data: TrendPoint[]; source: 'live' | 'demo' };

function baseUrl(): string {
  return (import.meta.env.VITE_USAGE_BRIDGE_BASE_URL ?? DEFAULT_BRIDGE_BASE_URL).replace(/\/$/, '');
}

function demoForced(): boolean {
  return import.meta.env.VITE_USAGE_BRIDGE_DEMO === '1';
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`bridge ${path} -> HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

// 读取最新一天；失败或 demo 模式回退示例数据。
export async function fetchLatestUsage(owner = 'neko'): Promise<UsageEnvelope> {
  if (demoForced()) {
    return demoEnvelope();
  }
  try {
    const body = await getJson<{ ok: boolean; meta: UsageMeta; data: UsagePayload }>(
      `/api/usage/latest?owner=${encodeURIComponent(owner)}`,
    );
    return { meta: body.meta, data: body.data, source: 'live' };
  } catch {
    return demoEnvelope();
  }
}

export async function fetchTrend(owner = 'neko', days = 7): Promise<TrendResult> {
  if (demoForced()) {
    return demoTrend();
  }
  try {
    const body = await getJson<{ ok: boolean; meta: UsageMeta; data: TrendPoint[] }>(
      `/api/usage/trend?owner=${encodeURIComponent(owner)}&days=${days}`,
    );
    return { meta: body.meta, data: body.data, source: 'live' };
  } catch {
    return demoTrend();
  }
}

// ---------- demo 示例数据（bridge 上线前预览用）----------

const DEMO_DATE = '2026-06-13';

function hours(...pairs: Array<[number, number]>): number[] {
  const arr = new Array<number>(24).fill(0);
  for (const [h, m] of pairs) arr[h] = m;
  return arr;
}

function demoPayload(): UsagePayload {
  return {
    schemaVersion: 1,
    device: { id: 'redmi-demo', owner: 'neko', model: 'Redmi Turbo 4', os: 'HyperOS 2' },
    date: DEMO_DATE,
    tz: 'Asia/Kuching',
    generatedAt: `${DEMO_DATE}T22:40:00+08:00`,
    ingestedAt: new Date().toISOString(),
    summary: {
      totalForegroundMs: 4 * 3600000 + 12 * 60000,
      unlocks: 47,
      firstUseAt: `${DEMO_DATE}T07:14:00+08:00`,
      lastUseAt: `${DEMO_DATE}T23:58:00+08:00`,
      notifications: 213,
    },
    hourly: hours([1, 18], [7, 12], [8, 22], [12, 28], [13, 20], [19, 35], [20, 48], [21, 40], [22, 30], [23, 14]),
    apps: [
      { package: 'com.xingin.xhs', label: '小红书', category: 'social', foregroundMs: 165 * 60000, lastUsedAt: `${DEMO_DATE}T22:10:00+08:00` },
      { package: 'com.tencent.mm', label: '微信', category: 'social', foregroundMs: 140 * 60000, lastUsedAt: `${DEMO_DATE}T23:40:00+08:00` },
      { package: 'com.ss.android.ugc.aweme', label: '抖音', category: 'entertainment', foregroundMs: 100 * 60000, lastUsedAt: `${DEMO_DATE}T21:30:00+08:00` },
      { package: 'com.openai.chatgpt', label: 'ChatGPT', category: 'work', foregroundMs: 70 * 60000, lastUsedAt: `${DEMO_DATE}T15:05:00+08:00` },
      { package: 'com.anthropic.claude', label: 'Claude', category: 'work', foregroundMs: 45 * 60000, lastUsedAt: `${DEMO_DATE}T16:20:00+08:00` },
    ],
    sessions: [
      { package: 'com.xingin.xhs', label: '小红书', category: 'social', startAt: `${DEMO_DATE}T00:18:00+08:00`, endAt: `${DEMO_DATE}T01:54:00+08:00` },
      { package: 'com.tencent.mm', label: '微信', category: 'social', startAt: `${DEMO_DATE}T07:14:00+08:00`, endAt: `${DEMO_DATE}T07:36:00+08:00` },
      { package: 'com.openai.chatgpt', label: 'ChatGPT', category: 'work', startAt: `${DEMO_DATE}T13:40:00+08:00`, endAt: `${DEMO_DATE}T15:05:00+08:00` },
      { package: 'com.ss.android.ugc.aweme', label: '抖音', category: 'entertainment', startAt: `${DEMO_DATE}T19:10:00+08:00`, endAt: `${DEMO_DATE}T19:54:00+08:00` },
      { package: 'com.xingin.xhs', label: '小红书', category: 'social', startAt: `${DEMO_DATE}T20:30:00+08:00`, endAt: `${DEMO_DATE}T22:10:00+08:00` },
      { package: 'com.tencent.mm', label: '微信', category: 'social', startAt: `${DEMO_DATE}T23:20:00+08:00`, endAt: `${DEMO_DATE}T23:58:00+08:00` },
    ],
  };
}

function demoEnvelope(): UsageEnvelope {
  return { meta: { owner: 'neko', lastIngestAt: new Date().toISOString(), stale: false }, data: demoPayload(), source: 'demo' };
}

function demoTrend(): TrendResult {
  const mins = [188, 205, 233, 176, 262, 240, 252];
  const unlocks = [41, 52, 60, 38, 55, 49, 47];
  const data: TrendPoint[] = mins.map((m, i) => ({
    date: `2026-06-${String(7 + i).padStart(2, '0')}`,
    totalForegroundMs: m * 60000,
    unlocks: unlocks[i],
  }));
  return { meta: { owner: 'neko', lastIngestAt: new Date().toISOString(), stale: false }, data, source: 'demo' };
}
