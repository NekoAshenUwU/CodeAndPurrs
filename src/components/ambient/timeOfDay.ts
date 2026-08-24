import { useEffect, useState } from 'react';

// 一天四档时段。首页「会呼吸的时间背景」与猫爪足迹的呼吸背景共用这一套映射，别两处各写一份。
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

// 05–10 清晨 · 10–17 白天 · 17–20 傍晚 · 20–05 深夜
export function getTimeOfDay(hour: number = new Date().getHours()): TimeOfDay {
  if (hour >= 5 && hour < 10) return 'dawn';
  if (hour >= 10 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

// 跟随真实时间的 hook：每 5 分钟回看一次，跨档时平滑切换（背景层用 CSS opacity 渐变）。
export function useTimeOfDay(): TimeOfDay {
  const [tod, setTod] = useState<TimeOfDay>(() => getTimeOfDay());

  useEffect(() => {
    const tick = () => setTod(getTimeOfDay());
    const id = window.setInterval(tick, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  return tod;
}
