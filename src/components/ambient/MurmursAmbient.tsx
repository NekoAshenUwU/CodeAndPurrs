import { useEffect, useRef } from 'react';

// 倾棠予梦的环境小生灵：蝴蝶 + 樱花瓣。
// 蝴蝶第九轮(2026-07-14)：老婆发来"Dream Butterflies Dynamic Deluxe"素材包，
// 之前手绘的 SVG 琉璃翼整个删掉，画面全部换成她给的三张【自带扇翅逐帧动画
// 的 webp】(冰蓝/蜜桃粉/月光薰衣草)——扇翅膀不再靠 CSS rotateY，图自己会动。
// 从她那份展示 HTML 里一并移植了：柔白+彩光的双层辉光(呼吸式明暗)、
// 飞行时的闪粉尾迹(mote)、偶尔一颗 ✦ 小星星。
// 【没有】移植它的假 CSS 椭圆涟漪——咱们有真的 WebGL 涟漪：
// 蝴蝶的独有行为不变：偶尔俯身点水(落点荡开一圈真涟漪 dropRipple)、
// 偶尔停在某朵记忆花上歇脚(getPerchTargets)几秒再飞走。
// 樱花瓣不变：右上角樱花树偶尔飘一两片，落水一小圈涟漪。
// 全部位置一个 rAF 循环驱动；prefers-reduced-motion 时整层不启动不显示。

type DropRipple = (u: number, v: number, radiusScale?: number, strength?: number) => void;
type PerchTarget = { x: number; y: number };

// 三只蝴蝶的配置基本照搬素材包展示页(辉光/闪粉/星星配色是配好的一套)，
// 只有尺寸整体缩小——展示页是全屏空景可以放 98~156px，咱们页面近景记忆花
// 上限才 96px，蝴蝶是点缀不能比花大。
const BUTTERFLIES = [
  {
    src: 'ice_blue_flap.webp',
    size: 80,
    glow: 'rgba(146, 193, 255, 0.55)',
    spark: 'rgba(198, 229, 255, 0.95)',
    star: '#fff3c7',
    starGlow: 'rgba(255, 213, 115, 0.72)',
  },
  {
    src: 'peach_pink_flap.webp',
    size: 66,
    glow: 'rgba(255, 160, 218, 0.48)',
    spark: 'rgba(255, 219, 240, 0.92)',
    star: '#ffe6bb',
    starGlow: 'rgba(255, 188, 132, 0.68)',
  },
  {
    src: 'moon_lavender_flap.webp',
    size: 58,
    glow: 'rgba(188, 162, 255, 0.52)',
    spark: 'rgba(231, 213, 255, 0.95)',
    star: '#fff0c2',
    starGlow: 'rgba(246, 206, 125, 0.60)',
  },
];

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
  phase: number; // 飞行起伏/侧倾的相位
  lastSpark: number; // 上次撒闪粉的时间戳(ms)
  lastDust: number; // 上次撒金粉的时间戳(ms)
  lastStar: number; // 上次掉小星星的时间戳(ms)
  spark: string;
  star: string;
  starGlow: string;
  el: HTMLElement;
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

    // 闪粉/小星星是"发射后不管"的一次性元素：CSS 动画播完 setTimeout 摘掉。
    // 频率被压得比素材包展示页低一截(那边每只 86ms 一颗、还有金尘/光环共
    // 五种粒子)——咱们页面底下已经跑着 WebGL 涟漪，粒子只留最出效果的两种，
    // 手机别过载。
    const spawnMote = (xPct: number, yPct: number, spark: string) => {
      const el = document.createElement('i');
      el.className = 'murmurs-mote';
      el.style.left = `${((xPct / 100) * rect.width).toFixed(1)}px`;
      el.style.top = `${((yPct / 100) * rect.height).toFixed(1)}px`;
      el.style.setProperty('--spark', spark);
      el.style.setProperty('--dx', `${rand(-9, 9).toFixed(1)}px`);
      el.style.setProperty('--dy', `${rand(12, 30).toFixed(1)}px`);
      const dur = rand(700, 1100);
      el.style.setProperty('--dur', `${dur.toFixed(0)}ms`);
      root.appendChild(el);
      window.setTimeout(() => el.remove(), dur + 100);
    };
    // 金粉(素材包展示页的 goldFall"金尘")：暖金色小光点从蝴蝶身下往下飘落，
    // 跟冷色系的闪粉(mote)一暖一冷。第九轮先砍了怕手机过载，老婆点名要
    // ("还会撒金粉和星星")——加回来，频率仍比展示页低。
    const spawnDust = (xPct: number, yPct: number) => {
      const el = document.createElement('i');
      el.className = 'murmurs-dust';
      el.style.left = `${((xPct / 100) * rect.width).toFixed(1)}px`;
      el.style.top = `${((yPct / 100) * rect.height).toFixed(1)}px`;
      const size = rand(2.8, 5.2);
      el.style.width = `${size.toFixed(1)}px`;
      el.style.height = `${size.toFixed(1)}px`;
      el.style.setProperty('--dx', `${rand(-16, 16).toFixed(1)}px`);
      el.style.setProperty('--dy', `${rand(8, 24).toFixed(1)}px`); // 轻轻飘散，不再直坠
      const dur = rand(900, 1400);
      el.style.setProperty('--dur', `${dur.toFixed(0)}ms`);
      root.appendChild(el);
      window.setTimeout(() => el.remove(), dur + 100);
    };
    const spawnStar = (xPct: number, yPct: number, star: string, starGlow: string) => {
      const el = document.createElement('i');
      el.className = 'murmurs-star';
      el.textContent = Math.random() < 0.6 ? '✦' : '✧';
      el.style.left = `${((xPct / 100) * rect.width).toFixed(1)}px`;
      el.style.top = `${((yPct / 100) * rect.height).toFixed(1)}px`;
      el.style.setProperty('--star', star);
      el.style.setProperty('--starGlow', starGlow);
      el.style.setProperty('--dx', `${rand(-11, 11).toFixed(1)}px`);
      el.style.setProperty('--dy', `${rand(14, 32).toFixed(1)}px`);
      const dur = rand(900, 1300);
      el.style.setProperty('--dur', `${dur.toFixed(0)}ms`);
      root.appendChild(el);
      window.setTimeout(() => el.remove(), dur + 100);
    };

    const bflies: ButterflyState[] = Array.from(
      root.querySelectorAll<HTMLElement>('.murmurs-bfly'),
    ).map((el, i) => {
      const cfg = BUTTERFLIES[i % BUTTERFLIES.length];
      const b: ButterflyState = {
        x: rand(FLY_X[0], FLY_X[1]),
        y: rand(FLY_Y[0], FLY_Y[1]),
        tx: 0,
        ty: 0,
        speed: 8,
        mode: 'wander',
        pause: 0,
        phase: rand(0, Math.PI * 2),
        lastSpark: 0,
        lastDust: 0,
        lastStar: performance.now() + i * 900,
        spark: cfg.spark,
        star: cfg.star,
        starGlow: cfg.starGlow,
        el,
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
        let moving = false;
        if (b.pause > 0) {
          b.pause -= dt;
          if (b.pause <= 0) pickWander(b);
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
              // 停在花上歇脚几秒(webp 的扇翅是烧在图里的，歇脚时也轻轻扇)。
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
            moving = true;
            const ux = dx / dist;
            const uy = dy / dist;
            b.x += ux * b.speed * dt;
            // 飞行中上下轻颤——扇一下浮一下的那种起伏感。
            b.y += uy * b.speed * dt + Math.sin((now / 1000) * 7 + b.phase) * 1.6 * dt;
          }
        }
        // 侧倾(bank)照搬素材包展示页的味道：飞着的时候左右轻轻摆，素材是
        // 俯视对称构图，靠小角度倾斜就有"迎风转向"的感觉，不用翻转。
        const bank = Math.sin((now / 1000) * 1.65 + b.phase) * (moving ? 9 : 4);
        b.el.style.transform = `translate(${((b.x / 100) * rect.width).toFixed(1)}px, ${((b.y / 100) * rect.height).toFixed(1)}px) translate(-50%, -50%) rotate(${bank.toFixed(1)}deg)`;

        // 闪粉尾迹只在飞行时撒；歇脚/悬停时偶尔还掉一颗小星星(更安静)。
        if (moving && now - b.lastSpark > 210) {
          b.lastSpark = now;
          spawnMote(b.x + rand(-2, 2), b.y + rand(-1.5, 1.5), b.spark);
        }
        if (moving && now - b.lastDust > 320) {
          b.lastDust = now;
          // 从翅膀两侧散开(左右偏移大、上下贴平)——原来写的"身下洒落"配上
          // 偏棕的金色被真机验收判定像大便😂，动线和颜色一起改。
          spawnDust(b.x + rand(-3.5, 3.5), b.y + rand(-1, 1));
        }
        if (now - b.lastStar > 2600) {
          b.lastStar = now + rand(0, 600);
          spawnStar(b.x + rand(-3, 3), b.y + rand(-2, 2), b.star, b.starGlow);
        }
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
      {BUTTERFLIES.map((cfg, i) => (
        <img
          key={i}
          className="murmurs-bfly"
          src={`${import.meta.env.BASE_URL}assets/butterflies/${cfg.src}`}
          alt=""
          style={
            {
              width: `${cfg.size}px`,
              height: `${cfg.size}px`,
              '--glow': cfg.glow,
              '--glowDur': `${4.4 + i * 0.5}s`,
            } as React.CSSProperties
          }
        />
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
