import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

// 倾棠予梦 Step 2——接棠予酿记忆数据。后端 /api/murmurs/flowers 把日记记忆
// 映射成 {id,size,color,position,title,date,moodEmoji} 数组（60 秒内存缓存，
// 详见 server/proxy.mjs），这里只管把这份数组画成溪流上的漂浮花朵。

type MurmursFlower = {
  id: string;
  size: number; // 0.4~1.0，来自 importance，越重要花越大
  color: string; // 来自 mood/mood_emoji 的色系关键词
  position: number; // 0~1，按 created_at 排序：0=最旧/最远，1=最新/最近
  title: string;
  date: string | null;
  moodEmoji?: string | null;
};

// 色系关键词 → 素材池。花色关键词跟后端 MOOD_COLOR_MAP 手动对应，覆盖不到
// 的颜色一律落到薰衣草紫那一池（DEFAULT_POOL），不会因为没见过的颜色词
// 就漏画一朵花。同一色系里有好几种花/两种松紧状态，用 id 哈希稳定挑一张——
// 同一条记忆刷新页面还是那张图，不会一惊一乍地换脸。
const FLOWER_ASSET_POOLS: Record<string, string[]> = {
  pink: [
    'flower-cosmos-pink-1.webp',
    'flower-cosmos-pink-2.webp',
    'flower-ranunculus-pink-1.webp',
    'flower-ranunculus-pink-2.webp',
    'flower-pansy-pink-1.webp',
    'flower-pansy-pink-2.webp',
  ],
  blush: ['flower-peony-pearl-blush-1.webp', 'flower-peony-pearl-blush-2.webp'],
  gold: [
    'flower-lotus-gold-bloom.webp',
    'flower-lotus-gold-bloom-bud.webp',
    'flower-ranunculus-yellow-1.webp',
    'flower-ranunculus-yellow-2.webp',
    'flower-cosmos-cream-1.webp',
    'flower-cosmos-cream-2.webp',
  ],
  blue: ['flower-cosmos-blue-1.webp', 'flower-cosmos-blue-2.webp'],
  lavender: [
    'flower-lily-lavender-bloom.webp',
    'flower-cosmos-lavender-1.webp',
    'flower-cosmos-lavender-2.webp',
    'flower-peony-pearl-lilac-1.webp',
    'flower-peony-pearl-lilac-2.webp',
  ],
  white: [
    'flower-cosmos-white-1.webp',
    'flower-cosmos-white-2.webp',
    'flower-peony-pearl-white-1.webp',
    'flower-peony-pearl-white-2.webp',
  ],
  lilac: [
    'flower-ranunculus-lilac-1.webp',
    'flower-ranunculus-lilac-2.webp',
    'flower-pansy-violet-1.webp',
    'flower-pansy-violet-2.webp',
    'flower-iris-bloom.webp',
  ],
};
const DEFAULT_POOL = FLOWER_ASSET_POOLS.lavender;

// 空数据(还没有棠予酿记忆，或者 MCP/key 没配好)时的占位花——没有专门的
// "纯含苞"素材，半开的鸢尾花是现有素材里最接近"含苞待放"的一张，先顶上。
const PLACEHOLDER_BUD_SRC = 'flower-iris-half-open.webp';

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pickAssetSrc(color: string, id: string): string {
  const pool = FLOWER_ASSET_POOLS[color] ?? DEFAULT_POOL;
  const file = pool[hashStr(id) % pool.length];
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
  const src = useMemo(() => pickAssetSrc(flower.color, flower.id), [flower.color, flower.id]);
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
            {selected.moodEmoji ? <span className="murmurs-detail__mood">{selected.moodEmoji}</span> : null}
            <span className="murmurs-detail__title">{selected.title}</span>
            <span className="murmurs-detail__date">{fmtDate(selected.date)}</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}
