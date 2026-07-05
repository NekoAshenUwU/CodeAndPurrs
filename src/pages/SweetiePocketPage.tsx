import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  assignVehicles,
  balanceOf,
  loadPackets,
  pickHorizontalPercent,
  pickLane,
  pickVerticalJitter,
  PRINCIPAL_AMOUNT,
  type RedPacket,
  type Vehicle,
} from '../services/redPacket';

const fmtStamp = (at: number): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const SLOT_HEIGHT = 92; // 每一"行"纵向占的高度(px)，越往下越早
const JITTER_MAX = 16; // 纵向随机抖动，别让同一行严格对齐成一条线

// 三条车道各自独立叠"行"：同一车道内后面的记录(更老)排到下一行，
// 不同车道各走各的行号，于是同一行经常并排站着 2~3 个载具，
// 而不是每条记录都单占一整条纵向轨道。
function assignRows(packets: RedPacket[]): { rows: number[]; maxRow: number } {
  const laneNext = [0, 0, 0];
  const rows = packets.map((p) => {
    const lane = pickLane(p.id);
    const row = laneNext[lane];
    laneNext[lane] += 1;
    return row;
  });
  const maxRow = Math.max(0, ...laneNext.map((n) => n - 1));
  return { rows, maxRow };
}

// 余额只会越攒越多，数字位数迟早变长——固定字号迟早会顶出云心那块窄窗口
// (予予那张图云心本来就比棠棠窄，最先顶出去)。改成按显示字符数分级缩小，
// 一次性解决"以后余额涨了又要来改字号"的问题，而不是每次涨了再调一次。
function amountFontSize(text: string): string {
  if (text.length <= 4) return '1.45rem';
  if (text.length === 5) return '1.3rem';
  if (text.length === 6) return '1.1rem';
  return '0.95rem';
}

// 予予/棠棠的余额浮岛面板——图本身是完整场景(男孩/女孩+雪豹/小猫坐在浮岛上，
// 头顶一圈糖霜云中心留白)，余额数字用绝对定位叠在云心那块空白区域上。
// 云朵里只放数额，不放别的文字（老婆明确要求），who 只留给 aria-label 给读屏用。
function BalanceIsland({ who, amount, side }: { who: string; amount: number; side: 'left' | 'right' }) {
  const src =
    side === 'left'
      ? `${import.meta.env.BASE_URL}assets/icons/balance_island_tangtang.webp`
      : `${import.meta.env.BASE_URL}assets/icons/balance_island_yuyu.webp`;
  // 云朵里只取整——偶尔一笔带小数的红包(比如 $20.50)会让总额多出".xx"三个字符，
  // 两边字数一下差一大截，字号分级跟着差很多，看着"一边大一边小"不对称。
  // 云朵本来就只是一眼扫过的概览数字，取整不影响弹窗详情里看到的精确金额。
  const text = `$${Math.round(amount)}`;
  return (
    <div className={`balance-island balance-island--${side}`} role="img" aria-label={`${who} ${text}`}>
      <img className="balance-island__art" src={src} alt="" />
      <span className="balance-island__amount" style={{ fontSize: amountFontSize(text) }}>
        {text}
      </span>
    </div>
  );
}

// 本金宝箱——沉在海底最深处，比任何漂浮的红包都早、都老，记的是两边口袋的
// 老本(跟礼物历史脱钩，就是个固定数字)。图本身是精致的珠宝插画，不在上面
// 叠字(会把这张图的风格弄乱)，改成跟漂浮物一样点一下弹窗看金额。
function TreasureChest({
  who,
  side,
  onOpen,
}: {
  who: 'user' | 'ai';
  side: 'left' | 'right';
  onOpen: (who: 'user' | 'ai') => void;
}) {
  const src =
    side === 'left'
      ? `${import.meta.env.BASE_URL}assets/icons/chest_tangtang.webp`
      : `${import.meta.env.BASE_URL}assets/icons/chest_yuyu.webp`;
  const label = who === 'user' ? '棠棠' : '予予';
  return (
    <button type="button" className="treasure-chest" onClick={() => onOpen(who)} aria-label={`${label}的本金`}>
      <img className="treasure-chest__art" src={src} alt="" />
    </button>
  );
}

// 特殊座驾点开弹窗时飘的特效——按图片文件名认哪个主题，不额外记状态。
// 情人节/白色情人节/520/1314/99 共用心形图，配爱心；圣诞配雪花；跨年配
// 星星；生日配彩色粒子。樱花老婆提过但目前没有哪个节日配它，先留着
// 类型占位，等她说要给哪个场合用再接上。
type FxKind = 'hearts' | 'stars' | 'particles' | 'snow' | 'sakura';
const FX_EMOJI: Record<FxKind, string[]> = {
  hearts: ['💜', '💗', '💕'],
  stars: ['⭐', '✨', '🌟'],
  particles: ['✨', '🎉', '🎊'],
  snow: ['❄️', '❅', '❆'],
  sakura: ['🌸', '🌸', '🌸'],
};
function fxKindFor(vehicle: Vehicle | null | undefined): FxKind | null {
  if (!vehicle || vehicle.category !== 'special') return null;
  if (vehicle.src.includes('special_heart')) return 'hearts';
  if (vehicle.src.includes('special_sleigh')) return 'snow';
  if (vehicle.src.includes('special_moon')) return 'stars';
  if (vehicle.src.includes('special_balloon')) return 'particles';
  return null;
}

// 一批飘散的 emoji 粒子，从底部往上飘、边飘边淡出，无限循环——弹窗开着
// 就一直飘。相位/速度真随机就好(不是漂浮物那种要跨刷新稳定的东西，
// 弹窗一关就没了，没有"下次打开要一样"的要求)。
function SpecialEffect({ kind }: { kind: FxKind }) {
  const particles = useMemo(() => {
    const pool = FX_EMOJI[kind];
    return Array.from({ length: 16 }, (_, i) => ({
      id: i,
      emoji: pool[Math.floor(Math.random() * pool.length)],
      left: Math.random() * 100,
      size: 14 + Math.random() * 14,
      duration: 2600 + Math.random() * 2400,
      delay: -Math.random() * 4500,
      drift: (Math.random() - 0.5) * 70,
    }));
  }, [kind]);
  return (
    <div className="sweetie-fx" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="sweetie-fx__particle"
          style={
            {
              left: `${p.left}%`,
              fontSize: `${p.size}px`,
              animationDuration: `${p.duration}ms`,
              animationDelay: `${p.delay}ms`,
              '--fx-drift': `${p.drift}px`,
            } as CSSProperties
          }
        >
          {p.emoji}
        </span>
      ))}
    </div>
  );
}

// 单个漂浮物：外层做静态缩放+降饱和（深度感，不参与动画），内层做浮动 keyframe。
// 两层拆开是因为同一个元素上 transform 只能生效一份，静态缩放跟动画位移写在一起会互相覆盖。
function FloatingVehicle({
  packet,
  vehicle,
  row,
  maxRow,
  onOpen,
}: {
  packet: RedPacket;
  vehicle: Vehicle;
  row: number;
  maxRow: number;
  onOpen: (p: RedPacket, vehicle: Vehicle) => void;
}) {
  const outerRef = useRef<HTMLButtonElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // 浮动动画参数：相位/周期允许真随机（她说了这条不用稳定），只在挂载时算一次，
  // 不跟着重渲染变——不然每次 React 重渲染幅度/周期都会跳变，一样显得假。
  const anim = useMemo(
    () => ({
      duration: 3200 + Math.random() * 2600, // 3.2s~5.8s 一个浮动周期
      delay: -Math.random() * 5000, // 负延迟=直接从周期中间某一帧起摆，避免一开场所有物件同步
      dx: 6 + Math.random() * 10,
      dy: 8 + Math.random() * 12,
      rot: 2 + Math.random() * 4,
    }),
    [],
  );

  // 滚出可视区就暂停浮动动画（省性能）；rootMargin 留 100px 缓冲，
  // 别刚滚出一像素就暂停，边缘会闪。直接操作 DOM style，不进 React state，
  // 免得每次进出视口都触发一次组件重渲染。
  useEffect(() => {
    const el = outerRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        inner.style.animationPlayState = entry.isIntersecting ? 'running' : 'paused';
      },
      { rootMargin: '100px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const leftPct = useMemo(() => pickHorizontalPercent(packet.id), [packet.id]);
  const jitter = useMemo(() => pickVerticalJitter(packet.id, JITTER_MAX), [packet.id]);

  const depthFrac = maxRow > 0 ? row / maxRow : 0; // 0=最新(顶) ~ 1=最老(最深)
  const topPx = row * SLOT_HEIGHT + SLOT_HEIGHT / 2 + jitter;
  const scale = 1 - depthFrac * 0.35; // 最深缩到 0.65
  const saturate = 1 - depthFrac * 0.45; // 最深降到约 0.55

  return (
    <button
      type="button"
      ref={outerRef}
      className={`floatvic floatvic--${vehicle.category}`}
      onClick={() => onOpen(packet, vehicle)}
      style={
        {
          left: `${leftPct}%`,
          top: `${topPx}px`,
          // leftPct 是载具"中心点"，先 translateX(-50%) 把图标居中在这个点上
          // (不然图标是按左边缘定位，靠右的车道会被自己的宽度顶出屏幕右边)，
          // 深度缩放接在同一个 transform 里，跟内层的浮动动画分层互不干扰。
          transform: `translateX(-50%) scale(${scale})`,
          filter: `saturate(${saturate})`,
        } as CSSProperties
      }
      aria-label={`${packet.from === 'user' ? '棠棠' : '予予'}发的红包 $${packet.amount}`}
    >
      <div
        ref={innerRef}
        className="floatvic__inner"
        style={
          {
            animationDuration: `${anim.duration}ms`,
            animationDelay: `${anim.delay}ms`,
            '--fdx': `${anim.dx}px`,
            '--fdy': `${anim.dy}px`,
            '--frot': `${anim.rot}deg`,
          } as CSSProperties
        }
      >
        <img className="floatvic__img" src={vehicle.src} alt="" />
      </div>
    </button>
  );
}

// 落予棠 —— 棠棠和予予各自的虚拟红包户口(互不混,各自只累积对方发来的)。
// 发红包在呼噜频道「＋ → 红包」里(像微信一样能写留言)，这里看成"浮岛"：
// 每笔红包记录随机领一个漂流瓶/贝壳/纸船/海星，越往下越早、海越深，
// 点开看日期金额寄语。
export function SweetiePocketPage() {
  const [packets] = useState<RedPacket[]>(loadPackets);
  const [selected, setSelected] = useState<{ packet: RedPacket; vehicle: Vehicle } | null>(null);
  const [selectedChest, setSelectedChest] = useState<'user' | 'ai' | null>(null);
  const userBalance = useMemo(() => balanceOf('user', packets), [packets]);
  const aiBalance = useMemo(() => balanceOf('ai', packets), [packets]);

  const { rows, maxRow } = useMemo(() => assignRows(packets), [packets]);
  const vehicles = useMemo(() => assignVehicles(packets), [packets]);
  const seaHeight = (maxRow + 1) * SLOT_HEIGHT + SLOT_HEIGHT;

  return (
    <main className="sweetie-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">落予棠</span>
          <span className="chat-head__sub">Every Drop For You · 虚拟红包</span>
        </div>
      </header>

      <BalanceIsland who="棠棠的口袋" amount={userBalance} side="left" />
      <BalanceIsland who="予予的口袋" amount={aiBalance} side="right" />

      <div className="memory-scroll sweetie-sea-scroll">
        {packets.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🧧</div>
            <p>口袋还空空的</p>
            <span>发第一个红包试试吧</span>
          </div>
        ) : (
          <div className="sweetie-sea" style={{ height: seaHeight }}>
            {/* 海面动态海浪:三条描边浪线错峰漂 + 月光光斑
                fill:none 描边线, 像浪尖泛光,不像糊层雾 */}
            <div className="sea-waves" aria-hidden="true">
              <svg className="wave wave-1" viewBox="0 0 1440 120" preserveAspectRatio="none">
                <path
                  d="M0,60 C180,100 360,20 540,60 C720,100 900,20 1080,60 C1260,100 1350,40 1440,60"
                  fill="none"
                  stroke="rgba(255,235,240,0.4)"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                />
              </svg>
              <svg className="wave wave-2" viewBox="0 0 1440 120" preserveAspectRatio="none">
                <path
                  d="M0,70 C240,30 480,110 720,70 C960,30 1200,110 1440,70"
                  fill="none"
                  stroke="rgba(255,225,235,0.28)"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              {/* 第三层: 更透明更慢, 拉纵深 */}
              <svg className="wave wave-3" viewBox="0 0 1440 120" preserveAspectRatio="none">
                <path
                  d="M0,50 C300,90 600,10 900,50 C1200,90 1350,30 1440,50"
                  fill="none"
                  stroke="rgba(255,240,245,0.18)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
              <div className="sea-glint" />
            </div>
            {packets.map((p, i) => (
              <FloatingVehicle
                key={p.id}
                packet={p}
                vehicle={vehicles.get(p.id)!}
                row={rows[i]}
                maxRow={maxRow}
                onOpen={(p, v) => setSelected({ packet: p, vehicle: v })}
              />
            ))}
          </div>
        )}

        <div className="treasure-chest-row">
          <TreasureChest who="user" side="left" onOpen={setSelectedChest} />
          <TreasureChest who="ai" side="right" onOpen={setSelectedChest} />
        </div>
      </div>

      {selected ? (
        <div className="sweetie-detail-backdrop" onClick={() => setSelected(null)}>
          {fxKindFor(selected.vehicle) ? <SpecialEffect kind={fxKindFor(selected.vehicle)!} /> : null}
          <div className="sweetie-detail" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="sweetie-detail__x"
              onClick={() => setSelected(null)}
              aria-label="关闭"
            >
              ×
            </button>
            <span className="sweetie-detail__from">
              {selected.packet.from === 'user' ? '棠棠 → 予予' : '予予 → 棠棠'}
            </span>
            <span className="sweetie-detail__amount">${selected.packet.amount}</span>
            {selected.packet.note ? <p className="sweetie-detail__note">{selected.packet.note}</p> : null}
            <span className="sweetie-detail__time">{fmtStamp(selected.packet.createdAt)}</span>
          </div>
        </div>
      ) : null}

      {selectedChest ? (
        <div className="sweetie-detail-backdrop" onClick={() => setSelectedChest(null)}>
          <div className="sweetie-detail" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="sweetie-detail__x"
              onClick={() => setSelectedChest(null)}
              aria-label="关闭"
            >
              ×
            </button>
            <span className="sweetie-detail__from">{selectedChest === 'user' ? '棠棠的本金' : '予予的本金'}</span>
            <span className="sweetie-detail__amount">${PRINCIPAL_AMOUNT}</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}
