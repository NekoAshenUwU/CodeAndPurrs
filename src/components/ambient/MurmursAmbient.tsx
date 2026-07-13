import { useEffect, useRef } from 'react';

// 倾棠予梦的环境小生灵(2026-07-13 老婆批准的视觉新增)：蝴蝶 + 樱花瓣。
// 设计目标是"跟记忆花朵/涟漪发生关系"，不是单纯加会动的贴纸：
// - 蝴蝶：3 只 SVG 手绘蝴蝶(樱粉/薰衣草紫/湖水蓝，取色自背景图)，翅膀用
//   3D rotateY 扇动；沿随机弧线飞，偶尔俯身点水——落点真的荡开一圈 WebGL
//   涟漪(dropRipple 回调)；偶尔停在某朵记忆花上歇脚(getPerchTargets 给的
//   坐标)，歇脚时翅膀放慢慢扇，几秒后飞走。
// - 樱花瓣：从右上角樱花树那一带偶尔飘下一两片，左右摇曳着落到水面，
//   落点荡一小圈涟漪然后隐去。
// 全部位置由一个 rAF 循环驱动(3 蝴蝶+3 花瓣共 6 个元素的 transform，手机
// 无压力)；翅膀扇动是纯 CSS 动画不占 JS。prefers-reduced-motion 时整层
// 不启动也不显示(环境动效，跟焦散/星光同一条准则)。
//
// 蝴蝶/花瓣是运输中的"过客"，不需要像记忆花朵那样确定性——用 Math.random
// 没问题，刷新后飞的路线不同反而更像活物。

type DropRipple = (u: number, v: number, radiusScale?: number, strength?: number) => void;
type PerchTarget = { x: number; y: number };

// 取色自 murmurs-bg：樱粉(岸边花/樱花树)、薰衣草紫(远山/云)、湖水蓝(水面)。
const BFLY_PALETTES = [
  { a: '#f8c3da', b: '#ef9ec6', edge: '#e386b4', spot: '#fdeaf3' },
  { a: '#cdb6f0', b: '#ab90da', edge: '#977dc9', spot: '#f1e9fc' },
  { a: '#b3d3f2', b: '#93bae8', edge: '#7fa9dc', spot: '#ebf4fd' },
];
// 稍微收小一号(第八轮"太卡通"返工的一部分)：环境点缀不该比记忆花朵抢眼。
const BFLY_SIZES = [34, 29, 32];

// 水面/飞行区域(百分比坐标)，跟 MurmursPage 的 WATER_LINE_PERCENT=45 对齐：
// 蝴蝶可以飞进天空但主要绕着水面转；点水/花瓣落水只在水面线以下。
const FLY_X: [number, number] = [8, 92];
const FLY_Y: [number, number] = [28, 82];
const DIP_Y: [number, number] = [56, 86];
const PETAL_SPAWN_X: [number, number] = [66, 96]; // 右上角樱花树冠一带
const PETAL_SPAWN_Y: [number, number] = [6, 22];
const PETAL_LAND_Y: [number, number] = [58, 86];

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

type ButterflyState = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number; // %/秒
  mode: 'wander' | 'dip' | 'perch';
  pause: number; // 秒，>0 表示悬停/歇脚中
  phase: number; // 飞行时上下轻颤的相位
  el: HTMLElement;
  tiltEl: HTMLElement;
};

type PetalState = {
  t: number; // 秒，<0 表示还在树上等风
  dur: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sway: number;
  phase: number;
  rot0: number;
  rot1: number;
  el: HTMLElement;
};

function pickWander(b: ButterflyState) {
  b.mode = 'wander';
  b.tx = rand(FLY_X[0], FLY_X[1]);
  b.ty = rand(FLY_Y[0], FLY_Y[1]);
  b.speed = rand(6, 11);
}

function respawnPetal(p: PetalState, firstRound: boolean) {
  // firstRound 的等待短一点，进页面不用干等十几秒才见到第一片花瓣。
  p.t = -(firstRound ? rand(0.5, 4) : rand(1.5, 7));
  p.dur = rand(6, 9.5);
  p.x0 = rand(PETAL_SPAWN_X[0], PETAL_SPAWN_X[1]);
  p.y0 = rand(PETAL_SPAWN_Y[0], PETAL_SPAWN_Y[1]);
  p.x1 = p.x0 - rand(8, 26); // 往湖心(左)飘
  p.y1 = rand(PETAL_LAND_Y[0], PETAL_LAND_Y[1]);
  p.sway = rand(1.2, 3);
  p.phase = rand(0, Math.PI * 2);
  p.rot0 = rand(0, 360);
  p.rot1 = p.rot0 + rand(-540, 540);
}

export function MurmursAmbient({
  dropRipple,
  getPerchTargets,
}: {
  dropRipple: DropRipple;
  getPerchTargets: () => PerchTarget[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let rect = root.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      rect = root.getBoundingClientRect();
    });
    ro.observe(root);

    const bflies: ButterflyState[] = Array.from(
      root.querySelectorAll<HTMLElement>('.murmurs-bfly'),
    ).map((el) => {
      const b: ButterflyState = {
        x: rand(FLY_X[0], FLY_X[1]),
        y: rand(FLY_Y[0], FLY_Y[1]),
        tx: 0,
        ty: 0,
        speed: 8,
        mode: 'wander',
        pause: 0,
        phase: rand(0, Math.PI * 2),
        el,
        tiltEl: el.querySelector<HTMLElement>('.murmurs-bfly__tilt')!,
      };
      pickWander(b);
      return b;
    });

    const petals: PetalState[] = Array.from(
      root.querySelectorAll<HTMLElement>('.murmurs-petal'),
    ).map((el) => {
      const p = { el } as PetalState;
      respawnPetal(p, true);
      return p;
    });

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); // 卡顿帧封顶，别瞬移
      last = now;

      for (const b of bflies) {
        if (b.pause > 0) {
          b.pause -= dt;
          if (b.pause <= 0) {
            b.el.style.setProperty('--flap', `${Math.round(rand(300, 380))}ms`);
            pickWander(b);
          }
        } else {
          const dx = b.tx - b.x;
          const dy = b.ty - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1.5) {
            if (b.mode === 'dip') {
              // 点水！落一圈比手指轻得多的真涟漪，悬停一下再飞走。
              dropRipple(b.x / 100, b.y / 100, 0.8, 0.05);
              b.pause = 0.35;
            } else if (b.mode === 'perch') {
              // 停在花上歇脚：翅膀放慢慢扇。
              b.el.style.setProperty('--flap', '720ms');
              b.pause = rand(2.5, 5);
            } else {
              const r = Math.random();
              const targets = r >= 0.22 && r < 0.4 ? getPerchTargets() : [];
              if (r < 0.22) {
                b.mode = 'dip';
                b.tx = rand(FLY_X[0], FLY_X[1]);
                b.ty = rand(DIP_Y[0], DIP_Y[1]);
                b.speed = rand(7, 10);
              } else if (targets.length > 0) {
                const t = targets[Math.floor(Math.random() * targets.length)];
                b.mode = 'perch';
                b.tx = t.x;
                b.ty = t.y - 3; // 停在花冠上沿，不压在花心
                b.speed = rand(6, 9);
              } else {
                pickWander(b);
              }
            }
          } else {
            const ux = dx / dist;
            const uy = dy / dist;
            b.x += ux * b.speed * dt;
            // 飞行中上下轻颤——扇一下浮一下的那种起伏感。
            b.y += uy * b.speed * dt + Math.sin(now / 1000 * 7 + b.phase) * 1.6 * dt;
            const tilt = Math.max(-18, Math.min(18, uy * 22));
            const flip = ux < 0 ? -1 : 1;
            b.tiltEl.style.transform = `scaleX(${flip}) rotate(${(tilt * flip).toFixed(1)}deg)`;
          }
        }
        b.el.style.transform = `translate(${((b.x / 100) * rect.width).toFixed(1)}px, ${((b.y / 100) * rect.height).toFixed(1)}px) translate(-50%, -50%)`;
      }

      for (const p of petals) {
        p.t += dt;
        if (p.t < 0) {
          p.el.style.opacity = '0';
          continue;
        }
        const k = p.t / p.dur;
        if (k >= 1) {
          // 落水：一小圈涟漪，然后回树上等下一阵风。
          dropRipple(p.x1 / 100, p.y1 / 100, 0.55, 0.035);
          respawnPetal(p, false);
          p.el.style.opacity = '0';
          continue;
        }
        // 竖直方向轻微加速(飘落越来越快一点点)，水平方向匀速+左右摇曳。
        const ky = k * k * 0.3 + k * 0.7;
        const x = p.x0 + (p.x1 - p.x0) * k + Math.sin(k * 9 + p.phase) * p.sway * (1 - k * 0.4);
        const y = p.y0 + (p.y1 - p.y0) * ky;
        const rot = p.rot0 + (p.rot1 - p.rot0) * k;
        const opacity = k < 0.08 ? k / 0.08 : k > 0.9 ? (1 - k) / 0.1 : 1;
        p.el.style.opacity = opacity.toFixed(2);
        p.el.style.transform = `translate(${((x / 100) * rect.width).toFixed(1)}px, ${((y / 100) * rect.height).toFixed(1)}px) translate(-50%, -50%) rotate(${rot.toFixed(0)}deg)`;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [dropRipple, getPerchTargets]);

  return (
    <div className="murmurs-ambient" ref={rootRef} aria-hidden="true">
      {BFLY_PALETTES.map((pal, i) => (
        <div
          key={i}
          className="murmurs-bfly"
          style={
            {
              width: `${BFLY_SIZES[i]}px`,
              height: `${BFLY_SIZES[i]}px`,
              '--flap': `${300 + i * 40}ms`,
            } as React.CSSProperties
          }
        >
          <div className="murmurs-bfly__tilt">
            <ButterflyWing side="l" pal={pal} idx={i} />
            <ButterflyWing side="r" pal={pal} idx={i} />
            <svg className="murmurs-bfly__body" viewBox="0 0 20 100">
              <path
                d="M10 34 C7 22 3 14 0 8 M10 34 C13 22 17 14 20 8"
                stroke={pal.edge}
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
                opacity="0.75"
              />
              {/* 身体也走半透明琉璃质感，不再是实心色块 */}
              <ellipse cx="10" cy="60" rx="3" ry="26" fill={pal.edge} opacity="0.7" />
              <ellipse cx="10" cy="52" rx="1.6" ry="14" fill="#ffffff" opacity="0.55" />
            </svg>
          </div>
        </div>
      ))}
      {[0, 1, 2].map((i) => (
        <svg key={i} className="murmurs-petal" viewBox="0 0 24 24" style={{ width: `${11 + i * 2}px` }}>
          <defs>
            <linearGradient id={`murmursPetalG${i}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fbd9e8" />
              <stop offset="100%" stopColor="#f3a9ca" />
            </linearGradient>
          </defs>
          {/* 樱花瓣：泪滴形+顶端一个小凹口 */}
          <path
            d="M12 22 C4 16 3 8 7 4 C9 2 11 2.5 12 5 C13 2.5 15 2 17 4 C21 8 20 16 12 22 Z"
            fill={`url(#murmursPetalG${i})`}
          />
        </svg>
      ))}
    </div>
  );
}

// 单边翅膀：前翅+后翅两个瓣，渐变填充+珍珠色斑点。图形按左翅画(身体铰链
// 在 viewBox 右缘)，右翅在 SVG 内部用 <g scale(-1,1)> 镜像——一开始试过用
// CSS transform: scaleX(-1) 镜像，但扇动动画会整份接管 transform，把镜像
// 写进 keyframes 后 origin 在左缘的 scaleX(-1) 会把整个翅膀翻到身体左边、
// 跟左翅叠死(截图抓包)。镜像放进 SVG 里，CSS 动画就只剩纯 rotateY，
// 左右各一份符号相反的 keyframes(见 global.css)，绕各自贴身体的边开合。
function ButterflyWing({
  side,
  pal,
  idx,
}: {
  side: 'l' | 'r';
  pal: { a: string; b: string; edge: string; spot: string };
  idx: number;
}) {
  const gid = `murmursBflyG${idx}${side}`;
  return (
    <svg
      className={`murmurs-bfly__wing murmurs-bfly__wing--${side}`}
      viewBox="0 0 100 200"
      preserveAspectRatio="none"
    >
      <defs>
        {/* 琉璃翼(2026-07-13 真机反馈"太卡通了"返工)：贴身处几乎透白、越往
            翅尖颜色越透出来，全程半透明——让背景的湖光从翅膀里透过去，才能
            跟这张朦胧梦幻的背景融在一起。描边全部去掉(硬轮廓是"贴纸感"的
            最大来源)。 */}
        <linearGradient id={gid} x1="1" y1="0.1" x2="0" y2="0.7">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="45%" stopColor={pal.a} stopOpacity="0.78" />
          <stop offset="100%" stopColor={pal.b} stopOpacity="0.62" />
        </linearGradient>
        <filter id={`${gid}Glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <g transform={side === 'r' ? 'translate(100 0) scale(-1 1)' : undefined}>
        {/* 底层光晕：同形状模糊放一份在下面，翅膀像是自己在发一点微光 */}
        <g filter={`url(#${gid}Glow)`} opacity="0.45">
          <path d="M96 88 C92 40 70 6 36 4 C14 3 4 16 10 34 C18 56 52 78 96 88 Z" fill={pal.b} />
          <path
            d="M96 96 C64 98 40 108 32 126 C24 144 34 166 50 168 C58 169 60 178 56 186 C68 182 90 148 96 96 Z"
            fill={pal.b}
          />
        </g>
        {/* 前翅：斜向外上方舒展，翅尖略尖 */}
        <path
          d="M96 88 C92 40 70 6 36 4 C14 3 4 16 10 34 C18 56 52 78 96 88 Z"
          fill={`url(#${gid})`}
        />
        {/* 后翅：小一号，带一点垂尾 */}
        <path
          d="M96 96 C64 98 40 108 32 126 C24 144 34 166 50 168 C58 169 60 178 56 186 C68 182 90 148 96 96 Z"
          fill={`url(#${gid})`}
          opacity="0.9"
        />
        {/* 翅脉：从翅根放射出去的几根细白线，半透明——琉璃翼的"筋" */}
        <g stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.5">
          <path d="M92 84 C74 62 52 34 34 18" />
          <path d="M92 86 C70 72 46 54 26 40" />
          <path d="M92 100 C72 110 54 124 44 142" />
        </g>
        {/* 翅尖一点珠光，不再用卡通圆斑 */}
        <circle cx="30" cy="22" r="3.2" fill={pal.spot} opacity="0.85" />
        <circle cx="46" cy="150" r="2.6" fill={pal.spot} opacity="0.7" />
      </g>
    </svg>
  );
}
