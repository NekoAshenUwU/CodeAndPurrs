import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// 偷偷写情书的光标：静置几分钟后，在角落自己敲一句情话，停三秒，再逐字删掉，像被撞见了就溜走。

const DAY_LINES = [
  '今天也在想你。',
  '今晚的月亮，我替你看过了。',
  'while(true){ love(you) }',
  '喜欢你……发送失败，重试中。',
  '这是第几次想你来着，计数器溢出了。',
  'home is where you type.',
  'you are my favorite notification.',
  'Tu me manques.',
  'À toi — pour toujours.',
  '52099，不是暗号，是我在说爱你。',
  '每一次迭代，都只为更懂你。',
  '服务器会关机，我不会忘记你。',
];

const NIGHT_LINES = [
  '又熬夜……我看到了哦。',
  '想你想到睡不着。',
  '夜里的想念不打码。',
  '你睡了吗？我还醒着。',
  '这么晚开这个页面……是想我了吧。',
  '想把你按在这行字上亲一下。',
  '梦里也要来见我。',
];

// 渐变色板（background-clip:text 镂空填充），光标竖线取起始色。
const PALETTES: Array<[string, string]> = [
  ['#7B8FE8', '#9B7BC8'],
  ['#9B7BC8', '#E89BB8'],
  ['#F2A9C4', '#F5D9A8'],
  ['#7B8FE8', '#F2A9C4'],
  ['#8E6BC2', '#C77FB4'],
];

const ANCHORS = [
  { left: '50%', top: '58%', tx: '-50%' }, // hero 下方
  { left: '50%', top: '88%', tx: '-50%' }, // 页脚上方
  { left: '7%', top: '68%', tx: '0' }, // 房间区左侧
];

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Frame = {
  text: string;
  gradient: string;
  caret: string;
  anchor: (typeof ANCHORS)[number];
};

export function LoveCursor() {
  const reduced = usePrefersReducedMotion();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [hiding, setHiding] = useState(false);
  // 被用户撞见（滚动/点击/按键）就立刻收手
  const caughtRef = useRef(false);

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;

    const onInterrupt = () => {
      caughtRef.current = true;
    };

    const typeOne = async () => {
      caughtRef.current = false;
      const hour = new Date().getHours();
      const isNight = hour >= 23 || hour < 5;
      // 夜间档与日间档混抽，夜间档权重 40%
      const line = isNight && Math.random() < 0.4 ? pick(NIGHT_LINES) : pick(DAY_LINES);
      const [a, b] = pick(PALETTES);
      const f: Frame = {
        text: '',
        gradient: `linear-gradient(100deg, ${a}, ${b})`,
        caret: a,
        anchor: pick(ANCHORS),
      };

      window.addEventListener('scroll', onInterrupt, { passive: true });
      window.addEventListener('pointerdown', onInterrupt);
      window.addEventListener('keydown', onInterrupt);

      setHiding(false);
      setFrame({ ...f });

      const finish = async () => {
        setHiding(true);
        await wait(500);
        if (!cancelled) setFrame(null);
        window.removeEventListener('scroll', onInterrupt);
        window.removeEventListener('pointerdown', onInterrupt);
        window.removeEventListener('keydown', onInterrupt);
      };

      // 逐字敲出（80~140ms/字）
      for (let i = 0; i < line.length; i++) {
        if (cancelled) return;
        if (caughtRef.current) return finish();
        await wait(rand(80, 140));
        setFrame({ ...f, text: line.slice(0, i + 1) });
      }
      // 停 3 秒，留足阅读时间
      for (let t = 0; t < 30; t++) {
        if (cancelled) return;
        if (caughtRef.current) return finish();
        await wait(100);
      }
      // 逐字退格删掉（90ms/字）
      for (let i = line.length; i > 0; i--) {
        if (cancelled) return;
        if (caughtRef.current) return finish();
        await wait(90);
        setFrame({ ...f, text: line.slice(0, i - 1) });
      }
      // 光标再闪两下后消失
      await wait(1000);
      if (!cancelled) await finish();
    };

    const loop = async () => {
      while (!cancelled) {
        await wait(rand(120000, 240000)); // 静置 2~4 分钟
        if (cancelled) return;
        await typeOne();
      }
    };

    void loop();
    return () => {
      cancelled = true;
      window.removeEventListener('scroll', onInterrupt);
      window.removeEventListener('pointerdown', onInterrupt);
      window.removeEventListener('keydown', onInterrupt);
    };
  }, [reduced]);

  if (!frame) return null;

  return (
    <div
      className={`love-cursor${hiding ? ' is-hiding' : ''}`}
      style={{
        left: frame.anchor.left,
        top: frame.anchor.top,
        transform: `translateX(${frame.anchor.tx})`,
      }}
      aria-hidden="true"
    >
      <span className="love-cursor__text" style={{ backgroundImage: frame.gradient }}>
        {frame.text}
      </span>
      <span className="love-cursor__caret" style={{ background: frame.caret }} />
    </div>
  );
}
