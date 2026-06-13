import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// 指尖留爪印：手指滑动 / 鼠标拖动的轨迹上，间隔落下极淡的小爪印，0.9s 渐隐，同屏 ≤ 8 枚。
// pointer-events:none，永远不抢滚动手势。

const PAW_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<ellipse cx="12" cy="15.5" rx="5.6" ry="4.6"/>' +
  '<ellipse cx="5.6" cy="9.5" rx="2.1" ry="2.6"/>' +
  '<ellipse cx="10" cy="6" rx="2.1" ry="2.7"/>' +
  '<ellipse cx="14.4" cy="6" rx="2.1" ry="2.7"/>' +
  '<ellipse cx="18.6" cy="9.5" rx="2.1" ry="2.6"/>' +
  '</svg>';

const MIN_GAP = 46; // 每隔约 46px 落一枚，太密会糊
const MAX_LIVE = 8; // 同屏上限

export function PawCursor() {
  const reduced = usePrefersReducedMotion();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reduced) return;
    const host = hostRef.current;
    if (!host) return;

    let lastX = 0;
    let lastY = 0;
    let primed = false;
    const live: HTMLDivElement[] = [];

    const drop = (x: number, y: number) => {
      const paw = document.createElement('div');
      paw.className = 'paw paw--trail';
      paw.innerHTML = PAW_SVG;
      const rot = (Math.random() * 40 - 20).toFixed(1); // ±20°
      paw.style.left = `${x}px`;
      paw.style.top = `${y}px`;
      paw.style.setProperty('--rot', `${rot}deg`);
      host.appendChild(paw);
      live.push(paw);
      if (live.length > MAX_LIVE) live.shift()?.remove();
      window.setTimeout(() => {
        paw.remove();
        const i = live.indexOf(paw);
        if (i >= 0) live.splice(i, 1);
      }, 950);
    };

    const onMove = (e: PointerEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      if (!primed) {
        lastX = x;
        lastY = y;
        primed = true;
        return;
      }
      const dist = Math.hypot(x - lastX, y - lastY);
      if (dist < MIN_GAP) return;
      lastX = x;
      lastY = y;
      drop(x, y);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      host.replaceChildren();
    };
  }, [reduced]);

  return <div className="paw-cursor" ref={hostRef} aria-hidden="true" />;
}
