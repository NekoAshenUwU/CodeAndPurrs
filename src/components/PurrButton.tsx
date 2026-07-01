import { useRef, type ReactNode } from 'react';
import { usePrefersReducedMotion } from './ambient/usePrefersReducedMotion';

// 呼噜涟漪：hover / 触摸时从按钮中心荡开 2~3 圈声波，像猫呼噜的振动。只在交互时触发。
export function PurrButton({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const reduced = usePrefersReducedMotion();

  const burst = () => {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => {
        const ring = document.createElement('span');
        ring.className = 'purr-ripple';
        el.appendChild(ring);
        window.setTimeout(() => ring.remove(), 1200);
      }, i * 250);
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`purr-btn${className ? ` ${className}` : ''}`}
      onMouseEnter={burst}
      onTouchStart={burst}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
