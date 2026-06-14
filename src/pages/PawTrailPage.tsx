import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTimeOfDay } from '../components/ambient/timeOfDay';
import { usePrefersReducedMotion } from '../components/ambient/usePrefersReducedMotion';
import {
  fetchLatestUsage,
  fetchTrend,
  type TrendPoint,
  type UsageEnvelope,
  type TrendResult,
} from '../services/usageBridge';

const MASCOT = `${import.meta.env.BASE_URL}assets/mascot/neko.png`;
const PAW_HERO = `${import.meta.env.BASE_URL}assets/mascot/paw-hero.webp`;
const DAILY_GOAL_MS = 12 * 3600000; // 每日目标：满圈 = 12h（可配置）

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

// App 玻璃珠 Icon 的品牌色（低饱和莫兰迪版；真数据会带 iconBase64 显示真 logo）
const APP_COLOR: Record<string, string> = {
  'com.xingin.xhs': '#f7b8cf', // 小红书 粉
  'com.tencent.mm': '#9ed8b4', // 微信 绿
  'com.ss.android.ugc.aweme': '#bdb4ff', // 抖音 紫
  'com.openai.chatgpt': '#8fddd0', // ChatGPT 青
  'com.anthropic.claude': '#fbc59a', // Claude 橙
};
const CAT_COLOR: Record<string, string> = {
  social: '#f0bcd0',
  work: '#bdb4ff',
  entertainment: '#bdb4ff',
  reading: '#a6ccc2',
  tool: '#bfc3d0',
};
function appColor(pkg: string, category?: string | null): string {
  return APP_COLOR[pkg] ?? (category ? CAT_COLOR[category] : undefined) ?? '#c9c3d8';
}

// 进度条专用双色渐变（按 App 指定；时间字色与进度条不同色，见 CSS）
const APP_BAR: Record<string, [string, string]> = {
  'com.xingin.xhs': ['#f7b8cf', '#f09bc0'],
  'com.tencent.mm': ['#b8e8c7', '#8ed8af'],
  'com.ss.android.ugc.aweme': ['#cfc9ff', '#afa4ff'],
  'com.openai.chatgpt': ['#9fe2d7', '#67d0c3'],
  'com.anthropic.claude': ['#ffd3b8', '#f6b98a'],
};
function appBar(pkg: string): string | undefined {
  const g = APP_BAR[pkg];
  return g ? `linear-gradient(90deg, ${g[0]} 0%, ${g[1]} 100%)` : undefined;
}

// 占位字形：Claude 用放射星芒，避免和 ChatGPT 的「C」撞脸
const APP_GLYPH: Record<string, string> = {
  'com.anthropic.claude': '✦',
};
function appGlyph(pkg: string, label: string): string {
  return APP_GLYPH[pkg] ?? label.slice(0, 1);
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
  onBack,
}: {
  env: UsageEnvelope;
  trend: TrendResult | null;
  tod: string;
  reduced: boolean;
  onBack: () => void;
}) {
  const { data, meta, source } = env;
  const { summary, tz, apps } = data;

  // 跟昨天比（trend 倒数第二天）
  const yesterday = trend && trend.data.length >= 2 ? trend.data[trend.data.length - 2] : null;
  const deltaMin = yesterday ? Math.round((summary.totalForegroundMs - yesterday.totalForegroundMs) / 60000) : null;

  const topApps = apps.slice(0, 5);
  const maxApp = topApps.length ? topApps[0].foregroundMs : 1;

  const commentary = buildCommentary(env);

  // 进度环：弧长 = 今日时长 ÷ 每日目标(12h)，封顶满圈
  const RING_R = 86;
  const RING_C = 2 * Math.PI * RING_R;
  const ringPct = Math.min(summary.totalForegroundMs / DAILY_GOAL_MS, 1);
  const ringOff = RING_C * (1 - ringPct);
  const ringFull = ringPct >= 1;
  const ringVars = { ['--ring-c' as string]: RING_C, ['--ring-off' as string]: ringOff };

  return (
    <main className={`paw-page is-${tod}`}>
      <PawSky tod={tod} reduced={reduced} />
      <TopBar onBack={onBack} />

      {source === 'demo' ? <div className="paw-note paw-note--demo">示例数据 · 桥接上线后自动替换</div> : null}
      {source === 'live' && meta.stale ? (
        <div className="paw-note paw-note--stale">数据更新于 {relativeFromNow(meta.lastIngestAt)}</div>
      ) : null}

      {/* ① 活动环 · 真·进度环(目标12h,果冻管状) */}
      <section className="paw-card paw-ring-card">
        <svg className={`paw-ring ${ringFull ? 'is-full' : ''}`} viewBox="0 0 200 200" aria-hidden="true">
          <defs>
            <linearGradient id="pawRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f3bcd4" />
              <stop offset="50%" stopColor="#c9b8ef" />
              <stop offset="100%" stopColor="#bcd4f6" />
            </linearGradient>
          </defs>
          <circle className="paw-ring__track" cx="100" cy="100" r={RING_R} />
          <circle
            className="paw-ring__fill"
            cx="100"
            cy="100"
            r={RING_R}
            style={{ strokeDasharray: RING_C, strokeDashoffset: reduced ? ringOff : undefined, ...ringVars }}
          />
        </svg>
        <div className="paw-ring__center" role="img" aria-label="今日使用时长">
          <img src={PAW_HERO} alt="" className="paw-ring__cat" />
          <span className="paw-ring__time">{fmtDuration(summary.totalForegroundMs)}</span>
          <span className="paw-ring__label">今日</span>
        </div>
        {deltaMin !== null ? (
          <div className={`paw-delta ${deltaMin <= 0 ? 'is-less' : 'is-more'}`}>
            <span className="paw-delta__paw">🐾</span>
            {deltaMin === 0 ? '和昨天一样' : deltaMin < 0 ? `比昨天少 ${-deltaMin}m` : `比昨天多 ${deltaMin}m`}
          </div>
        ) : null}
      </section>

      {/* ② 猫咪点评 */}
      <section className="paw-card paw-comment">
        <img src={MASCOT} alt="" className="paw-comment__avatar" />
        <p className="paw-comment__bubble">{commentary}</p>
      </section>

      {/* ③ 爪印榜 */}
      <section className="paw-card">
        <div className="paw-h2wrap">
          <h2 className="paw-h2">爪印榜</h2>
          <p className="paw-sub">✦ 记着每一步，遇见更好的自己 ✦</p>
        </div>
        <ul className="paw-apps">
          {topApps.map((app, i) => (
            <li
              className={`paw-app ${i === 0 ? 'is-top' : ''}`}
              key={app.package}
              style={{ ['--cc' as string]: appColor(app.package, app.category) }}
            >
              <span className="paw-tile">
                {app.iconBase64 ? <img src={app.iconBase64} alt="" /> : appGlyph(app.package, app.label)}
              </span>
              <div className="paw-app__body">
                <div className="paw-app__row">
                  <span className="paw-app__name">{app.label}</span>
                  <span className="paw-app__dur">{fmtDuration(app.foregroundMs)}</span>
                </div>
                <div className="paw-app__bar">
                  <span
                    className="paw-app__fill"
                    style={{
                      width: `${Math.max(8, (app.foregroundMs / maxApp) * 100)}%`,
                      background: appBar(app.package),
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ④ 这一周的脚步 + 小指标 */}
      {trend && trend.data.length ? (
        <section className="paw-card">
          <h2 className="paw-h2">这一周的脚步</h2>
          <TrendBars points={trend.data} todayDate={data.date} />
          <div className="paw-chips">
            <span className="paw-chip">解锁 {summary.unlocks} 次 🔓</span>
            <span className="paw-chip">第一次拿起 {tzClock(summary.firstUseAt, tz)} 🌅</span>
            <span className="paw-chip">最后放下 {tzClock(summary.lastUseAt, tz)} 🌙</span>
            {summary.notifications != null ? <span className="paw-chip">通知 {summary.notifications} 条 🔔</span> : null}
          </div>
        </section>
      ) : null}

      <p className="paw-foot">ta 自愿分享的一天 · 只看不扰</p>
    </main>
  );
}

// 七根柱子各取图二莫兰迪马卡龙一色的「浅→深」渐变（浅端也带饱和度，不发白）
const TREND_GRADS: Array<[string, string]> = [
  ['#cdb6e6', '#b294d2'], // 薰衣草
  ['#f3bcd2', '#e89bbe'], // 藕粉
  ['#f8c4b2', '#f2a48d'], // 蜜桃
  ['#fbe3a6', '#f5d27e'], // 柠黄
  ['#f8d3bb', '#f0bb9b'], // 浅杏
  ['#c2e6ed', '#9bd2de'], // 浅天蓝
  ['#93cfd4', '#67bdc8'], // 青碧
];

function TrendBars({ points, todayDate }: { points: TrendPoint[]; todayDate: string }) {
  const max = Math.max(...points.map((p) => p.totalForegroundMs), 1);
  const n = points.length;
  const heightPct = (p: TrendPoint) => Math.max(6, (p.totalForegroundMs / max) * 100);
  // 柱顶连成星座线（坐标用百分比，覆盖在柱状之上）
  const nodes = points.map((p, i) => ({ x: ((i + 0.5) / n) * 100, y: 100 - heightPct(p) }));
  const poly = nodes.map((nd) => `${nd.x.toFixed(2)},${nd.y.toFixed(2)}`).join(' ');
  return (
    <div className="paw-trend">
      <svg className="paw-trend__sky" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline className="paw-trend__line" points={poly} />
        {nodes.map((nd, i) => (
          <circle key={i} className="paw-trend__starpt" cx={nd.x} cy={nd.y} r="1.1" />
        ))}
      </svg>
      {points.map((p, i) => {
        const [light, deep] = TREND_GRADS[i % TREND_GRADS.length];
        return (
          <div className={`paw-trend__col ${p.date === todayDate ? 'is-today' : ''}`} key={p.date}>
            <div className="paw-trend__barwrap">
              <span
                className="paw-trend__bar"
                style={{ height: `${heightPct(p)}%`, background: `linear-gradient(180deg, ${light} 0%, ${deep} 100%)` }}
              >
                <i className="paw-trend__paw" />
              </span>
            </div>
            <span className="paw-trend__day">{p.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
