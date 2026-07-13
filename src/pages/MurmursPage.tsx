import { useEffect, useMemo, useRef, useState } from 'react';
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

// 真机验收反馈(2026-07-13)：花只能画在水面以下，背景图水面起始线约在屏幕
// 45% 高度处——WATER_LINE_PERCENT 留了 3% 余量，花的落点(含抖动)不会贴到
// 岸边/拱门/树梢那一侧。FAR/NEAR 是"远景(旧记忆)→近景(新记忆)"落点带，
// 都在水面线以下。
const WATER_LINE_PERCENT = 45;
const FAR_TOP_PERCENT = WATER_LINE_PERCENT + 3;
const NEAR_TOP_PERCENT = 90;

// 纵深透视：远景小、压扁多、略透明，模拟贴着水面看过去的视角；近景大、
// 压扁少、更实——两组区间由 position(0~1，远→近)插值，同一深度带内再按
// size(importance) 在区间内取值，重要的记忆即使在远景也能开得靠近上限。
const FAR_SIZE_PX: [number, number] = [20, 36];
const NEAR_SIZE_PX: [number, number] = [48, 72];
const FAR_SQUASH_Y = 0.65;
const NEAR_SQUASH_Y = 0.8;
const FAR_OPACITY = 0.78;
const NEAR_OPACITY = 1;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function perspectiveForFlower(flower: MurmursFlower) {
  const depthT = clamp01(flower.position); // 0=远(旧)，1=近(新)
  // importance(size 字段 0.4~1.0)在当前深度带内的相对位置，决定花开多大。
  const importanceT = clamp01((flower.size - 0.4) / 0.6);
  const bandMin = FAR_SIZE_PX[0] + depthT * (NEAR_SIZE_PX[0] - FAR_SIZE_PX[0]);
  const bandMax = FAR_SIZE_PX[1] + depthT * (NEAR_SIZE_PX[1] - FAR_SIZE_PX[1]);
  const sizePx = Math.round(bandMin + importanceT * (bandMax - bandMin));
  const squashY = FAR_SQUASH_Y + depthT * (NEAR_SQUASH_Y - FAR_SQUASH_Y);
  const opacity = FAR_OPACITY + depthT * (NEAR_OPACITY - FAR_OPACITY);
  return { depthT, sizePx, squashY, opacity };
}

// 横向"车道"布局：把画面分成几条车道，同屏花朵按 id 哈希稳定分配车道，
// 车道内部再按 position(远→近)从上到下排开——保证同屏(轮换后最多 12 朵)
// 彼此之间有基本间距，不会像之前那样二三十朵互相堆成一坨。
const LANES = 5;
const LANE_MARGIN_PERCENT = 10;

function laneIndexFor(id: string): number {
  return hashStr(`${id}-lane`) % LANES;
}

function laneCenterPercent(lane: number): number {
  const span = 100 - LANE_MARGIN_PERCENT * 2;
  return LANE_MARGIN_PERCENT + (span / LANES) * (lane + 0.5);
}

type FlowerLayout = { left: number; top: number };

function layoutVisibleFlowers(visible: MurmursFlower[]): Map<string, FlowerLayout> {
  const lanes = new Map<number, MurmursFlower[]>();
  for (const f of visible) {
    const lane = laneIndexFor(f.id);
    const group = lanes.get(lane);
    if (group) group.push(f);
    else lanes.set(lane, [f]);
  }
  const layout = new Map<string, FlowerLayout>();
  for (const [lane, group] of lanes) {
    group.sort((a, b) => a.position - b.position); // 同车道内远→近从上到下
    const n = group.length;
    group.forEach((f, i) => {
      const rankT = n > 1 ? i / (n - 1) : clamp01(f.position);
      const top = FAR_TOP_PERCENT + rankT * (NEAR_TOP_PERCENT - FAR_TOP_PERCENT);
      const jitterLeft = (hashStr(`${f.id}-x`) % 500) / 100 - 2.5; // ±2.5% 车道内小范围抖动
      layout.set(f.id, { left: laneCenterPercent(lane) + jitterLeft, top });
    });
  }
  return layout;
}

function FlowerBloom({
  flower,
  index,
  left,
  top,
  isExiting,
  onOpen,
}: {
  flower: MurmursFlower;
  index: number;
  left: number;
  top: number;
  isExiting: boolean;
  onOpen: (f: MurmursFlower) => void;
}) {
  const src = useMemo(
    () => pickAssetSrc(flower.valence, flower.arousal, flower.id),
    [flower.valence, flower.arousal, flower.id],
  );
  const { depthT, sizePx, squashY, opacity } = useMemo(() => perspectiveForFlower(flower), [flower]);
  // 水面自然漂浮的晃动幅度/周期，挂载时随机一次(不用稳定，参考 FloatingVehicle
  // 的做法)——跟落予棠的漂流物同一套"外层定位+内层浮动"结构：entrance 那个
  // translate 用在外层 button 上，idle bob 的 transform 用在内层 div 上，
  // 压扁(scaleY)用在最内层 img 上——三层各自一份 transform，互不覆盖。
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
      className={`murmurs-flower${isExiting ? ' murmurs-flower--exiting' : ''}`}
      style={
        {
          top: `${top}%`,
          left: `${left}%`,
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          opacity,
          pointerEvents: isExiting ? 'none' : 'auto',
          '--murmurs-drift-delay': `${Math.min(index * 90, 1600)}ms`,
        } as React.CSSProperties
      }
      onClick={() => onOpen(flower)}
      aria-label={flower.title}
    >
      <div
        className="murmurs-flower__reflection"
        style={{ opacity: 0.35 + depthT * 0.4 }}
        aria-hidden="true"
      />
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
        <img
          className="murmurs-flower__img"
          src={src}
          alt=""
          loading="lazy"
          style={{ transform: `scaleY(${squashY})` }}
        />
      </div>
    </button>
  );
}

// 密度控制：同屏最多 12 朵，花比 12 朵多时按 created_at 顺序轮换——每隔
// ROTATION_INTERVAL_MS 换掉最早入场的一朵(先淡出 EXIT_MS，动画播完再真正
// 摘掉)，同时按顺序请下一朵入场，循环往复，不会 30+ 朵同屏堆积。
const ROTATION_MAX_VISIBLE = 12;
const ROTATION_INTERVAL_MS = 5200;
const EXIT_MS = 850;

function useFlowerRotation(flowers: MurmursFlower[] | null) {
  const [visible, setVisible] = useState<MurmursFlower[]>([]);
  const [exitingId, setExitingId] = useState<string | null>(null);
  // visibleRef 跟 visible state 保持同步，供 setInterval/setTimeout 回调直接读写——
  // 不把"挑下一朵/推进 cursor"这类副作用塞进 setVisible 的 updater 函数里：
  // React 18 StrictMode 在开发环境会把 updater 函数双调用一次(用来抓这类不纯的
  // 用法)，副作用留在 updater 里就会被多算一次导致同屏数量对不上(实测踩过，
  // 轮换一轮后从 12 变 13)。副作用只放在 interval/timeout 回调本体里，不放
  // updater 里，才不受双调用影响。
  const visibleRef = useRef<MurmursFlower[]>([]);
  const cursorRef = useRef(0);

  useEffect(() => {
    if (!flowers) return;
    const initial = flowers.slice(0, Math.min(ROTATION_MAX_VISIBLE, flowers.length));
    visibleRef.current = initial;
    setVisible(initial);
    cursorRef.current = initial.length;
    setExitingId(null);
  }, [flowers]);

  useEffect(() => {
    if (!flowers || flowers.length <= ROTATION_MAX_VISIBLE) return; // 花不够 12 朵，用不着轮换
    const timer = window.setInterval(() => {
      const cur = visibleRef.current;
      if (cur.length === 0) return;
      const outgoing = cur[0];
      setExitingId(outgoing.id);
      window.setTimeout(() => {
        const rest = visibleRef.current.filter((f) => f.id !== outgoing.id);
        const total = flowers.length;
        let incoming = flowers[cursorRef.current % total];
        let tries = 0;
        // 花数量刚好比 12 多一点时，下一张可能撞上还在屏幕上的那朵——
        // 顺着往后找一张不在场上的，最多试一轮，避免死循环。
        while (rest.some((f) => f.id === incoming.id) && tries < total) {
          cursorRef.current += 1;
          incoming = flowers[cursorRef.current % total];
          tries += 1;
        }
        cursorRef.current += 1;
        const next = rest.some((f) => f.id === incoming.id) ? rest : [...rest, incoming];
        visibleRef.current = next;
        setVisible(next);
        setExitingId(null);
      }, EXIT_MS);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flowers]);

  return { visible, exitingId };
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
  const { visible, exitingId } = useFlowerRotation(flowers);
  const layout = useMemo(() => layoutVisibleFlowers(visible), [visible]);

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
        {visible.map((f, i) => {
          const pos = layout.get(f.id);
          if (!pos) return null;
          return (
            <FlowerBloom
              key={f.id}
              flower={f}
              index={i}
              left={pos.left}
              top={pos.top}
              isExiting={f.id === exitingId}
              onOpen={setSelected}
            />
          );
        })}

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
