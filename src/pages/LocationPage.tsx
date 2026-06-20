import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ingestLocation, fetchLocationLatest, type LocationLatest } from '../services/locationBridge';

// 初始视角：吉隆坡（拿到真实定位后会跳过去）
const MAP_DEFAULT: [number, number] = [3.139, 101.6869];

type Status = 'idle' | 'locating' | 'ok' | 'error';

export function LocationPage() {
  const navigate = useNavigate();
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapObj = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [msg, setMsg] = useState('');
  const [latest, setLatest] = useState<LocationLatest | null>(null);
  const [auto, setAuto] = useState(false);

  // 初始化地图（OpenStreetMap，免费无 key）
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;
    const map = L.map(mapRef.current).setView(MAP_DEFAULT, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);
    mapObj.current = map;
    return () => {
      map.remove();
      mapObj.current = null;
      markerRef.current = null;
      lineRef.current = null;
    };
  }, []);

  function draw(data: LocationLatest) {
    const map = mapObj.current;
    if (!map || !data.latest) return;
    const here: [number, number] = [data.latest.lat, data.latest.lng];
    if (!markerRef.current) {
      markerRef.current = L.marker(here, {
        icon: L.divIcon({ className: 'loc-pin', html: '🐾', iconSize: [36, 36], iconAnchor: [18, 18] }),
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(here);
    }
    const pts = data.points.map((p) => [p.lat, p.lng] as [number, number]);
    if (!lineRef.current) {
      lineRef.current = L.polyline(pts, { color: '#b9a4e8', weight: 4, opacity: 0.75 }).addTo(map);
    } else {
      lineRef.current.setLatLngs(pts);
    }
    map.setView(here, 15);
  }

  async function load() {
    const data = await fetchLocationLatest('neko');
    if (data) {
      setLatest(data);
      draw(data);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function share() {
    if (!('geolocation' in navigator)) {
      setStatus('error');
      setMsg('这台设备不支持定位');
      return;
    }
    setStatus('locating');
    setMsg('正在定位…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const ok = await ingestLocation({ lat, lng, accuracy });
        if (ok) {
          setStatus('ok');
          setMsg(`已分享 · 误差约 ${Math.round(accuracy)} 米`);
          await load();
        } else {
          setStatus('error');
          setMsg('上传失败（检查 token / 网络）');
        }
      },
      (err) => {
        setStatus('error');
        setMsg(err.code === 1 ? '定位权限被拒绝了' : err.code === 3 ? '定位超时，再试一次' : '拿不到定位');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  }

  // 「打开时持续更新」：每 60 秒自动分享一次
  useEffect(() => {
    if (!auto) return;
    share();
    const id = window.setInterval(share, 60000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return (
    <div className="loc-page">
      <header className="loc-head">
        <button className="loc-back" onClick={() => navigate('/')} aria-label="返回">‹</button>
        <h1>浪哪了</h1>
        <p>✦ ta 自愿分享的此刻 · 只看不扰 ✦</p>
      </header>

      <div ref={mapRef} className="loc-map" />

      <div className="loc-bar">
        <button className="loc-share" onClick={share} disabled={status === 'locating'}>
          {status === 'locating' ? '定位中…' : '📍 分享我的位置'}
        </button>
        <label className="loc-auto">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          打开时持续更新
        </label>
      </div>

      {msg && <p className={`loc-msg is-${status}`}>{msg}</p>}

      {latest?.latest && (
        <div className="loc-info">
          <div>📍 最近一次：{new Date(latest.latest.at).toLocaleString()}</div>
          <div>🧭 坐标：{latest.latest.lat.toFixed(5)}, {latest.latest.lng.toFixed(5)}</div>
          <div>🐾 今日记录点：{latest.points.length} 个</div>
        </div>
      )}
    </div>
  );
}
