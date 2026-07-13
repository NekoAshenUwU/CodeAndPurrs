import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { createWaterRipples, type WaterRipples } from '../services/waterRipples';
import { MurmursAmbient } from '../components/ambient/MurmursAmbient';

// 倾棠予梦 Step 2——接棠予酿记忆数据。后端 /api/murmurs/flowers 把日记记忆
// 映射成 {id,size,position,title,date,moodLabel,valence,arousal} 数组
// （60 秒内存缓存，详见 server/proxy.mjs），这里只管把这份数组画成沉在
// 湖水里的花朵。花色不走关键词，改由 valence/arousal 连续计算——见下方。
//
// 2026-07-13 第六轮（老婆发的参考视频截图版）：
// - 水面接落予棠同一套 WebGL 触摸涟漪（src/services/waterRipples.ts，已定稿
//   锁定模块，只调用不改动）+ 焦散光纹 + 星光，"波光粼粼"。
// - 花朵沉在水里、完全静止：idle bob 晃动整个删掉，坐标一次分配后不再动。
// - 纵深改成"新 + 重要 = 近，旧 + 不重要 = 远"：position(时间) 和
//   size(importance) 加权混合出 depthScore，一起决定落点/大小/清晰度。
// - 花朵素材全局去重：39 张素材按心情色就近排序后做"不重复分配"，同一张图
//   不会同时出现两次（记忆条数超过素材数才会从头复用）。

type MurmursFlower = {
  id: string;
  size: number; // 0.4~1.0，来自 importance，越重要花越大
  position: number; // 0~1，按 created_at 排序：0=最旧，1=最新
  title: string;
  date: string | null;
  moodLabel?: string | null; // 纯文字心情词(平静/开心/伤心…)，弹出卡片用，不参与花色
  valence: number; // 实测约 -0.3~0.8，负=冷色调，正=暖色调
  arousal: number; // 实测约 0.3~0.75，越高饱和度/明度越强
};

// 花色改用连续色谱：valence 决定色相(冷→暖)，arousal 决定饱和度/明度。
// 39 张素材按肉眼估的 HSL 标了色标——不是量出来的像素值，只是"这朵花大概
// 长这个色系"的粗估，允许有偏差，上线后棠棠看到明显不对可以再调具体某一张。
// 色相刻意绕开纯绿(现有素材也没有绿花)，从冷的蓝紫一路转到暖的粉橙。
const FLOWER_COLOR_TAGS: Record<string, { h: number; s: number; l: number }> = {
  'flower-lily-lavender-bloom.webp': { h: 265, s: 40, l: 78 },
  'flower-lily-periwinkle-bloom-bud.webp': { h: 235, s: 45, l: 80 },
  'flower-lotus-gold-bloom.webp': { h: 40, s: 65, l: 72 },
  'flower-lotus-gold-bloom-bud.webp': { h: 35, s: 60, l: 76 },
  'flower-iris-bloom.webp': { h: 255, s: 50, l: 55 },
  'flower-iris-half-open.webp': { h: 250, s: 45, l: 62 },
  'flower-ranunculus-yellow-1.webp': { h: 48, s: 55, l: 80 },
  'flower-ranunculus-yellow-2.webp': { h: 45, s: 50, l: 84 },
  'flower-ranunculus-pink-1.webp': { h: 340, s: 55, l: 78 },
  'flower-ranunculus-pink-2.webp': { h: 335, s: 60, l: 76 },
  'flower-ranunculus-lilac-1.webp': { h: 280, s: 40, l: 78 },
  'flower-ranunculus-lilac-2.webp': { h: 275, s: 38, l: 80 },
  'flower-pansy-pink-1.webp': { h: 325, s: 55, l: 72 },
  'flower-pansy-pink-2.webp': { h: 330, s: 50, l: 76 },
  'flower-pansy-violet-1.webp': { h: 265, s: 50, l: 58 },
  'flower-pansy-violet-2.webp': { h: 260, s: 48, l: 62 },
  'flower-cosmos-blue-1.webp': { h: 205, s: 45, l: 80 },
  'flower-cosmos-blue-2.webp': { h: 210, s: 42, l: 82 },
  'flower-cosmos-cream-1.webp': { h: 42, s: 35, l: 88 },
  'flower-cosmos-cream-2.webp': { h: 38, s: 32, l: 90 },
  'flower-cosmos-lavender-1.webp': { h: 270, s: 35, l: 82 },
  'flower-cosmos-lavender-2.webp': { h: 268, s: 38, l: 80 },
  'flower-cosmos-pink-1.webp': { h: 345, s: 55, l: 80 },
  'flower-cosmos-pink-2.webp': { h: 350, s: 50, l: 82 },
  'flower-cosmos-white-1.webp': { h: 300, s: 10, l: 94 },
  'flower-cosmos-white-2.webp': { h: 30, s: 8, l: 95 },
  'flower-peony-pearl-white-1.webp': { h: 320, s: 15, l: 92 },
  'flower-peony-pearl-white-2.webp': { h: 40, s: 12, l: 93 },
  'flower-peony-pearl-lilac-1.webp': { h: 285, s: 35, l: 82 },
  'flower-peony-pearl-lilac-2.webp': { h: 280, s: 38, l: 80 },
  'flower-peony-pearl-blush-1.webp': { h: 15, s: 45, l: 84 },
  'flower-peony-pearl-blush-2.webp': { h: 10, s: 48, l: 82 },
  'flower-lisianthus-blush-ruffle.webp': { h: 340, s: 30, l: 90 },
  'flower-lisianthus-turquoise-ruffle.webp': { h: 185, s: 45, l: 85 },
  'flower-lisianthus-violet-dew.webp': { h: 285, s: 32, l: 88 },
  'flower-hydrangea-rainbow-pastel.webp': { h: 260, s: 30, l: 88 },
  'flower-hydrangea-pink-gold.webp': { h: 25, s: 40, l: 87 },
  'flower-hydrangea-lavender-mist.webp': { h: 250, s: 28, l: 90 },
  'flower-lisianthus-blush-dew.webp': { h: 320, s: 32, l: 90 },
};
const FLOWER_FILES = Object.keys(FLOWER_COLOR_TAGS);

// 空数据(还没有棠予酿记忆，或者 MCP/key 没配好)时的占位花——没有专门的
// "纯含苞"素材，半开的鸢尾花是现有素材里最接近"含苞待放"的一张，先顶上。
const PLACEHOLDER_BUD_SRC = 'flower-iris-half-open.webp';

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// valence(-0.3~0.8) → 色相：负值落在冷调蓝紫(约 225°)，正值转到暖调粉橙(约 20°/380°)，
// 走"蓝→靛→紫→品红→粉→橙"这条不经过绿色的路径。
function valenceToHue(valence: number): number {
  const [lo, hi] = [-0.3, 0.8];
  const t = Math.max(0, Math.min(1, (valence - lo) / (hi - lo)));
  return (225 + t * (380 - 225)) % 360;
}

// arousal(0.3~0.75) → 饱和度/明度：越平静(低)越浅淡柔和，越强烈(高)越饱和鲜亮。
function arousalToSatLight(arousal: number): { s: number; l: number } {
  const [lo, hi] = [0.3, 0.75];
  const t = Math.max(0, Math.min(1, (arousal - lo) / (hi - lo)));
  return { s: 25 + t * (70 - 25), l: 85 - t * (85 - 55) };
}

function hueCircularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 素材分配改成"全局不重复"（2026-07-13 老婆要求：水中花朵不要重复）：
// 对全量 flowers 一次性分配——每条记忆按心情色把 39 张素材排个序，然后拿
// "色系最接近且还没被用掉"的那张；素材全部用完才清空重来（也就是只有记忆
// 条数超过 39 才可能出现复用）。同一份 flowers 数组算出来的结果永远一样，
// 刷新页面每朵花还是那张图。色系匹配从"硬保证"降级成"尽量"——去重优先。
function buildAssetAssignment(flowers: MurmursFlower[]): Map<string, string> {
  const assigned = new Map<string, string>();
  let used = new Set<string>();
  for (const f of flowers) {
    const targetHue = valenceToHue(f.valence);
    const { s: targetS, l: targetL } = arousalToSatLight(f.arousal);
    const ranked = FLOWER_FILES.map((file) => {
      const tag = FLOWER_COLOR_TAGS[file];
      const dh = hueCircularDist(tag.h, targetHue) / 180; // 0~1
      const ds = Math.abs(tag.s - targetS) / 100;
      const dl = Math.abs(tag.l - targetL) / 100;
      // 色相是 valence 的主要信号，权重给高一点；饱和度/明度权重相近。
      const dist = dh * 2 + ds * 0.6 + dl * 0.6;
      return { file, dist };
    }).sort((a, b) => a.dist - b.dist);
    if (used.size >= FLOWER_FILES.length) used = new Set();
    const pool = ranked.filter((r) => !used.has(r.file));
    // 色系最近的前 3 张里用 id 哈希挑一张——不至于所有"开心"的记忆都按同一个
    // 顺序领同一批花，同色系内部仍有花型差异。
    const top = pool.slice(0, Math.min(3, pool.length));
    const file = top[hashStr(f.id) % top.length].file;
    used.add(file);
    assigned.set(f.id, file);
  }
  return assigned;
}

function assetUrl(file: string): string {
  return `${import.meta.env.BASE_URL}assets/murmurs/${file}`;
}

const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 弹窗里的日期改成右下角落款式小角标，6 位 YYMMDD(比如 260713)——不用
// Unicode 上下标字符(避免字体 fallback 到系统字体，跟卡片其它文字对不上)，
// "缩小+下沉"完全靠 CSS(font-size/位置)做，这里只管拼数字。
const fmtDateStamp = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
};

// 棠予酿 diary 的 title 字段本身常以日期开头(比如"2026-06-12 三个字，就是
// 她递回来的手。棠…")，卡片又单独渲染了一行日期，会重复——只在 title 确实
// 以这条记录自己的日期开头时才剥掉，剥不掉(格式不一样/没有)就原样显示，
// 不瞎猜。
function stripLeadingDatePrefix(title: string, dateIso: string | null): string {
  const trimmed = title.trim();
  const ymd = fmtDate(dateIso);
  if (!ymd || !trimmed.startsWith(ymd)) return trimmed;
  const rest = trimmed.slice(ymd.length).replace(/^[\s、,，.。·:：\-—]+/, '').trim();
  return rest || trimmed;
}

// 真机验收反馈(2026-07-13)：花只能画在水面以下，背景图水面起始线约在屏幕
// 45% 高度处——WATER_LINE_PERCENT 留了 3% 余量，花的落点(含抖动)不会贴到
// 岸边/樱花树那一侧。FAR/NEAR 是"远景→近景"落点带，都在水面线以下。
const WATER_LINE_PERCENT = 45;
const FAR_TOP_PERCENT = WATER_LINE_PERCENT + 3;
const NEAR_TOP_PERCENT = 90;

// 纵深透视：远景小、压扁多、略透明微模糊，模拟隔着水看过去；近景大、
// 压扁少、更实更清晰。第六轮起纵深不再只看时间——"新的和重要值高的在
// 前面，旧的重要值低的在远一点"(老婆原话)：depthScore 由 position(时间)
// 和 size(importance) 加权混合，时间为主、重要度为辅，重要的旧记忆也能
// 往前站一点，鸡毛蒜皮的新记忆则往后退半步。
// 真机验收反馈(2026-07-13 第二轮)：新背景水面开阔，整体调大一档。
const FAR_SIZE_PX: [number, number] = [36, 48];
const NEAR_SIZE_PX: [number, number] = [88, 96];
const FAR_SQUASH_Y = 0.65;
const NEAR_SQUASH_Y = 0.8;
const FAR_OPACITY = 0.78;
const NEAR_OPACITY = 1;
// 远景花在水下更深，隔的水更厚——多一点模糊；近景完全清晰。
const FAR_BLUR_PX = 1.1;
const DEPTH_TIME_WEIGHT = 0.65;
const DEPTH_IMPORTANCE_WEIGHT = 0.35;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function importanceT(flower: MurmursFlower): number {
  return clamp01((flower.size - 0.4) / 0.6);
}

// 0=最远(旧且不重要)，1=最近(新且重要)。
function depthScoreForFlower(flower: MurmursFlower): number {
  return clamp01(
    DEPTH_TIME_WEIGHT * clamp01(flower.position) + DEPTH_IMPORTANCE_WEIGHT * importanceT(flower),
  );
}

function perspectiveForFlower(flower: MurmursFlower) {
  const depthT = depthScoreForFlower(flower);
  // importance 在当前深度带内的相对位置，决定花开多大——重要的记忆即使
  // 在远景也能开得靠近带宽上限。
  const impT = importanceT(flower);
  const bandMin = FAR_SIZE_PX[0] + depthT * (NEAR_SIZE_PX[0] - FAR_SIZE_PX[0]);
  const bandMax = FAR_SIZE_PX[1] + depthT * (NEAR_SIZE_PX[1] - FAR_SIZE_PX[1]);
  const sizePx = Math.round(bandMin + impT * (bandMax - bandMin));
  const squashY = FAR_SQUASH_Y + depthT * (NEAR_SQUASH_Y - FAR_SQUASH_Y);
  const opacity = FAR_OPACITY + depthT * (NEAR_OPACITY - FAR_OPACITY);
  const blurPx = FAR_BLUR_PX * (1 - depthT);
  return { depthT, sizePx, squashY, opacity, blurPx };
}

// 同屏密度上限——提前到这里声明，下面的全局布局函数要用它决定"名次桶"数量
// (后面 useFlowerRotation 那边直接复用这个常量，不再重复声明一份)。
const ROTATION_MAX_VISIBLE = 12;

const LANES = 8;
const LANE_MARGIN_PERCENT = 8;

function laneCenterPercent(lane: number): number {
  const span = 100 - LANE_MARGIN_PERCENT * 2;
  return LANE_MARGIN_PERCENT + (span / LANES) * (lane + 0.5);
}

type FlowerLayout = { left: number; top: number };

// 把 px 尺寸换算成百分比坐标时用的竖屏基准(真机验收都在手机上)。故意不读
// 真实 viewport——坐标必须纯由数据决定(转屏/resize/刷新都不重算不跳动)，
// 基准偏差只影响"间距余量"，屏幕更宽时只会更松，方向是安全的。
const LAYOUT_BASE_W = 400;
const LAYOUT_BASE_H = 850;
// 碰撞半径的余量系数：1.0=刚好贴边，1.12=留 12% 呼吸缝。
const COLLISION_PAD = 1.12;

// 真机反馈踩过两轮坑才定下"全局一次性分配坐标"这个方案："花朵会瞬移/闪烁"：
// - 第二轮：按"同车道内当前排第几个"算 top，排名随同屏花朵增减而变，
//   轮换时没换掉的花也被连带重排。
// - 第四轮：改成"同屏花朵互相推开"的松弛算法，配 CSS transition 想让位移
//   变平滑，但松弛结果依然取决于"此刻同屏是谁"，真机截图看效果还是像瞬移。
// 根本思路：不再"每次同屏渲染时临时算位置"，改成对【全量 flowers 数组】
// 一次性分配坐标——只要 flowers(从后端拉回来的原始数组)不变，每朵花的坐标
// 就永远不变，轮换只决定"现在画不画这朵花"，完全碰不到坐标。
//
// 第七轮(2026-07-13 真机反馈"花朵不要叠一起")把"车道占用表"升级成真正的
// 尺寸感知碰撞检测：老方案只保证"同名次桶内不同车道"，但车道间距(约 10.5%
// 屏宽)比近景花的直径(96px≈24% 屏宽)小得多——相邻车道/相邻名次桶照样叠。
// 新方案按 depthScore 从远到近逐朵落位：每朵花生成一批候选点(自己的深度
// top ± 台阶 × 8 条车道，顺序由 id 哈希决定所以依然确定性)，用"两朵花
// 半径之和"的椭圆距离对已落位的全量花做碰撞检查，取第一个完全不碰的候选；
// 全都碰(花太多水面太挤)就退而求其次拿"离邻居最远"的那个候选——不会有
// 硬保证下的死循环，挤的时候也只是贴得近，不会精确叠死在同一点。
function buildGlobalLayout(flowers: MurmursFlower[]): Map<string, FlowerLayout> {
  const layout = new Map<string, FlowerLayout>();
  if (flowers.length === 0) return layout;
  const byDepth = [...flowers].sort(
    (a, b) => depthScoreForFlower(a) - depthScoreForFlower(b) || hashStr(a.id) - hashStr(b.id),
  );
  const placed: { x: number; y: number; rx: number; ry: number }[] = [];
  // top 候选台阶：优先待在自己 depthScore 对应的深度，实在挤不下才上下挪。
  const DY_STEPS = [0, 2.5, -2.5, 5, -5, 7.5, -7.5];
  for (const f of byDepth) {
    const { sizePx, squashY } = perspectiveForFlower(f);
    const rx = ((sizePx / 2) / LAYOUT_BASE_W) * 100 * COLLISION_PAD;
    const ry = (((sizePx * squashY) / 2) / LAYOUT_BASE_H) * 100 * COLLISION_PAD;
    const depthT = depthScoreForFlower(f);
    const baseTop = FAR_TOP_PERCENT + depthT * (NEAR_TOP_PERCENT - FAR_TOP_PERCENT);
    const jitterTop = (hashStr(`${f.id}-y`) % 300) / 100 - 1.5; // ±1.5%
    const jitterLeft = (hashStr(`${f.id}-x`) % 300) / 100 - 1.5; // ±1.5%
    const startLane = hashStr(`${f.id}-lane`) % LANES;
    let best: FlowerLayout = { left: 50, top: baseTop };
    let bestClearance = -Infinity;
    let found = false;
    for (const dy of DY_STEPS) {
      for (let li = 0; li < LANES && !found; li++) {
        const lane = (startLane + li) % LANES;
        const x = Math.max(4, Math.min(96, laneCenterPercent(lane) + jitterLeft));
        const y = Math.max(
          FAR_TOP_PERCENT,
          Math.min(NEAR_TOP_PERCENT, baseTop + dy + jitterTop),
        );
        // 到最近邻居的归一化椭圆距离：>=1 表示连呼吸缝都没碰到。
        let clearance = Infinity;
        for (const p of placed) {
          const nx = (x - p.x) / (rx + p.rx);
          const ny = (y - p.y) / (ry + p.ry);
          const d = Math.hypot(nx, ny);
          if (d < clearance) clearance = d;
        }
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = { left: x, top: y };
        }
        if (clearance >= 1) found = true;
      }
      if (found) break;
    }
    placed.push({ x: best.left, y: best.top, rx, ry });
    layout.set(f.id, best);
  }
  return layout;
}

function FlowerBloom({
  flower,
  index,
  src,
  left,
  top,
  isExiting,
  onOpen,
}: {
  flower: MurmursFlower;
  index: number;
  src: string;
  left: number;
  top: number;
  isExiting: boolean;
  onOpen: (f: MurmursFlower) => void;
}) {
  const { depthT, sizePx, squashY, opacity, blurPx } = useMemo(
    () => perspectiveForFlower(flower),
    [flower],
  );
  // 晃动的度走过一个来回：第六轮"完全静止"，第七轮老婆反馈"可以有轻微的
  // 晃动感，随着水波晃动"——加回一层 sway，但跟被删掉的旧 bob 是两个量级：
  // 旧 bob 位移 5~15px/转 2~5°/周期 3.4~6s(像漂在浪里)，这版 2~4px/
  // 0.8~1.8°/周期 6.8~10s(像沉在水里被水波轻轻带动)。参数用 id 哈希算，
  // 不用 Math.random——同一朵花每次出场晃的节奏都一样，确定性跟坐标同一个
  // 待遇。
  const sway = useMemo(
    () => ({
      duration: 6800 + (hashStr(`${flower.id}-swd`) % 3200),
      delay: -(hashStr(`${flower.id}-swp`) % 8000),
      dx: 2 + (hashStr(`${flower.id}-swx`) % 20) / 10, // 2~4px
      dy: 1.2 + (hashStr(`${flower.id}-swy`) % 12) / 10, // 1.2~2.4px
      rot: 0.8 + (hashStr(`${flower.id}-swr`) % 10) / 10, // 0.8~1.8°
    }),
    [flower.id],
  );
  return (
    <button
      type="button"
      className={`murmurs-flower${isExiting ? ' murmurs-flower--exiting' : ''}`}
      style={
        {
          top: `${top}%`,
          left: `${left}%`,
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          opacity,
          pointerEvents: isExiting ? 'none' : 'auto',
          '--murmurs-drift-delay': `${Math.min(index * 90, 1600)}ms`,
        } as React.CSSProperties
      }
      onClick={() => onOpen(flower)}
      aria-label={flower.title}
    >
      <div
        className="murmurs-flower__reflection"
        style={{ opacity: 0.35 + depthT * 0.4 }}
        aria-hidden="true"
      />
      <div
        className="murmurs-flower__sway"
        style={
          {
            animationDuration: `${sway.duration}ms`,
            animationDelay: `${sway.delay}ms`,
            '--msdx': `${sway.dx.toFixed(1)}px`,
            '--msdy': `${sway.dy.toFixed(1)}px`,
            '--msrot': `${sway.rot.toFixed(1)}deg`,
          } as React.CSSProperties
        }
      >
        <img
          className="murmurs-flower__img"
          src={src}
          alt=""
          loading="lazy"
          style={{
            transform: `scaleY(${squashY})`,
            // 第七轮"尽量还原花朵的颜色"：之前叠的 saturate(0.9)/brightness
            // (0.98)/hue-rotate(-4deg) 全部去掉，只留投影和远景按深度补的
            // 一点水雾模糊——"沉在水里"的感觉交给下半渐隐 mask + 焦散光纹，
            // 不再动花本身的颜色。
            filter: `drop-shadow(0 3px 7px rgba(60, 30, 100, 0.2))${
              blurPx > 0.05 ? ` blur(${blurPx.toFixed(2)}px)` : ''
            }`,
          }}
        />
      </div>
    </button>
  );
}

// 密度控制：同屏最多 12 朵，花比 12 朵多时按 created_at 顺序轮换——每隔
// ROTATION_INTERVAL_MS 换掉最早入场的一朵(先播"沉入水中"退场动画 EXIT_MS，
// 播完再真正摘掉)，同时按顺序请下一朵原地缓缓浮现，循环往复，
// 不会 30+ 朵同屏堆积。
// EXIT_MS 要跟 CSS 里 murmursFlowerExit 的动画时长(global.css)保持一致——
// 两处对不上就会露出"动画没播完元素就没了"的破绽。
const ROTATION_INTERVAL_MS = 6200;
const EXIT_MS = 2000;

function useFlowerRotation(flowers: MurmursFlower[] | null) {
  const [visible, setVisible] = useState<MurmursFlower[]>([]);
  const [exitingId, setExitingId] = useState<string | null>(null);
  // visibleRef 跟 visible state 保持同步，供 setInterval/setTimeout 回调直接读写——
  // 不把"挑下一朵/推进 cursor"这类副作用塞进 setVisible 的 updater 函数里：
  // React 18 StrictMode 在开发环境会把 updater 函数双调用一次(用来抓这类不纯的
  // 用法)，副作用留在 updater 里就会被多算一次导致同屏数量对不上(实测踩过，
  // 轮换一轮后从 12 变 13)。副作用只放在 interval/timeout 回调本体里，不放
  // updater 里，才不受双调用影响。
  const visibleRef = useRef<MurmursFlower[]>([]);
  const cursorRef = useRef(0);

  useEffect(() => {
    if (!flowers) return;
    // 真机验收发现的堆叠 bug：原来直接取 flowers 的前 12 个，而 flowers 是按
    // created_at 从旧到新排的——"前 12 个"永远是最旧的一小撮，position 值挤在
    // 一段很窄的区间里，纵深透视+车道分布再怎么算也救不了(挤在同一小段窄带
    // 里，抖动幅度盖不住)。改成按下标等距抽样，一开始就横跨整条时间线，
    // 远景近景都有，跟原本"旧记忆越飘越远、新记忆在眼前"的设计意图也更符。
    const count = Math.min(ROTATION_MAX_VISIBLE, flowers.length);
    const step = flowers.length / count;
    const initial: MurmursFlower[] = [];
    const usedIdx = new Set<number>();
    for (let i = 0; i < count; i++) {
      let idx = Math.floor(i * step);
      while (usedIdx.has(idx) && idx < flowers.length - 1) idx++;
      usedIdx.add(idx);
      initial.push(flowers[idx]);
    }
    visibleRef.current = initial;
    setVisible(initial);
    cursorRef.current = count;
    setExitingId(null);
  }, [flowers]);

  useEffect(() => {
    if (!flowers || flowers.length <= ROTATION_MAX_VISIBLE) return; // 花不够 12 朵，用不着轮换
    const timer = window.setInterval(() => {
      const cur = visibleRef.current;
      if (cur.length === 0) return;
      const outgoing = cur[0];
      setExitingId(outgoing.id);
      window.setTimeout(() => {
        const rest = visibleRef.current.filter((f) => f.id !== outgoing.id);
        const total = flowers.length;
        let incoming = flowers[cursorRef.current % total];
        let tries = 0;
        // 花数量刚好比 12 多一点时，下一张可能撞上还在屏幕上的那朵——
        // 顺着往后找一张不在场上的，最多试一轮，避免死循环。
        while (rest.some((f) => f.id === incoming.id) && tries < total) {
          cursorRef.current += 1;
          incoming = flowers[cursorRef.current % total];
          tries += 1;
        }
        cursorRef.current += 1;
        const next = rest.some((f) => f.id === incoming.id) ? rest : [...rest, incoming];
        visibleRef.current = next;
        setVisible(next);
        setExitingId(null);
      }, EXIT_MS);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flowers]);

  return { visible, exitingId };
}

// 水面星光：跟落予棠 .sea-sparkle 同一个样式(global.css 里是通用类)，
// 只是撒点范围限制在水面线以下。模块级算一次，刷新前位置不变。
const MURMUR_SPARKLES = Array.from({ length: 12 }, () => ({
  x: 5 + Math.random() * 90,
  y: WATER_LINE_PERCENT + 4 + Math.random() * (92 - WATER_LINE_PERCENT - 4),
  size: 2 + Math.random() * 3,
  delay: Math.random() * 6,
  dur: 2.8 + Math.random() * 2.4,
}));

// 环境涟漪：没人碰屏幕时水面也不该是死的——每隔几秒在水面区域随机落一圈
// 很轻的涟漪(强度约为触摸默认 0.14 的 1/3)，像风吹过/鱼碰了下水面。跟触摸
// 涟漪共用同一个 WebGL 引擎。OS 开了"减弱动态效果"就不自动落(触摸涟漪保留
// ——那是直接反馈不是环境动效，跟落予棠同一条准则)。
const AMBIENT_DROP_INTERVAL_MS = 3200;

// 从 CSS 已解析好的 background-image 里拿背景图 URL 喂给 WebGL 当纹理，
// 跟落予棠 parseBackgroundUrl 同一个做法——CSS 是唯一事实来源，哪天换图
// 只改 CSS 这边就够。
function parseBackgroundUrl(cssValue: string): string | null {
  const m = /url\(["']?(.*?)["']?\)/.exec(cssValue);
  return m ? m[1] : null;
}

export function MurmursPage() {
  const [flowers, setFlowers] = useState<MurmursFlower[] | null>(null); // null = 加载中
  const [selected, setSelected] = useState<MurmursFlower | null>(null);
  const [ripplesReady, setRipplesReady] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<WaterRipples | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/murmurs/flowers')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setFlowers(Array.isArray(data?.flowers) ? data.flowers : []);
      })
      .catch(() => {
        if (!cancelled) setFlowers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 湖面接 WebGL 涟漪引擎(落予棠定稿的 waterRipples 模块，只调用不改)：
  // 只跑一次。WebGL 不可用/图片加载失败 → createWaterRipples 返回 null，
  // canvas 保持 opacity:0，底下 .murmurs-page 的 CSS 背景图照常显示，
  // 只是没有涟漪(焦散/星光不受影响，仍然叠着)——纯降级，不会黑屏。
  // 不拿 prefers-reduced-motion 挡初始化——触摸涟漪是"手指点哪儿哪儿起一圈"
  // 的直接反馈动画，落予棠真机踩过这个坑(OS 减弱动态一开涟漪整个没反应)。
  useEffect(() => {
    const canvas = canvasRef.current;
    const page = pageRef.current;
    if (!canvas || !page) return;

    let cancelled = false;
    const bgUrl = parseBackgroundUrl(getComputedStyle(page).backgroundImage) ?? '/rooms/murmurs-bg.webp';
    void createWaterRipples(canvas, bgUrl).then((engine) => {
      if (cancelled) {
        engine?.destroy();
        return;
      }
      if (!engine) return; // 不支持就静默降级，waterRipples 里已有 console.error
      engineRef.current = engine;
      engine.start();
      setRipplesReady(true);
    });
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // 环境涟漪定时器——挂在引擎就绪之后，页面在后台标签页时不落(document.hidden)。
  useEffect(() => {
    if (!ripplesReady) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine || document.hidden) return;
      const u = 0.06 + Math.random() * 0.88;
      const v = (WATER_LINE_PERCENT + 4) / 100 + Math.random() * ((94 - WATER_LINE_PERCENT - 4) / 100);
      engine.drop(u, v, 0.9, 0.045);
    }, AMBIENT_DROP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ripplesReady]);

  // 手指/鼠标按在水面 → 该点起真实涟漪(WebGL drop)，跟落予棠同一套：绑在
  // 花朵容器上用 pointerdown，事件照常冒泡，点花=开记忆卡片+落一圈涟漪，
  // 两者独立互不干扰。水面线以上(天空/樱花树)不起涟漪。
  const onWaterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !engineRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < WATER_LINE_PERCENT / 100 || v > 1) return;
    engineRef.current.drop(u, v);
  };

  const isEmpty = flowers !== null && flowers.length === 0;
  const { visible, exitingId } = useFlowerRotation(flowers);
  // 依赖 flowers(拉回来就不再变的原始数组)，不依赖 visible(轮换会变)——
  // 保证每朵花的坐标/素材只算一次，轮换绝对碰不到它们。
  const layout = useMemo(() => buildGlobalLayout(flowers ?? []), [flowers]);
  const assets = useMemo(() => buildAssetAssignment(flowers ?? []), [flowers]);

  // 给蝴蝶用的两个回调都必须恒定引用(MurmursAmbient 的 rAF 循环挂在 effect
  // 里，回调一变循环就重启，蝴蝶会闪回起点)：涟漪走 engineRef；歇脚目标
  // 每次渲染刷进 perchRef，蝴蝶要停的时候现取，正在退场的花不给停。
  const perchRef = useRef<{ x: number; y: number }[]>([]);
  perchRef.current = visible
    .filter((f) => f.id !== exitingId)
    .map((f) => layout.get(f.id))
    .filter((p): p is FlowerLayout => Boolean(p))
    .map((p) => ({ x: p.left, y: p.top }));
  const getPerchTargets = useCallback(() => perchRef.current, []);
  const dropRipple = useCallback(
    (u: number, v: number, radiusScale?: number, strength?: number) => {
      engineRef.current?.drop(u, v, radiusScale, strength);
    },
    [],
  );

  return (
    <main className="murmurs-page" ref={pageRef}>
      <canvas
        ref={canvasRef}
        className={`murmurs-ripples-canvas${ripplesReady ? ' is-ready' : ''}`}
        aria-hidden="true"
      />

      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">倾棠予梦</span>
          <span className="chat-head__sub">Our Murmurs</span>
        </div>
      </header>

      <div className="murmurs-stream" onPointerDown={onWaterPointerDown}>
        {MURMUR_SPARKLES.map((s, i) => (
          <span
            key={i}
            className="sea-sparkle"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.dur}s`,
            }}
          />
        ))}

        {visible.map((f, i) => {
          const pos = layout.get(f.id);
          const src = assets.get(f.id);
          if (!pos || !src) return null;
          return (
            <FlowerBloom
              key={f.id}
              flower={f}
              index={i}
              src={assetUrl(src)}
              left={pos.left}
              top={pos.top}
              isExiting={f.id === exitingId}
              onOpen={setSelected}
            />
          );
        })}

        {isEmpty ? (
          <div
            className="murmurs-flower murmurs-flower--placeholder"
            style={{ top: '48%', left: '50%', width: '44px', height: '44px' }}
            aria-hidden="true"
          >
            <img
              className="murmurs-flower__img"
              src={assetUrl(PLACEHOLDER_BUD_SRC)}
              alt=""
            />
          </div>
        ) : null}
      </div>

      {/* 焦散光纹叠在花朵之上(落予棠是叠在载具之下——那边载具浮在水面上，
          这边花朵沉在水面下，光纹要洒在花身上才像"隔着水看花")。 */}
      <div className="murmurs-caustics" aria-hidden="true" />

      {/* 蝴蝶+樱花瓣(z:3)——飞在水面之上，所以叠在焦散上面。 */}
      <MurmursAmbient dropRipple={dropRipple} getPerchTargets={getPerchTargets} />

      {selected ? (
        <div className="murmurs-detail-backdrop" onClick={() => setSelected(null)}>
          <div className="murmurs-detail" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="murmurs-detail__x"
              onClick={() => setSelected(null)}
              aria-label="关闭"
            >
              ×
            </button>
            {selected.moodLabel ? <span className="murmurs-detail__mood">{selected.moodLabel}</span> : null}
            <span className="murmurs-detail__title">{stripLeadingDatePrefix(selected.title, selected.date)}</span>
            {fmtDateStamp(selected.date) ? (
              <span className="murmurs-detail__stamp">{fmtDateStamp(selected.date)}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
