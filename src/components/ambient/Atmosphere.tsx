import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// 一只看不见的猫的爪印：1 个掌垫 + 4 个趾垫，很淡，氛围感。
const PAW_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<ellipse cx="12" cy="15.5" rx="5.6" ry="4.6"/>' +
  '<ellipse cx="5.6" cy="9.5" rx="2.1" ry="2.6"/>' +
  '<ellipse cx="10" cy="6" rx="2.1" ry="2.7"/>' +
  '<ellipse cx="14.4" cy="6" rx="2.1" ry="2.7"/>' +
  '<ellipse cx="18.6" cy="9.5" rx="2.1" ry="2.6"/>' +
  '</svg>';

const rand = (min: number, max: number) => min + Math.random() * (max - min);

// 12~16 颗光尘，每颗随机起点、周期、延迟。
const DUST = Array.from({ length: 14 }, () => ({
  left: rand(2, 98),
  duration: rand(14, 30),
  delay: rand(-30, 0),
  drift: rand(-30, 30),
}));

export function Atmosphere() {
  const reduced = usePrefersReducedMotion();
  const pawHostRef = useRef<HTMLDivElement | null>(null);

  // 看不见的猫：每隔 25~45 秒，一串爪印从随机一侧斜斜走过页面。
  useEffect(() => {
    if (reduced) return;
    const host = pawHostRef.current;
    if (!host) return;

    let killTimer = 0;
    let nextTimer = 0;

    const spawnTrail = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const fromLeft = Math.random() < 0.5;
      const dir = fromLeft ? 1 : -1;
      const startX = fromLeft ? -30 : w + 30;
      const y0 = rand(h * 0.15, h * 0.85);
      const slope = rand(-0.35, 0.35); // 垂直漂移，做出微弧
      const count = Math.round(rand(6, 10));
      const stepX = (w + 60) / count;
      const angleDeg = (Math.atan2(slope, dir) * 180) / Math.PI;

      for (let i = 0; i < count; i++) {
        const x = startX + dir * stepX * i;
        const baseY = y0 + slope * stepX * i;
        const footOffset = (i % 2 === 0 ? -1 : 1) * 11; // 左右脚交替
        const y = baseY + footOffset;
        const paw = document.createElement('div');
        paw.className = 'paw';
        paw.innerHTML = PAW_SVG;
        paw.style.setProperty('--t', `translate(${x}px, ${y}px) rotate(${angleDeg + footOffset}deg)`);
        paw.style.animationDelay = `${i * 0.38}s`;
        host.appendChild(paw);
        window.setTimeout(() => paw.remove(), i * 380 + 2700);
      }
    };

    const loop = () => {
      spawnTrail();
      nextTimer = window.setTimeout(loop, rand(25000, 45000));
    };

    killTimer = window.setTimeout(loop, rand(4000, 9000)); // 进页面几秒后先来一串
    return () => {
      window.clearTimeout(killTimer);
      window.clearTimeout(nextTimer);
      host.replaceChildren();
    };
  }, [reduced]);

  return (
    <div className="atmosphere" aria-hidden="true">
      {!reduced &&
        DUST.map((d, i) => (
          <span
            key={i}
            className="dust"
            style={{
              left: `${d.left}%`,
              animationDuration: `${d.duration}s`,
              animationDelay: `${d.delay}s`,
              ['--drift' as string]: `${d.drift}px`,
            }}
          />
        ))}
      <div ref={pawHostRef} />
    </div>
  );
}
