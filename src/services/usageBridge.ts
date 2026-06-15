const DEFAULT_BRIDGE_BASE_URL = 'https://bridge.codeandpurrs.com';

export type UsageApp = {
  packageName: string;
  appName: string;
  foregroundMs: number;
  lastUsedAt?: string;
};

export type UsageSummary = {
  totalScreenMs: number;
  unlockCount: number;
  firstUsedAt?: string;
  lastUsedAt?: string;
};

export type UsagePayload = {
  schemaVersion: 1;
  owner: string;
  date: string;
  tz: string;
  generatedAt: string;
  summary: UsageSummary;
  apps: UsageApp[];
  hourly: number[];
};

export type UsageTrendPoint = {
  date: string;
  tz: string;
  totalScreenMs: number;
  unlockCount: number;
  generatedAt: string;
};

export type UsageFetchResult = {
  payload: UsagePayload | null;
  fetchedAt: string;
};

export type UsageTrendResult = {
  trend: UsageTrendPoint[];
  fetchedAt: string;
};

export type UsageHealth = {
  ok: boolean;
  service: string;
  storage: { ok: boolean; error?: string };
  tokenConfigured: boolean;
  retentionDays: number;
  checkedAt: string;
};

export type UsageHealthResult = {
  health: UsageHealth | null;
  fetchedAt: string;
};


function isDemoMode() {
  return import.meta.env.VITE_USAGE_BRIDGE_DEMO === '1';
}

function makeDemoHourly() {
  return Array.from({ length: 24 }, (_, hour) => {
    if (hour < 7) return 0;
    if (hour === 8) return 18 * 60 * 1000;
    if (hour === 10) return 32 * 60 * 1000;
    if (hour === 13) return 42 * 60 * 1000;
    if (hour === 16) return 26 * 60 * 1000;
    if (hour === 20) return 72 * 60 * 1000;
    if (hour === 21) return 48 * 60 * 1000;
    return hour > 7 && hour < 23 ? 8 * 60 * 1000 : 0;
  });
}

function getDemoPayload(): UsagePayload {
  return {
    schemaVersion: 1,
    owner: 'neko',
    date: '2026-06-13',
    tz: 'Asia/Kuching',
    generatedAt: new Date().toISOString(),
    summary: {
      totalScreenMs: 4 * 60 * 60 * 1000 + 36 * 60 * 1000,
      unlockCount: 37,
      firstUsedAt: '2026-06-13T08:12:00+08:00',
      lastUsedAt: '2026-06-13T22:18:00+08:00',
    },
    apps: [
      { packageName: 'com.whatsapp', appName: 'WhatsApp', foregroundMs: 68 * 60 * 1000, lastUsedAt: '2026-06-13T21:42:00+08:00' },
      { packageName: 'com.instagram.android', appName: 'Instagram', foregroundMs: 54 * 60 * 1000, lastUsedAt: '2026-06-13T20:55:00+08:00' },
      { packageName: 'com.codeandpurrs.app', appName: 'CodeAndPurrs', foregroundMs: 42 * 60 * 1000, lastUsedAt: '2026-06-13T22:18:00+08:00' },
      { packageName: 'com.spotify.music', appName: 'Spotify', foregroundMs: 36 * 60 * 1000, lastUsedAt: '2026-06-13T18:03:00+08:00' },
      { packageName: 'com.miui.notes', appName: 'Notes', foregroundMs: 21 * 60 * 1000, lastUsedAt: '2026-06-13T14:20:00+08:00' },
    ],
    hourly: makeDemoHourly(),
  };
}

function getDemoTrend(): UsageTrendPoint[] {
  const days = [
    ['2026-06-07', 3.2, 29],
    ['2026-06-08', 4.1, 35],
    ['2026-06-09', 2.7, 24],
    ['2026-06-10', 5.4, 44],
    ['2026-06-11', 3.8, 31],
    ['2026-06-12', 4.9, 39],
    ['2026-06-13', 4.6, 37],
  ] as const;

  return days.map(([date, hours, unlockCount]) => ({
    date,
    tz: 'Asia/Kuching',
    totalScreenMs: Math.round(hours * 60 * 60 * 1000),
    unlockCount,
    generatedAt: `${date}T22:18:00+08:00`,
  }));
}

export function isUsageBridgeDemoMode() {
  return isDemoMode();
}

export function getBridgeBaseUrl() {
  return (import.meta.env.VITE_USAGE_BRIDGE_BASE_URL ?? DEFAULT_BRIDGE_BASE_URL).replace(/\/$/, '');
}


export function buildUsageBridgeUrl(path: string, params: Record<string, string> = {}) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${getBridgeBaseUrl()}${normalizedPath}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}


function normalizeUsageHealth(value: unknown): UsageHealth | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawStorage = isRecord(value.storage) ? value.storage : {};

  return {
    ok: Boolean(value.ok),
    service: readString(value.service, 'neko-usage-bridge'),
    storage: {
      ok: Boolean(rawStorage.ok),
      error: readString(rawStorage.error),
    },
    tokenConfigured: Boolean(value.tokenConfigured),
    retentionDays: readNumber(value.retentionDays),
    checkedAt: readString(value.checkedAt),
  };
}

function normalizeUsagePayload(value: unknown): UsagePayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawPayload = isRecord(value.payload) ? value.payload : value;

  if (!isRecord(rawPayload) || rawPayload.schemaVersion !== 1) {
    return null;
  }

  const rawSummary = isRecord(rawPayload.summary) ? rawPayload.summary : {};
  const rawApps = Array.isArray(rawPayload.apps) ? rawPayload.apps : [];
  const rawHourly = Array.isArray(rawPayload.hourly) ? rawPayload.hourly : [];

  return {
    schemaVersion: 1,
    owner: readString(rawPayload.owner, 'neko'),
    date: readString(rawPayload.date),
    tz: readString(rawPayload.tz, 'Asia/Kuching'),
    generatedAt: readString(rawPayload.generatedAt),
    summary: {
      totalScreenMs: readNumber(rawSummary.totalScreenMs),
      unlockCount: readNumber(rawSummary.unlockCount),
      firstUsedAt: readString(rawSummary.firstUsedAt),
      lastUsedAt: readString(rawSummary.lastUsedAt),
    },
    apps: rawApps.filter(isRecord).map((app) => ({
      packageName: readString(app.packageName),
      appName: readString(app.appName, readString(app.packageName, 'Unknown app')),
      foregroundMs: readNumber(app.foregroundMs),
      lastUsedAt: readString(app.lastUsedAt),
    })),
    hourly: Array.from({ length: 24 }, (_, index) => readNumber(rawHourly[index])),
  };
}

function normalizeUsageTrend(value: unknown): UsageTrendPoint[] {
  if (!isRecord(value)) {
    return [];
  }

  const rawTrend = Array.isArray(value.trend) ? value.trend : [];

  return rawTrend.filter(isRecord).map((item) => ({
    date: readString(item.date),
    tz: readString(item.tz, 'Asia/Kuching'),
    totalScreenMs: readNumber(item.totalScreenMs),
    unlockCount: readNumber(item.unlockCount),
    generatedAt: readString(item.generatedAt),
  }));
}


export async function fetchUsageHealth(signal?: AbortSignal): Promise<UsageHealthResult> {
  if (isDemoMode()) {
    return {
      health: {
        ok: true,
        service: 'neko-usage-bridge-demo',
        storage: { ok: true },
        tokenConfigured: false,
        retentionDays: 0,
        checkedAt: new Date().toISOString(),
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  const url = new URL(buildUsageBridgeUrl('/api/usage/health'));
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Bridge health responded with HTTP ${response.status}`);
  }

  const data: unknown = await response.json();

  return {
    health: normalizeUsageHealth(data),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchLatestUsage(owner = 'neko', signal?: AbortSignal): Promise<UsageFetchResult> {
  if (isDemoMode()) {
    return { payload: { ...getDemoPayload(), owner }, fetchedAt: new Date().toISOString() };
  }

  const url = new URL(buildUsageBridgeUrl('/api/usage/latest', { owner }));

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (response.status === 404 || response.status === 204) {
    return { payload: null, fetchedAt: new Date().toISOString() };
  }

  if (!response.ok) {
    throw new Error(`Bridge responded with HTTP ${response.status}`);
  }

  const data: unknown = await response.json();

  return {
    payload: normalizeUsagePayload(data),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchUsageTrend(owner = 'neko', days = 7, signal?: AbortSignal): Promise<UsageTrendResult> {
  if (isDemoMode()) {
    return { trend: getDemoTrend().slice(-days), fetchedAt: new Date().toISOString() };
  }

  const url = new URL(buildUsageBridgeUrl('/api/usage/trend', { owner, days: String(days) }));

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (response.status === 404 || response.status === 204) {
    return { trend: [], fetchedAt: new Date().toISOString() };
  }

  if (!response.ok) {
    throw new Error(`Bridge trend responded with HTTP ${response.status}`);
  }

  const data: unknown = await response.json();

  return {
    trend: normalizeUsageTrend(data),
    fetchedAt: new Date().toISOString(),
  };
}

export function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

export function formatBridgeDate(value?: string) {
  if (!value) {
    return '等待日期';
  }

  const date = new Date(`${value}T00:00:00+08:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-Hans-MY', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Kuching',
  }).format(date);
}

export function formatBridgeTime(value?: string) {
  if (!value) {
    return '等待数据';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-Hans-MY', {
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kuching',
  }).format(date);
}

export function getUsageAgeMinutes(value?: string) {
  if (!value) {
    return null;
  }

  const generatedAt = new Date(value).getTime();

  if (Number.isNaN(generatedAt)) {
    return null;
  }

  return Math.round((Date.now() - generatedAt) / 60000);
}
