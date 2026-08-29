// 「浪哪了」前端 ←→ VPS 定位接收端。复用 usage 桥接的 base + token。
// 默认走【同源】（空字符串 = 相对路径）。
// 2026-08-29 之前默认是 https://api.nekopurrs.uk，读接口上锁之后那条路走不通了：
// 跨域的 401 挑战在 fetch 里不会弹密码框，只会静悄悄失败，页面就一直吃 demo 数据。
// 同源之后 fetch 默认就带凭据，跟站点共用一把锁。
// nginx 那边 nekopurrs.uk 有 /api/usage/ 和 /api/location/ 反代到 8788（见
// server/README-lock-reads.md）。要指回跨域就设 VITE_USAGE_BRIDGE_BASE_URL。
const DEFAULT_BRIDGE_BASE_URL = '';
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

// 把坐标尽量反查成人话地名（给猫咪聊「浪哪了」用）。失败就回 null，调用方自己回退坐标。
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=zh&lat=${lat}&lon=${lng}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const a = json?.address ?? {};
    // 挑几段最像「在哪」的：城市/区 + 街道/地点，太长的全名就不要了
    const parts = [
      a.city || a.town || a.county || a.state,
      a.suburb || a.district || a.neighbourhood,
      a.road || a.amenity || a.building,
    ].filter(Boolean);
    const short = Array.from(new Set(parts)).join(' · ');
    return short || (json?.display_name as string) || null;
  } catch {
    return null;
  }
}
