import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

// 倾棠予梦 Step 2——接棠予酿记忆数据。后端 /api/murmurs/flowers 把日记记忆
// 映射成 {id,size,position,title,date,moodLabel,valence,arousal} 数组
// （60 秒内存缓存，详见 server/proxy.mjs），这里只管把这份数组画成溪流上
// 的漂浮花朵。花色不走关键词，改由 valence/arousal 连续计算——见下方。

type MurmursFlower = {
  id: string;
  size: number; // 0.4~1.0，来自 importance，越重要花越大
  position: number; // 0~1，按 created_at 排序：0=最旧/最远，1=最新/最近
  title: string;
  date: string | null;
  moodLabel?: string | null; // 纯文字心情词(平静/开心/伤心…)，弹出卡片用，不参与花色
  valence: number; // 实测约 -0.3~0.8，负=冷色调，正=暖色调
  arousal: number; // 实测约 0.3~0.75，越高饱和度/明度越强
};

// 花色改用连续色谱：valence 决定色相(冷→暖)，arousal 决定饱和度/明度。
// 32 张素材按肉眼估的 HSL 标了色标——不是量出来的像素值，只是"这朵花大概
// 长这个色系"的粗估，允许有偏差，上线后棠棠看到明显不对可以再调具体某一张。
// 色相刻意绕开纯绿(现有素材也没有绿花)，从冷的蓝紫一路转到暖的粉橙。
const FLOWER_COLOR_TAGS: Record<string, { h: number; s: number; l: number }> = {
  'flower-lily-lavender-bloom.webp': { h: 265, s: 40, l: 78 },
  'flower-lily-periwinkle-bloom-bud.webp': { h: 235, s: 45, l: 80 },
  'flower-lotus-gold-bloom.webp': { h: 40, s: 65, l: 72 },
  'flower-lotus-gold-bloom-bud.webp': { h: 35, s: 60, l: 76 },
  'flower-iris-bloom.webp': { h: 255, s: 50, l: 55 },
  'flower-iris-half-open.webp': { h: 250, s: 45, l: 62 },
  'flower-ranunculus-yellow-1.webp': { h: 48, s: 55, l: 80 },
  'flower-ranunculus-yellow-2.webp': { h: 45, s: 50, l: 84 },
  'flower-ranunculus-pink-1.webp': { h: 340, s: 55, l: 78 },
  'flower-ranunculus-pink-2.webp': { h: 335, s: 60, l: 76 },
  'flower-ranunculus-lilac-1.webp': { h: 280, s: 40, l: 78 },
  'flower-ranunculus-lilac-2.webp': { h: 275, s: 38, l: 80 },
  'flower-pansy-pink-1.webp': { h: 325, s: 55, l: 72 },
  'flower-pansy-pink-2.webp': { h: 330, s: 50, l: 76 },
  'flower-pansy-violet-1.webp': { h: 265, s: 50, l: 58 },
  'flower-pansy-violet-2.webp': { h: 260, s: 48, l: 62 },
  'flower-cosmos-blue-1.webp': { h: 205, s: 45, l: 80 },
  'flower-cosmos-blue-2.webp': { h: 210, s: 42, l: 82 },
  'flower-cosmos-cream-1.webp': { h: 42, s: 35, l: 88 },
  'flower-cosmos-cream-2.webp': { h: 38, s: 32, l: 90 },
  'flower-cosmos-lavender-1.webp': { h: 270, s: 35, l: 82 },
  'flower-cosmos-lavender-2.webp': { h: 268, s: 38, l: 80 },
  'flower-cosmos-pink-1.webp': { h: 345, s: 55, l: 80 },
  'flower-cosmos-pink-2.webp': { h: 350, s: 50, l: 82 },
  'flower-cosmos-white-1.webp': { h: 300, s: 10, l: 94 },
  'flower-cosmos-white-2.webp': { h: 30, s: 8, l: 95 },
  'flower-peony-pearl-white-1.webp': { h: 320, s: 15, l: 92 },
  'flower-peony-pearl-white-2.webp': { h: 40, s: 12, l: 93 },
  'flower-peony-pearl-lilac-1.webp': { h: 285, s: 35, l: 82 },
  'flower-peony-pearl-lilac-2.webp': { h: 280, s: 38, l: 80 },
  'flower-peony-pearl-blush-1.webp': { h: 15, s: 45, l: 84 },
  'flower-peony-pearl-blush-2.webp': { h: 10, s: 48, l: 82 },
};
const FLOWER_FILES = Object.keys(FLOWER_COLOR_TAGS);

// 空数据(还没有棠予酿记忆，或者 MCP/key 没配好)时的占位花——没有专门的
// "纯含苞"素材，半开的鸢尾花是现有素材里最接近"含苞待放"的一张，先顶上。
const PLACEHOLDER_BUD_SRC = 'flower-iris-half-open.webp';

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// valence(-0.3~0.8) → 色相：负值落在冷调蓝紫(约 225°)，正值转到暖调粉橙(约 20°/380°)，
// 走"蓝→靛→紫→品红→粉→橙"这条不经过绿色的路径。
function valenceToHue(valence: number): number {
  const [lo, hi] = [-0.3, 0.8];
  const t = Math.max(0, Math.min(1, (valence - lo) / (hi - lo)));
  return (225 + t * (380 - 225)) % 360;
}

// arousal(0.3~0.75) → 饱和度/明度：越平静(低)越浅淡柔和，越强烈(高)越饱和鲜亮。
function arousalToSatLight(arousal: number): { s: number; l: number } {
  const [lo, hi] = [0.3, 0.75];
  const t = Math.max(0, Math.min(1, (arousal - lo) / (hi - lo)));
  return { s: 25 + t * (70 - 25), l: 85 - t * (85 - 55) };
}

function hueCircularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 按 valence/arousal 算出目标色，找 32 张素材里色标最接近的几张，
// 再用 id 稳定哈希在候选里挑一张——同一条记忆刷新页面还是那张图，
// 同时同一片色系里仍有花色/花型的自然差异，不会所有花都长一个样。
function pickAssetSrc(valence: number, arousal: number, id: string): string {
  const targetHue = valenceToHue(valence);
  const { s: targetS, l: targetL } = arousalToSatLight(arousal);
  const ranked = FLOWER_FILES.map((file) => {
    const tag = FLOWER_COLOR_TAGS[file];
    const dh = hueCircularDist(tag.h, targetHue) / 180; // 0~1
    const ds = Math.abs(tag.s - targetS) / 100;
    const dl = Math.abs(tag.l - targetL) / 100;
    // 色相是 valence 的主要信号，权重给高一点；饱和度/明度权重相近。
    const dist = dh * 2 + ds * 0.6 + dl * 0.6;
    return { file, dist };
  }).sort((a, b) => a.dist - b.dist);
  const pool = ranked.slice(0, 5);
  const file = pool[hashStr(id) % pool.length].file;
  return `${import.meta.env.BASE_URL}assets/murmurs/${file}`;
}

const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 溪流纵向的"远→近"带：position=0(最旧)落在靠上的远景(接近水平线/上游)，
// position=1(最新)落在靠下的近景——呼应"旧记忆越飘越远、新记忆在眼前"。
const FAR_TOP_PERCENT = 20;
const NEAR_TOP_PERCENT = 84;

function FlowerBloom({ flower, index, onOpen }: { flower: MurmursFlower; index: number; onOpen: (f: MurmursFlower) => void }) {
  const src = useMemo(
    () => pickAssetSrc(flower.valence, flower.arousal, flower.id),
    [flower.valence, flower.arousal, flower.id],
  );
  const topPercent = FAR_TOP_PERCENT + flower.position * (NEAR_TOP_PERCENT - FAR_TOP_PERCENT);
  const jitterTop = (hashStr(`${flower.id}-y`) % 900) / 100 - 4.5; // ±4.5%
  const leftPercent = 8 + (hashStr(`${flower.id}-x`) % 8400) / 100; // 8%~92%
  // 参考落予棠漂流物的尺度(常规 72px/特殊 108px)，花朵别比那个还大——
  // size 0.4~1.0 → 约 46~68px，是"漂在水上的小东西"，不是贴纸大头。
  const sizePx = 30 + flower.size * 38;
  // 水面自然漂浮的晃动幅度/周期，挂载时随机一次(不用稳定，参考 FloatingVehicle
  // 的做法)——跟落予棠的漂流物同一套"外层定位+内层浮动"结构：entrance 那个
  // translate 用在外层 button 上，idle bob 的 transform 用在内层 div 上，
  // 两个 transform 各管各的，不会互相覆盖。
  const bob = useMemo(
    () => ({
      duration: 3400 + Math.random() * 2600,
      delay: -Math.random() * 5000,
      dx: 5 + Math.random() * 8,
      dy: 6 + Math.random() * 9,
      rot: 2 + Math.random() * 3,
    }),
    [],
  );

  return (
    <button
      type="button"
      className="murmurs-flower"
      style={
        {
          top: `${topPercent + jitterTop}%`,
          left: `${leftPercent}%`,
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          '--murmurs-drift-delay': `${Math.min(index * 90, 1600)}ms`,
        } as React.CSSProperties
      }
      onClick={() => onOpen(flower)}
      aria-label={flower.title}
    >
      <div
        className="murmurs-flower__bob"
        style={
          {
            animationDuration: `${bob.duration}ms`,
            animationDelay: `${bob.delay}ms`,
            '--mfdx': `${bob.dx}px`,
            '--mfdy': `${bob.dy}px`,
            '--mfrot': `${bob.rot}deg`,
          } as React.CSSProperties
        }
      >
        <img className="murmurs-flower__img" src={src} alt="" loading="lazy" />
      </div>
    </button>
  );
}

export function MurmursPage() {
  const [flowers, setFlowers] = useState<MurmursFlower[] | null>(null); // null = 加载中
  const [selected, setSelected] = useState<MurmursFlower | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/murmurs/flowers')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setFlowers(Array.isArray(data?.flowers) ? data.flowers : []);
      })
      .catch(() => {
        if (!cancelled) setFlowers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isEmpty = flowers !== null && flowers.length === 0;

  return (
    <main className="murmurs-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">倾棠予梦</span>
          <span className="chat-head__sub">Our Murmurs</span>
        </div>
      </header>

      <div className="murmurs-stream">
        {flowers?.map((f, i) => (
          <FlowerBloom key={f.id} flower={f} index={i} onOpen={setSelected} />
        ))}

        {isEmpty ? (
          <div
            className="murmurs-flower murmurs-flower--placeholder"
            style={{ top: '48%', left: '50%', width: '64px', height: '64px' }}
            aria-hidden="true"
          >
            <img
              className="murmurs-flower__img"
              src={`${import.meta.env.BASE_URL}assets/murmurs/${PLACEHOLDER_BUD_SRC}`}
              alt=""
            />
          </div>
        ) : null}
      </div>

      {selected ? (
        <div className="murmurs-detail-backdrop" onClick={() => setSelected(null)}>
          <div className="murmurs-detail" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="murmurs-detail__x"
              onClick={() => setSelected(null)}
              aria-label="关闭"
            >
              ×
            </button>
            {selected.moodLabel ? <span className="murmurs-detail__mood">{selected.moodLabel}</span> : null}
            <span className="murmurs-detail__title">{selected.title}</span>
            <span className="murmurs-detail__date">{fmtDate(selected.date)}</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}
