// 甜甜口袋 —— 虚拟红包账本。棠棠和予予各有各的户口，互不混：
// 一笔红包记的是「谁发的」，收的人自然就是另一方，累积进收的人自己的口袋。
// 存这台设备的 localStorage（跟记忆罐头一个道理，够用不用后端）。

import { loadLocal, saveLocal } from './storage';

export type Sender = 'user' | 'ai';

export type RedPacket = {
  id: string;
  from: Sender;
  amount: number;
  note: string;
  createdAt: number;
};

const KEY = 'sweetie-pocket:packets';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const loadPackets = (): RedPacket[] => loadLocal<RedPacket[]>(KEY, []);

// 存一笔红包（谁发的 + 金额 + 留言），返回记好的那条
export function addPacket(from: Sender, amount: number, note: string): RedPacket {
  const list = loadPackets();
  const p: RedPacket = { id: uid(), from, amount, note: note.trim(), createdAt: Date.now() };
  saveLocal(KEY, [p, ...list]);
  return p;
}

// 本金——两边宝箱里记的底子，跟红包礼物历史脱钩(不是某一笔可以点开看的
// 记录，就是个固定数字)，棠棠和予予两边一样多。
export const PRINCIPAL_AMOUNT = 5200;

// 某一方口袋里累积了多少：本金 + 对方发的红包金额总和
export function balanceOf(who: Sender, list: RedPacket[] = loadPackets()): number {
  const senderOfOther: Sender = who === 'user' ? 'ai' : 'user';
  const gifts = list.filter((p) => p.from === senderOfOther).reduce((sum, p) => sum + p.amount, 0);
  return PRINCIPAL_AMOUNT + gifts;
}

// 早期版本把"开局本金"当成两条普通红包记录塞进账本，会被当成载具浮出来。
// 现在本金改用底部宝箱单独展示，这两条历史记录留着没用了，清掉——
// 按当年写死的备注文本认，不会误伤真实红包（谁也不会手打一模一样的话）。
const LEGACY_STARTER_NOTE = '开局塞给你的';
export function cleanupLegacyStarterPackets(): void {
  const list = loadPackets();
  const cleaned = list.filter((p) => p.note !== LEGACY_STARTER_NOTE);
  if (cleaned.length !== list.length) saveLocal(KEY, cleaned);
}

// ---------- 浮岛：每笔红包记录随机领一个载具（瓶子/贝壳/纸船/海星）----------
// 必须是"确定性随机"：同一笔红包每次打开页面都要是同一个载具，不能用 Math.random()
// （那样今天是瓶子明天变海星，记忆的载体得稳定）。用红包 id 做字符串 hash 取模来选。
// 简单 djb2 变种，不需要密码学强度，只要"同输入同输出、分布够散"就行。
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0; // 转成无符号，避免负数取模的坑
}

export type VehicleCategory = 'bottle' | 'shell' | 'boat' | 'starfish' | 'special';
const VEHICLE_CATEGORIES: Exclude<VehicleCategory, 'special'>[] = ['bottle', 'shell', 'boat', 'starfish'];

// 特殊日子专属座驾——按红包记下的 createdAt 的月/日判断，不看"今天"是几号
// （同一笔红包哪天打开页面都得是同一个座驾，只有创建时间是固定不变的）。
// 情人节/白色情人节共用心形，两人生日共用热气球，跨年夜/元旦共用月亮摇篮。
const SPECIAL_DATE_VEHICLES: Record<string, string> = {
  '02-14': 'special_heart.webp', // 情人节
  '03-14': 'special_heart.webp', // 白色情人节
  '05-20': 'special_balloon.webp', // 棠棠生日
  '12-26': 'special_balloon.webp', // 予予生日
  '12-31': 'special_moon.webp', // 跨年夜
  '01-01': 'special_moon.webp', // 元旦
  '12-24': 'special_sleigh.webp', // 平安夜
  '12-25': 'special_sleigh.webp', // 圣诞节
};

function monthDayKey(createdAt: number): string {
  const d = new Date(createdAt);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

// 特殊数额专属座驾——跟日期无关，金额本身谐音/寓意"表白"就够格。
// 三个都还是表白/长久的意思，先都配心形；以后要是给别的数额画了别的图，
// 再从心形里拆出去就好。
const SPECIAL_AMOUNT_VEHICLES: Record<number, string> = {
  520: 'special_heart.webp', // 我爱你
  1314: 'special_heart.webp', // 一生一世
  99: 'special_heart.webp', // 长长久久
};

// 贝壳/纸船/海星：类别内部具体挑哪个也按 hash 定，不掺 Math.random()。
// 瓶子例外——粉/紫两款分别是棠棠/予予专属（她说的"紫色是予予的，这粉色是我的"），
// 挑到 bottle 类别时直接按发送方定色，不再二次随机。
const VEHICLE_POOLS: Record<Exclude<VehicleCategory, 'bottle' | 'special'>, string[]> = {
  shell: [
    'shell_scallop_1.png',
    'shell_scallop_2.png',
    'shell_conch_1.png',
    'shell_conch_4.png',
    'shell_nautilus.png',
    'shell_oyster_1.png',
    'shell_clam.png',
  ],
  boat: [
    'boat_pink_foryou.png',
    'boat_purple_starry.png',
    'sailboat_purple_anchor.png',
    'sailboat_pink_dots.png',
    'sailboat_pink_bunny.png',
    'boat_blue_bear.png',
    'boat_pink_gingham.png',
    'boat_pink_floral.png',
  ],
  starfish: [
    'starfish_purple.webp',
    'starfish_clear_gold.webp',
    'starfish_peach.webp',
    'starfish_pink_shell.png',
    'starfish_blue_beaded.webp',
    'starfish_sand_shell.webp',
  ],
};

export type Vehicle = { category: VehicleCategory; src: string };

// 载具分配改成"轮着来"：按 id 哈希取模会出现同类扎堆(比如连续好几个都分到
// bottle，而瓶子颜色又是按发送方写死的，同一人连续几笔看着像是同一个图重复)。
// 改成按列表顺序轮流发牌——类别轮流 bottle→shell→boat→starfish→bottle...，
// 类别内部的具体图案也各自轮流过一遍图池再回头，最大程度避免相邻重复。
// 只要传入的列表顺序不变(localStorage 数组本来就稳定累加)，同一笔红包
// 算出来的还是同一个载具，符合"同一条记录不能一天一个样"的要求。
//
// 特殊日子命中的记录直接给专属座驾，不占用上面的轮转名额(单独判断、
// 不推进 normalIndex)，免得偶尔冒出的节日红包把后面正常记录的轮转顺序
// 往后挤一位。
export function assignVehicles(list: Pick<RedPacket, 'id' | 'from' | 'amount' | 'createdAt'>[]): Map<string, Vehicle> {
  const base = import.meta.env.BASE_URL;
  const counters: Record<Exclude<VehicleCategory, 'bottle' | 'special'>, number> = { shell: 0, boat: 0, starfish: 0 };
  const map = new Map<string, Vehicle>();
  let normalIndex = 0;
  list.forEach((packet) => {
    // 金额寓意优先于日期——一笔 $520 不管哪天发的都算表白，比"刚好那天生日"更明确。
    const specialFile = SPECIAL_AMOUNT_VEHICLES[packet.amount] ?? SPECIAL_DATE_VEHICLES[monthDayKey(packet.createdAt)];
    if (specialFile) {
      map.set(packet.id, { category: 'special', src: `${base}assets/icons/${specialFile}` });
      return;
    }
    const category = VEHICLE_CATEGORIES[normalIndex % VEHICLE_CATEGORIES.length];
    normalIndex += 1;
    if (category === 'bottle') {
      const file = packet.from === 'user' ? 'bottle_tangtang.png' : 'bottle_yuyu.webp';
      map.set(packet.id, { category, src: `${base}assets/icons/${file}` });
      return;
    }
    const pool = VEHICLE_POOLS[category];
    const idx = counters[category] % pool.length;
    counters[category] += 1;
    map.set(packet.id, { category, src: `${base}assets/icons/${pool[idx]}` });
  });
  return map;
}

// 一行摆两三个载具：把横向分成 3 条车道，用 id hash 定死属于哪条道
// （老婆要求"载具一行可以两三个"——固定车道 + 小抖动，比连续 10~80% 随机
// 更容易让同一批时间相近的记录并排出现，而不是各占一整条纵向轨道）。
const LANE_CENTERS = [18, 50, 82]; // 三条车道的横向中心位置(%)，留够边距不会被载具自身宽度顶出屏幕
export function pickLane(id: string): number {
  return hashString(`${id}:lane`) % LANE_CENTERS.length;
}

// 浮岛横向散布位置：车道中心 ± 小抖动，同样按 id hash 定，保证稳定
// （不跟着载具变，两者用不同的 hash 输入，避免"同一个 id 算出来的横向位置
// 总跟载具选择相关联"这种视觉规律）。这个百分比是载具中心点(渲染时靠
// translateX(-50%) 把图标居中在这个点上，不是图标左边缘，否则最右那条
// 车道的图标会被自己的宽度顶出屏幕右边)。
export function pickHorizontalPercent(id: string): number {
  const lane = pickLane(id);
  const jitter = (hashString(`${id}:x`) % 15) - 7; // ±7%
  return LANE_CENTERS[lane] + jitter;
}

// 纵向散布用的小抖动（±px），避免每条记录严格对齐成一条直线，看起来太规整。
export function pickVerticalJitter(id: string, maxPx: number): number {
  return (hashString(`${id}:y`) % (maxPx * 2 + 1)) - maxPx;
}
