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

// 三只蝴蝶的配置基本照搬素材包展示页(辉光/闪粉/星星配色是配好的一套)。
// 尺寸走过两个来回：第九轮 58~80px → 老婆说"调大一些"提到 74~104px →
// 多角度版又说"太大只了"落定 60~84 → 真机又嫌粉/紫大，粉 58/紫 50，蓝不动。
// 2026-07-18 真·多角度：每只除俯视(src)外新增 side(正右侧)/quarter(右前
// 45°)两张视角图(也是 GPT 出的 8 帧扇翅 webp，帧时长在入库时用 webpmux
// 重设成各自的节奏)，按飞行方向实时切换，朝左飞用镜像。
const BUTTERFLIES = [
  {
    src: 'ice_blue_flap.webp',
    side: 'ice_blue_side2.webp',
    sideFlapMs: 750, // 侧面扇翅循环时长，跟俯视图节奏一致
    quarter: 'ice_blue_quarter.webp',
    bias: 'side' as const, // 横穿党——常看到侧面
    size: 84,
    glow: 'rgba(146, 193, 255, 0.55)',
    spark: 'rgba(198, 229, 255, 0.95)',
    star: '#fff3c7',
    starGlow: 'rgba(255, 213, 115, 0.72)',
  },
  {
    src: 'peach_pink_flap.webp',
    side: 'peach_pink_side2.webp',
    sideFlapMs: 600,
    quarter: 'peach_pink_quarter.webp',
    bias: 'quarter' as const, // 斜切党——常看到四分之三
    size: 58,
    glow: 'rgba(255, 160, 218, 0.48)',
    spark: 'rgba(255, 219, 240, 0.92)',
    star: '#ffe6bb',
    starGlow: 'rgba(255, 188, 132, 0.68)',
  },
  {
    src: 'moon_lavender_flap.webp',
    side: 'moon_lavender_side2.webp',
    sideFlapMs: 480,
    quarter: 'moon_lavender_quarter.webp',
    bias: 'top' as const, // 纵游党——常看到俯视
    size: 50,
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
  vx: number; // 速度向量(%/s)——平滑转向，飞出弧线弯而不是死角弯
  vy: number;
  hx: number; // 平滑后的朝向(横)=速度方向，驱动 rotateY 三维侧转
  hy: number; // 平滑后的朝向(纵)，驱动 rotateX 俯仰
  tux: number; // 指向当前目标的单位方向(横)——视角图按它定，一段航程一张图
  bias: 'top' | 'quarter' | 'side'; // 飞行习性(见 pickWander)
  view: 'top' | 'quarter' | 'side'; // 当前用的哪张视角图
  facing: 1 | -1; // 脸朝向(1=右)，|hx|>0.15 才更新，防竖直飞时左右翻面抽搐
  lastViewSwitch: number; // 上次换视角图的时间戳(ms)，做切换冷却
  lastSpark: number; // 上次撒闪粉的时间戳(ms)
  lastDust: number; // 上次撒金粉的时间戳(ms)
  lastStar: number; // 上次掉小星星的时间戳(ms)
  spark: string;
  star: string;
  starGlow: string;
  el: HTMLElement;
  flipEl: HTMLElement;
  // 三张视角图常驻 DOM(见 JSX)，切换=显隐——换 src 的老方案在手机上每次
  // 都可能重新解码一次 webp，肉眼可见地顿一下("卡卡的"元凶之一)。
  imgEls: Record<'top' | 'quarter' | 'side', HTMLImageElement>;
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

// 挑下一个漫游航点。2026-07-18 "有的侧面有的俯视"：三只各有飞行习性
// (bias)，让同一时刻屏幕上自然出现不同视角——横穿党常给侧面、斜切党常给
// 四分之三、纵游党常给俯视。30% 概率无视习性自由飞，路线不至于太死板。
function pickWander(b: ButterflyState) {
  b.mode = 'wander';
  b.speed = rand(6, 11);
  const free = Math.random() < 0.3;
  if (free || !b.bias) {
    b.tx = rand(FLY_X[0], FLY_X[1]);
    b.ty = rand(FLY_Y[0], FLY_Y[1]);
    return;
  }
  const clampX = (v: number) => Math.max(FLY_X[0], Math.min(FLY_X[1], v));
  const clampY = (v: number) => Math.max(FLY_Y[0], Math.min(FLY_Y[1], v));
  if (b.bias === 'side') {
    // 横穿：往画面另一侧飞，纵向基本持平 → |hx| 大 → 侧面图
    b.tx = b.x < 50 ? rand(62, FLY_X[1]) : rand(FLY_X[0], 38);
    b.ty = clampY(b.y + rand(-7, 7));
  } else if (b.bias === 'quarter') {
    // 斜切：横纵各走一段 → |hx| 中等 → 四分之三图
    const dx = rand(22, 38) * (b.x < 50 ? 1 : -1);
    const dy = rand(14, 24) * (b.y < 55 ? 1 : -1);
    b.tx = clampX(b.x + dx);
    b.ty = clampY(b.y + dy);
  } else {
    // 纵游：基本竖着走 → |hx| 小 → 俯视图
    b.tx = clampX(b.x + rand(-9, 9));
    b.ty = b.y < 55 ? rand(66, FLY_Y[1]) : rand(FLY_Y[0], 46);
  }
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
      // 第三轮返工：金粉必须细如尘(1~2px)——之前 3~5px 一粒粒的，老婆原话
      // "要细才像金粉不是一粒粒像拉粑粑"。细颗粒靠数量补存在感(调用处加密)。
      const size = rand(1, 2);
      el.style.width = `${size.toFixed(1)}px`;
      el.style.height = `${size.toFixed(1)}px`;
      // 第四轮(金粉尾巴)：位移收小+寿命拉长——粒子基本停在被撒下的原地慢慢
      // 熄灭，蝴蝶飞走了粒子还亮着，飞行轨迹就自然连成一条金雾尾巴。
      el.style.setProperty('--dx', `${rand(-10, 10).toFixed(1)}px`);
      el.style.setProperty('--dy', `${rand(4, 14).toFixed(1)}px`);
      const dur = rand(1300, 2000);
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
        vx: 0,
        vy: 0,
        hx: 0,
        hy: 0,
        tux: 0,
        bias: cfg.bias,
        view: 'top',
        facing: 1,
        lastViewSwitch: 0,
        lastSpark: 0,
        lastDust: 0,
        lastStar: performance.now() + i * 900,
        spark: cfg.spark,
        star: cfg.star,
        starGlow: cfg.starGlow,
        el,
        flipEl: el.querySelector<HTMLElement>('.murmurs-bfly__flip')!,
        imgEls: {
          top: el.querySelector<HTMLImageElement>('.murmurs-bfly__img--top')!,
          quarter: el.querySelector<HTMLImageElement>('.murmurs-bfly__img--quarter')!,
          side: el.querySelector<HTMLImageElement>('.murmurs-bfly__img--side')!,
        },
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
            b.tux = ux;
            // 真机反馈"卡顿不自然"返工：位置不再直奔目标(直线+死角拐弯，
            // 机械感)，改成速度向量平滑转向——期望速度指着目标，实际速度
            // 花小半秒转过去，飞出来的是弧线弯。
            const k = Math.min(1, dt * 2.2);
            b.vx += (ux * b.speed - b.vx) * k;
            b.vy += (uy * b.speed - b.vy) * k;
            b.x += b.vx * dt;
            // 飞行中上下轻颤——扇一下浮一下的那种起伏感。
            b.y += b.vy * dt + Math.sin((now / 1000) * 7 + b.phase) * 1.6 * dt;
            const sp = Math.hypot(b.vx, b.vy);
            if (sp > 0.5) {
              b.hx = b.vx / sp;
              b.hy = b.vy / sp;
            }
          }
        }
        if (!moving) {
          // 悬停/歇脚时慢慢回正，像停稳时把翅膀放平。
          const k = Math.min(1, dt * 1.8);
          b.hx -= b.hx * k;
          b.hy -= b.hy * k;
        }
        // 真·多角度(2026-07-18 第二弹，第三弹修"抽抽")：按平滑朝向的水平
        // 分量 |hx| 在俯视/quarter(右前45°)/side(正右侧)三张图之间切换。
        // 真机反馈"像在抽抽"的三个根源逐个治：
        // 1. 换图跳变——图片本身画的角度(ART_ANGLE：俯视0°/四分之三28°/
        //    侧面42°)在切换瞬间跳一档，CSS 的 rotateY 必须同步减掉这一档
        //    (yaw = 总角度 - 当前图自带的角度)，视觉总角度才是连续的；
        // 2. 阈值抖动——升档/降档用不同阈值(迟滞区间)，方向在临界值附近
        //    徘徊时不会图片换来换去，另加 600ms 冷却兜底；
        // 3. 镜像翻面——朝向 |hx|<0.15 时保持上一次的脸朝向不翻(接近竖直
        //    飞时 hx 会在 0 附近晃，跟着晃就左右翻面抽搐)。
        // 视角图/镜像按"目标方向"(tux)定——它只在选新航点那一刻变一次，
        // 一段航程从头到尾同一张图，转弯的视觉过渡完全交给 3D rotateY 的
        // 连续变化(ART_ANGLE 补偿保证换图瞬间总角度不跳)。以前跟着实时
        // 平滑朝向走，转弯必扫过所有阈值→一次转弯换两三次图，屏幕上大半
        // 时间在放"换图瞬间"，侧面扇翅动画根本没机会连续播("像滑行"元凶)。
        if (Math.abs(b.tux) > 0.15) b.facing = b.tux > 0 ? 1 : -1;
        const ax = Math.abs(b.tux);
        const desired: 'top' | 'quarter' | 'side' = ax > 0.75 ? 'side' : ax > 0.4 ? 'quarter' : 'top';
        if (desired !== b.view && now - b.lastViewSwitch > 300) {
          b.view = desired;
          b.lastViewSwitch = now;
          // 三张视角图常驻 DOM，切换=显隐——换 src 会触发手机重新解码
          // webp，肉眼可见顿一下。
          for (const v of ['top', 'quarter', 'side'] as const) {
            b.imgEls[v].classList.toggle('is-on', v === desired);
          }
        }
        const mirror = b.view !== 'top' && b.facing < 0;
        b.flipEl.style.transform = mirror ? 'scaleX(-1)' : '';
        const ART_ANGLE = { top: 0, quarter: 28, side: 42 } as const;
        const sway = Math.sin((now / 1000) * 1.65 + b.phase) * (moving ? 7 : 3);
        const yaw = b.hx * 42 - b.facing * ART_ANGLE[b.view];
        const pitch = b.hy * -20;
        const bank = sway + Math.max(-14, Math.min(14, b.hx * 12));
        b.el.style.transform = `translate(${((b.x / 100) * rect.width).toFixed(1)}px, ${((b.y / 100) * rect.height).toFixed(1)}px) translate(-50%, -50%) perspective(520px) rotateX(${pitch.toFixed(1)}deg) rotateY(${yaw.toFixed(1)}deg) rotateZ(${bank.toFixed(1)}deg)`;

        // 闪粉尾迹只在飞行时撒；歇脚/悬停时偶尔还掉一颗小星星(更安静)。
        if (moving && now - b.lastSpark > 210) {
          b.lastSpark = now;
          spawnMote(b.x + rand(-2, 2), b.y + rand(-1.5, 1.5), b.spark);
        }
        if (moving && now - b.lastDust > 110) {
          b.lastDust = now;
          // 金粉尾巴(第四轮)：高频细撒+粒子原地慢熄(见 spawnDust 里的
          // 位移/寿命)，蝴蝶飞过的弧线就连成一条渐渐熄灭的金雾尾迹。
          // 频率是权衡过的上限：三只全在飞时同屏约七八十粒金尘，粒子只动
          // transform/opacity(合成器动画)，再密就要开始赌手机了。
          const n = 1 + (Math.random() < 0.7 ? 1 : 0);
          for (let k = 0; k < n; k++) {
            spawnDust(b.x + rand(-3, 3), b.y + rand(-1.5, 1.5));
          }
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
        // 外层 div 由 rAF 写"定位+3D 姿态"，内层 img 管"当前视角图+镜像+
        // 辉光"——镜像的 scaleX(-1) 和姿态的 rotate 系列必须分在两层，
        // 挤在同一个 transform 里每帧拼字符串既乱又容易写错符号。
        // ?v=2：俯视图扇翅重编版(三只不同频率)。webp 内容变了但文件名没变，
        // 不带版本号浏览器会拿缓存里的旧图，三只又齐步扇回去。
        <div
          key={i}
          className="murmurs-bfly"
          style={
            {
              width: `${cfg.size}px`,
              height: `${cfg.size}px`,
              '--glow': cfg.glow,
              '--glowDur': `${4.4 + i * 0.5}s`,
              // alternate 动画一去一回是一个循环，所以时长给一半
              '--sideFlap': `${Math.round(cfg.sideFlapMs / 2)}ms`,
            } as React.CSSProperties
          }
        >
          <div className="murmurs-bfly__halo" aria-hidden="true" />
          <div className="murmurs-bfly__flip">
            <img
              className="murmurs-bfly__img murmurs-bfly__img--top is-on"
              src={`${import.meta.env.BASE_URL}assets/butterflies/${cfg.src}?v=2`}
              alt=""
            />
            <img
              className="murmurs-bfly__img murmurs-bfly__img--quarter"
              src={`${import.meta.env.BASE_URL}assets/butterflies/${cfg.quarter}`}
              alt=""
            />
            {/* 侧面图是静态单帧，扇翅=CSS 压放动画(murmursSideFlap)，常挂 */}
            <img
              className="murmurs-bfly__img murmurs-bfly__img--side murmurs-bfly__img--sideflap"
              src={`${import.meta.env.BASE_URL}assets/butterflies/${cfg.side}`}
              alt=""
            />
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
