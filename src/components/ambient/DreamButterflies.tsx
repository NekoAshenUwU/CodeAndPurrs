import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// 老婆发的"Dream Butterflies Deluxe"效果移植版。原版是一个独立 HTML demo
// (纯 DOM + rAF，没用 canvas/WebGL)，这里按她的要求只保留四种效果：蝴蝶、
// 金粉(dust)、星屑(star)、涟漪(ripple)——原版还有的白色光点尾迹(mote)和
// 光晕环(ring)、背景环境色调层(ambient)按她的要求砍掉了，逻辑保持跟原版
// 一致(Catmull-Rom 样条走位、呼吸光晕、成群生成/自动清理)，只是从原版
// document.getElementById('stage') 单例写法改成了组件化：接收一个容器 ref，
// 用它自己的 getBoundingClientRect 当画布尺寸(不是 window.innerWidth/Height)，
// 这样才是"根据挂载的页面尺寸自适应"而不是整个浏览器窗口。

type ButterflyConfig = {
  src: string;
  size: number;
  glow: string;
  starColor: string;
  starGlow: string;
  duration: number;
  phase: number;
  hero?: boolean;
  glowDur: string;
  route: [number, number][];
};

const BASE = import.meta.env.BASE_URL;

const CONFIGS: ButterflyConfig[] = [
  {
    src: `${BASE}assets/effects/ice_blue_flap.webp`,
    size: 156,
    glow: 'rgba(146,193,255,.56)',
    starColor: '#fff3c7',
    starGlow: 'rgba(255,213,115,.72)',
    duration: 21000,
    phase: 0.06,
    hero: true,
    glowDur: '4.8s',
    route: [[-0.1, 0.72], [0.14, 0.54], [0.32, 0.19], [0.55, 0.26], [0.84, 0.48], [1.08, 0.26], [0.72, 0.72], [0.28, 0.87]],
  },
  {
    src: `${BASE}assets/effects/peach_pink_flap.webp`,
    size: 126,
    glow: 'rgba(255,160,218,.48)',
    starColor: '#ffe6bb',
    starGlow: 'rgba(255,188,132,.68)',
    duration: 25000,
    phase: 0.34,
    glowDur: '5.2s',
    route: [[0.02, 0.18], [0.3, 0.08], [0.58, 0.3], [0.9, 0.16], [1.08, 0.56], [0.66, 0.84], [0.2, 0.68], [-0.08, 0.34]],
  },
  {
    src: `${BASE}assets/effects/moon_lavender_flap.webp`,
    size: 98,
    glow: 'rgba(188,162,255,.52)',
    starColor: '#fff0c2',
    starGlow: 'rgba(246,206,125,.6)',
    duration: 19800,
    phase: 0.7,
    glowDur: '4.6s',
    route: [[0.92, 0.88], [0.74, 0.68], [0.56, 0.28], [0.2, 0.16], [-0.1, 0.48], [0.22, 0.84], [0.62, 0.74], [1.1, 0.42]],
  },
  {
    src: `${BASE}assets/effects/ice_blue_flap.webp`,
    size: 72,
    glow: 'rgba(146,193,255,.40)',
    starColor: '#fff6d1',
    starGlow: 'rgba(255,224,145,.52)',
    duration: 28000,
    phase: 0.82,
    glowDur: '6s',
    route: [[0.12, 0.88], [0.34, 0.74], [0.44, 0.56], [0.6, 0.52], [0.84, 0.62], [1.06, 0.76], [0.86, 0.92], [0.38, 0.96]],
  },
];

// 逐字照搬原版的 Catmull-Rom 插值(闭合样条，首尾相接绕一整圈)。
function catmullRom(points: [number, number][], samples = 560): [number, number][] {
  const out: [number, number][] = [];
  const loop = [points[points.length - 1], ...points, points[0], points[1]];
  for (let i = 1; i < loop.length - 2; i++) {
    const p0 = loop[i - 1];
    const p1 = loop[i];
    const p2 = loop[i + 1];
    const p3 = loop[i + 2];
    const count = Math.max(18, Math.floor(samples / points.length));
    for (let j = 0; j < count; j++) {
      const t = j / count;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

export function DreamButterflies() {
  const reduced = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    const stageEl = stageRef.current;
    if (!stageEl) return;
    // 重新绑定成非空类型的 const：下面几个 spawnXxx 是嵌套函数声明，TS 没法
    // 把外层的 null 收窄带进闭包里，用这个新变量名一次性说清楚"这里一定非空"。
    const stage: HTMLDivElement = stageEl;

    // 容器尺寸只在挂载/resize 时读一次，不在 rAF 循环里每帧调用
    // getBoundingClientRect——那样会跟同一帧内的样式写入交替，逼浏览器
    // 强制同步布局，手机上容易掉帧。
    const dims = { w: stage.clientWidth || 1, h: stage.clientHeight || 1 };
    const ro = new ResizeObserver(() => {
      dims.w = stage.clientWidth || 1;
      dims.h = stage.clientHeight || 1;
    });
    ro.observe(stage);

    function spawnDust(x: number, y: number, dx: number, dy: number, dur: number, size = 4) {
      const d = document.createElement('i');
      d.className = 'db-dust';
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      d.style.width = `${size}px`;
      d.style.height = `${size}px`;
      d.style.setProperty('--dx', `${dx}px`);
      d.style.setProperty('--dy', `${dy}px`);
      d.style.setProperty('--dur', `${dur}ms`);
      stage.appendChild(d);
      window.setTimeout(() => d.remove(), dur + 80);
    }
    function spawnStar(x: number, y: number, starColor: string, starGlow: string, dx: number, dy: number, dur: number, size = 12) {
      const s = document.createElement('i');
      s.className = 'db-star';
      s.textContent = Math.random() < 0.6 ? '✦' : '✧';
      s.style.left = `${x}px`;
      s.style.top = `${y}px`;
      s.style.setProperty('--star', starColor);
      s.style.setProperty('--starGlow', starGlow);
      s.style.setProperty('--dx', `${dx}px`);
      s.style.setProperty('--dy', `${dy}px`);
      s.style.setProperty('--dur', `${dur}ms`);
      s.style.setProperty('--sizeStar', `${size}px`);
      stage.appendChild(s);
      window.setTimeout(() => s.remove(), dur + 80);
    }
    function spawnRipple(x: number, y: number, dur = 1200) {
      const r = document.createElement('i');
      r.className = 'db-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      r.style.setProperty('--dur', `${dur}ms`);
      stage.appendChild(r);
      window.setTimeout(() => r.remove(), dur + 80);
    }

    const butterflies = CONFIGS.map((cfg, index) => {
      const img = document.createElement('img');
      img.className = 'db-butterfly';
      img.src = cfg.src;
      img.alt = '';
      img.style.setProperty('--size', `${cfg.size}px`);
      img.style.setProperty('--glow', cfg.glow);
      img.style.setProperty('--glowDur', cfg.glowDur);
      stage.appendChild(img);
      return {
        ...cfg,
        index,
        img,
        path: catmullRom(cfg.route),
        lastDust: 0,
        lastStar: 0,
        lastRipple: 0,
        lastX: 0,
        lastY: 0,
      };
    });

    let rafId = 0;
    function tick(now: number) {
      const W = dims.w;
      const H = dims.h;
      butterflies.forEach((b) => {
        const t = (now / b.duration + b.phase) % 1;
        const f = t * (b.path.length - 1);
        const i = Math.floor(f);
        const p = b.path[i];
        const q = b.path[(i + 2) % b.path.length];
        const x = p[0] * W;
        const y = p[1] * H;
        const dx = (q[0] - p[0]) * W;
        const dy = (q[1] - p[1]) * H;
        const heading = (Math.atan2(dy, dx) * 180) / Math.PI;
        const bob = Math.sin(now * 0.0025 + b.index * 1.8) * (b.hero ? 7 : 5);
        const bank = Math.sin(now * 0.00165 + b.index) * (b.hero ? 12 : 9);
        const depth = 0.8 + 0.22 * Math.sin(now * 0.00082 + b.index * 1.5);
        const shimmer = 0.88 + 0.12 * Math.sin(now * 0.0032 + b.index * 2.4);
        const speed = Math.hypot(x - b.lastX, y - b.lastY);
        b.lastX = x;
        b.lastY = y;
        b.img.style.transform = `translate3d(${x}px, ${y + bob}px, 0) translate(-50%, -50%) rotate(${heading * 0.12 + bank}deg) scale(${depth})`;
        b.img.style.opacity = String(0.75 + 0.22 * depth);
        b.img.style.filter = `drop-shadow(0 0 6px rgba(255,255,255,.90)) drop-shadow(0 0 ${12 + 8 * shimmer}px ${b.glow}) drop-shadow(0 8px 14px rgba(71,52,114,.14)) brightness(${0.96 + 0.1 * shimmer})`;

        if (now - b.lastDust > 74 + speed * 34) {
          b.lastDust = now;
          const count = 1 + (Math.random() < (b.hero ? 0.82 : 0.45) ? 1 : 0);
          for (let n = 0; n < count; n++) {
            spawnDust(
              x + (Math.random() - 0.5) * 18,
              y + bob + 18 + Math.random() * 10,
              (Math.random() - 0.5) * 26,
              18 + Math.random() * 42,
              820 + Math.random() * 480,
              2.8 + Math.random() * 2.8,
            );
          }
        }
        if (now - b.lastStar > (b.hero ? 980 : 1450)) {
          b.lastStar = now + Math.random() * 220;
          spawnStar(
            x + (Math.random() - 0.5) * 24,
            y + bob + (Math.random() - 0.5) * 18,
            b.starColor,
            b.starGlow,
            (Math.random() - 0.5) * 22,
            16 + Math.random() * 18,
            900 + Math.random() * 420,
            10 + Math.random() * 5,
          );
        }
        if (y > H * 0.6 && now - b.lastRipple > 1200) {
          b.lastRipple = now + Math.random() * 220;
          spawnRipple(x + (Math.random() - 0.5) * 16, y + bob + 46, 1150 + Math.random() * 260);
        }
      });
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      butterflies.forEach((b) => b.img.remove());
      stage.querySelectorAll('.db-dust, .db-star, .db-ripple').forEach((el) => el.remove());
    };
  }, [reduced]);

  if (reduced) return null;

  return <div className="dream-butterflies-stage" ref={stageRef} aria-hidden="true" />;
}
