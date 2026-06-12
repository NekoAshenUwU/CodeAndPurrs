import { useEffect, useState } from 'react';

// 跟随系统「减少动态效果」偏好。用户开了无障碍设置，我们就把氛围动效全关掉。
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return reduced;
}
