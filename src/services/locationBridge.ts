// 「浪哪了」前端 ←→ VPS 定位接收端。复用 usage 桥接的 base + token。
const DEFAULT_BRIDGE_BASE_URL = 'https://api.nekopurrs.uk';
const BASE_URL = import.meta.env.VITE_USAGE_BRIDGE_BASE_URL ?? DEFAULT_BRIDGE_BASE_URL;
const TOKEN = import.meta.env.VITE_USAGE_BRIDGE_TOKEN ?? '';

export type LocationPoint = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  at: string;
};

export type LocationLatest = {
  owner: string;
  date: string;
  latest: LocationPoint | null;
  points: LocationPoint[];
  updatedAt?: string | null;
};

export async function ingestLocation(p: {
  lat: number;
  lng: number;
  accuracy?: number | null;
  owner?: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/location/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN },
      body: JSON.stringify({ owner: 'neko', ...p, at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchLocationLatest(owner = 'neko'): Promise<LocationLatest | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/location/latest?owner=${encodeURIComponent(owner)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data as LocationLatest) ?? null;
  } catch {
    return null;
  }
}
