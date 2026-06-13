import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTimeOfDay } from '../components/ambient/timeOfDay';
import { usePrefersReducedMotion } from '../components/ambient/usePrefersReducedMotion';
import {
  fetchLatestUsage,
  fetchTrend,
  type TrendPoint,
  type UsageEnvelope,
  type UsageSession,
  type TrendResult,
} from '../services/usageBridge';

const MASCOT = `${import.meta.env.BASE_URL}assets/mascot/neko.png`;
const REFERENCE_MS = 6 * 3600000; // 活动环的柔性参考刻度：6 小时

// ---------- 小工具 ----------
function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}ᵐ`;
  return `${h}ʰ${String(m).padStart(2, '0')}ᵐ`;
}

function tzParts(iso: string, tz: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { h, m };
}

function tzClock(iso: string | undefined, tz: string): string {
  if (!iso) return '--:--';
  const { h, m } = tzParts(iso, tz);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function tzMinutes(iso: string, tz: string): number {
  const { h, m } = tzParts(iso, tz);
  return h * 60 + m;
}

const CATEGORIES = new Set(['social', 'work', 'entertainment', 'reading', 'tool']);
function catClass(category?: string | null): string {
  return category && CATEGORIES.has(category) ? `cat-${category}` : 'cat-other';
}

function relativeFromNow(iso: string | null): string {
  if (!iso) return '刚刚';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '刚刚';
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// 猫咪点评（本地启发式，v1 不依赖后端 AI）
function buildCommentary(env: UsageEnvelope): string {
  const { summary, tz, apps } = env.data;
  const mins = summary.totalForegroundMs / 60000;
  const lastHour = summary.lastUseAt ? tzParts(summary.lastUseAt, tz).h : 12;
  const top = apps[0];
  if (lastHour >= 0 && lastHour < 5) {
    return '都这个点了还盯着屏幕呀……快放下手机睡觉，我帮你把月亮看着 🌙';
  }
  if (mins > 360) {
    return `今天看了好久好久手机，记得抬头看看远方、揉揉眼睛嘛 🥺${top ? `（在${top.label}里待最久）` : ''}`;
  }
  if (mins < 90) {
    return '今天好克制呀，乖猫猫，给你贴一颗小星星 ⭐';
  }
  return `今天过得刚刚好~${top ? `${top.label}是你今天的最爱呢` : ''} 🐾`;
}

function mascotMood(ratio: number): { emoji: string; label: string } {
  if (ratio < 0.6) return { emoji: '😺', label: '晒太阳' };
  if (ratio < 1) return { emoji: '🙈', label: '捂眼睛' };
  return { emoji: '🫠', label: '装死' };
}

function bubbleText(category?: string | null): string {
  switch (category) {
    case 'social':
      return '在甜甜口袋待了好久呀~';
    case 'entertainment':
      return '刷得好开心，眼睛要休息一下哦~';
    case 'work':
      return '工作辛苦啦，记得喝口水 🍵';
    case 'reading':
      return '读了好久书，了不起 📖';
    default:
      return '这一段待了好久呢~';
  }
}

// ---------- 页面 ----------
export function PawTrailPage() {
  const navigate = useNavigate();
  const tod = useTimeOfDay();
  const reduced = usePrefersReducedMotion();
  const [owner] = useState<'neko' | 'ashen'>('neko');
  const [env, setEnv] = useState<UsageEnvelope | null>(null);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<UsageSession | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([fetchLatestUsage(owner), fetchTrend(owner, 7)])
      .then(([latest, t]) => {
        if (!alive) return;
        setEnv(latest);
        setTrend(t);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [owner]);

  if (loading) {
    return (
      <main className={`paw-page is-${tod}`}>
        <PawSky tod={tod} reduced={reduced} />
        <TopBar onBack={() => navigate('/')} />
        <div className="paw-loading">
          <span className="paw-loading__paw">🐾</span>
          <p>猫咪正在看你今天的足迹…</p>
        </div>
      </main>
    );
  }

  if (!env) {
    return (
      <main className={`paw-page is-${tod}`}>
        <PawSky tod={tod} reduced={reduced} />
        <TopBar onBack={() => navigate('/')} />
        <div className="paw-empty">
          <img src={MASCOT} alt="" className="paw-empty__cat" />
          <p>还没有爪印哦，等小红米第一次报到～</p>
          <span>把桥接 App 连上 api.nekopurrs.uk 就能看到足迹啦。</span>
        </div>
      </main>
    );
  }

  return (
    <PawTrailView
      env={env}
      trend={trend}
      tod={tod}
      reduced={reduced}
      selected={selected}
      onSelect={setSelected}
      onBack={() => navigate('/')}
    />
  );
}

function TopBar({ onBack }: { onBack: () => void }) {
  return (
    <header className="paw-top">
      <button type="button" className="paw-top__back" onClick={onBack} aria-label="回首页">
        ‹
      </button>
      <div className="paw-top__title">
        <span className="paw-top__cn">猫爪足迹</span>
        <span className="paw-top__en">Paw Trail</span>
      </div>
      <span className="paw-top__spacer" />
    </header>
  );
}

function PawSky({ tod, reduced }: { tod: string; reduced: boolean }) {
  const stars = useMemo(
    () =>
      Array.from({ length: 18 }, () => ({
        left: 2 + Math.random() * 96,
        top: 2 + Math.random() * 64,
        size: 1.4 + Math.random() * 2.4,
        duration: 2.4 + Math.random() * 4,
        delay: Math.random() * 4,
      })),
    [],
  );
  return (
    <div className="paw-sky" aria-hidden="true">
      <div className="paw-sky__photo" />
      <div className="paw-sky__tint" />
      {tod === 'night' && !reduced
        ? stars.map((s, i) => (
            <span
              key={i}
              className="paw-star"
              style={{
                left: `${s.left}%`,
                top: `${s.top}%`,
                width: `${s.size}px`,
                height: `${s.size}px`,
                animationDuration: `${s.duration}s`,
                animationDelay: `${s.delay}s`,
              }}
            />
          ))
        : null}
    </div>
  );
}

function PawTrailView({
  env,
  trend,
  tod,
  reduced,
  selected,
  onSelect,
  onBack,
}: {
  env: UsageEnvelope;
  trend: TrendResult | null;
  tod: string;
  reduced: boolean;
  selected: UsageSession | null;
  onSelect: (s: UsageSession | null) => void;
  onBack: () => void;
}) {
  const { data, meta, source } = env;
  const { summary, tz, apps, sessions } = data;

  const ratio = summary.totalForegroundMs / REFERENCE_MS;
  const ringPct = Math.min(ratio, 1);
  const mood = mascotMood(ratio);

  // 跟昨天比（trend 倒数第二天）
  const yesterday = trend && trend.data.length >= 2 ? trend.data[trend.data.length - 2] : null;
  const deltaMin = yesterday ? Math.round((summary.totalForegroundMs - yesterday.totalForegroundMs) / 60000) : null;

  const topApps = apps.slice(0, 5);
  const maxApp = topApps.length ? topApps[0].foregroundMs : 1;

  // 星河沙滩：最凶的一段（≥90min）冒气泡
  const heaviest = useMemo(() => {
    if (!sessions || !sessions.length) return null;
    let best: { s: UsageSession; mins: number } | null = null;
    for (const s of sessions) {
      const mins = (Date.parse(s.endAt) - Date.parse(s.startAt)) / 60000;
      if (mins >= 90 && (!best || mins > best.mins)) best = { s, mins };
    }
    return best?.s ?? null;
  }, [sessions]);

  const commentary = buildCommentary(env);

  const R = 86;
  const C = 2 * Math.PI * R;

  return (
    <main className={`paw-page is-${tod}`}>
      <PawSky tod={tod} reduced={reduced} />
      <TopBar onBack={onBack} />

      {source === 'demo' ? <div className="paw-note paw-note--demo">示例数据 · 桥接上线后自动替换</div> : null}
      {source === 'live' && meta.stale ? (
        <div className="paw-note paw-note--stale">数据更新于 {relativeFromNow(meta.lastIngestAt)}</div>
      ) : null}

      {/* ① 活动环 */}
      <section className="paw-card paw-ring-card">
        <svg className="paw-ring" viewBox="0 0 200 200" role="img" aria-label="今日使用时长">
          <defs>
            <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--iris)" />
              <stop offset="100%" stopColor="var(--sakura)" />
            </linearGradient>
          </defs>
          <circle className="paw-ring__track" cx="100" cy="100" r={R} />
          <circle
            className="paw-ring__fill"
            cx="100"
            cy="100"
            r={R}
            style={{
              strokeDasharray: C,
              strokeDashoffset: reduced ? C * (1 - ringPct) : undefined,
              ['--ring-c' as string]: C,
              ['--ring-off' as string]: C * (1 - ringPct),
            }}
          />
        </svg>
        <div className="paw-ring__center">
          <img src={MASCOT} alt="" className="paw-ring__cat" />
          <span className="paw-ring__mood" title={mood.label}>
            {mood.emoji}
          </span>
          <span className="paw-ring__time">{fmtDuration(summary.totalForegroundMs)}</span>
          <span className="paw-ring__label">今日</span>
        </div>
        {deltaMin !== null ? (
          <div className={`paw-delta ${deltaMin <= 0 ? 'is-less' : 'is-more'}`}>
            {deltaMin === 0 ? '和昨天一样' : deltaMin < 0 ? `比昨天少 ${-deltaMin}m 🐾` : `比昨天多 ${deltaMin}m`}
          </div>
        ) : null}
      </section>

      {/* ② 猫咪点评 */}
      <section className="paw-card paw-comment">
        <img src={MASCOT} alt="" className="paw-comment__avatar" />
        <p className="paw-comment__bubble">{commentary}</p>
      </section>

      {/* ③ 爪印榜 · 坐肉垫 */}
      <section className="paw-card">
        <h2 className="paw-h2">爪印榜</h2>
        <ul className="paw-apps">
          {topApps.map((app, i) => (
            <li className={`paw-app ${i === 0 ? 'is-top' : ''}`} key={app.package}>
              <span className={`paw-pad ${catClass(app.category)}`}>{app.label.slice(0, 1)}</span>
              <div className="paw-app__body">
                <div className="paw-app__row">
                  <span className="paw-app__name">{app.label}</span>
                  <span className="paw-app__dur">{fmtDuration(app.foregroundMs)}</span>
                </div>
                <div className="paw-app__bar">
                  <span
                    className={`paw-app__fill ${catClass(app.category)}`}
                    style={{ width: `${Math.max(8, (app.foregroundMs / maxApp) * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ④ 星河沙滩时间线 */}
      <section className="paw-card">
        <h2 className="paw-h2">一天的爪印 · 星河沙滩</h2>
        <div className="paw-river">
          {['夜', '晨', '午', '晚'].map((seg, i) => (
            <span className="paw-river__seg" key={seg} style={{ left: `${(i / 4) * 100}%` }}>
              {seg}
            </span>
          ))}
          <div className="paw-river__track">
            {sessions && sessions.length
              ? sessions.map((s, i) => {
                  const start = tzMinutes(s.startAt, tz);
                  let end = tzMinutes(s.endAt, tz);
                  if (end <= start) end = 1440;
                  const left = (start / 1440) * 100;
                  const width = Math.max(3, ((end - start) / 1440) * 100);
                  const night = tzParts(s.startAt, tz).h < 5;
                  return (
                    <button
                      type="button"
                      key={i}
                      className={`paw-step ${catClass(s.category)} ${night ? 'is-night' : ''} ${
                        selected === s ? 'is-active' : ''
                      }`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onSelect(selected === s ? null : s)}
                      aria-label={`${s.label ?? s.package} ${tzClock(s.startAt, tz)}`}
                    >
                      <span className="paw-step__paw">🐾</span>
                      {night ? <span className="paw-step__moon">🌙</span> : null}
                      {heaviest === s ? <span className="paw-step__bubble">{bubbleText(s.category)}</span> : null}
                    </button>
                  );
                })
              : data.hourly.map((m, h) => (
                  <span
                    className="paw-hourbar"
                    key={h}
                    style={{ left: `${(h / 24) * 100}%`, height: `${Math.min(100, m * 2.2)}%` }}
                    title={`${h}:00 · ${m}m`}
                  />
                ))}
          </div>
        </div>
        {selected ? (
          <div className="paw-river__detail">
            <span className={`paw-dot ${catClass(selected.category)}`} />
            <strong>{selected.label ?? selected.package}</strong>
            <span>
              {tzClock(selected.startAt, tz)}–{tzClock(selected.endAt, tz)} ·{' '}
              {fmtDuration(Date.parse(selected.endAt) - Date.parse(selected.startAt))}
            </span>
          </div>
        ) : (
          <p className="paw-river__hint">点一枚爪印看看那段在玩啥 · 凌晨的爪印带小月亮 🌙</p>
        )}
      </section>

      {/* ⑤ 这一周的脚步 */}
      {trend && trend.data.length ? (
        <section className="paw-card">
          <h2 className="paw-h2">这一周的脚步</h2>
          <TrendBars points={trend.data} todayDate={data.date} />
        </section>
      ) : null}

      {/* ⑥ 小指标 */}
      <section className="paw-chips">
        <span className="paw-chip">解锁 {summary.unlocks} 次 🔓</span>
        <span className="paw-chip">第一次拿起 {tzClock(summary.firstUseAt, tz)} 🌅</span>
        <span className="paw-chip">最后放下 {tzClock(summary.lastUseAt, tz)} 🌙</span>
        {summary.notifications != null ? <span className="paw-chip">通知 {summary.notifications} 条 🔔</span> : null}
      </section>

      <p className="paw-foot">ta 自愿分享的一天 · 只看不扰</p>
    </main>
  );
}

function TrendBars({ points, todayDate }: { points: TrendPoint[]; todayDate: string }) {
  const max = Math.max(...points.map((p) => p.totalForegroundMs), 1);
  return (
    <div className="paw-trend">
      {points.map((p) => {
        const day = new Date(`${p.date}T00:00:00+08:00`).getDay();
        const weekend = day === 0 || day === 6;
        return (
          <div className={`paw-trend__col ${p.date === todayDate ? 'is-today' : ''}`} key={p.date}>
            <div className="paw-trend__barwrap">
              <span
                className={`paw-trend__bar ${weekend ? 'is-weekend' : ''}`}
                style={{ height: `${Math.max(6, (p.totalForegroundMs / max) * 100)}%` }}
              />
            </div>
            <span className="paw-trend__day">{p.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
