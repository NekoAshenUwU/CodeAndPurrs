// 落予棠 —— 红包开启音效。
// 优先播放真实音效文件(先试 coin.wav 再试 coin.mp3);找不到/加载失败自动回退
// 到 Web Audio 合成的"硬币叮当"声(不依赖素材文件也能有声音)。
// 想换真声就把 .wav 或 .mp3 扔到 public/assets/sound/,浏览器强刷即生效。
const SOUND_ENABLED = true;
const REAL_COIN_URLS = [
  `${import.meta.env.BASE_URL}assets/sound/coin.wav`,
  `${import.meta.env.BASE_URL}assets/sound/coin.mp3`,
];

// 单次探测:第一次调用时 fetch 一下真声音文件在不在,in-memory 记结果,
// 第二次开始要么直接播文件、要么直接合成,不重复请求。
// null = 还没探过；true = 有文件,能用；false = 没有/加载不了,永远走合成。
let realCoinAvailable: boolean | null = null;
let realCoinBuffer: AudioBuffer | null = null;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    // iOS Safari：AudioContext 建好后可能还是 suspended，得在用户手势里 resume——
    // 点红包这个点击本身就是交互，在点击回调里调用本函数正好满足这个条件。
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

// 之前拿几个纯音（oscillator）按音高先后排列，听起来像"鸟叫"（几个不同音高的短促纯音
// 连续出现，本来就是合成鸟鸣最常用的手法）——真实硬币碰撞是没有明确音高的、带金属质感
// 的宽频噪声，所以改用"白噪声过窄带带通滤波器"来合成：没有旋律感，只有一声亮而短的
// "叮"，才是金属碰撞该有的质感。
function metalClink(ctx: AudioContext, startAt: number, duration: number, gain: number, filterFreq: number) {
  const bufferSize = Math.max(1, Math.ceil(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1; // 白噪声

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = filterFreq;
  bandpass.Q.value = 7; // 窄一点才聚出"金属音高感"，太宽就变白噪声嘶嘶声

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(gain, startAt);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  noise.connect(bandpass).connect(gainNode).connect(ctx.destination);
  noise.start(startAt);
  noise.stop(startAt + duration + 0.02);
}

// 硬币/零钱质感的配置：几枚"硬币"错开落下时间、依次收尾，模拟几枚硬币先后碰撞。
// 想调"几枚硬币"/音色/节奏，改这个数组就行，不用动上面的合成逻辑。
// gain 各上调 ~50%（老婆手机上说"音效没了"，最可能就是原来 0.15~0.26 的音量
// 混过背景音乐时几乎听不见，先当保底修——真声音接进来之后就走文件不走这段了）。
const COIN_CLINKS: { filterFreq: number; startAt: number; duration: number; gain: number }[] = [
  { filterFreq: 4200, startAt: 0, duration: 0.045, gain: 0.4 }, // 第一枚，稍重
  { filterFreq: 5600, startAt: 0.028, duration: 0.035, gain: 0.3 }, // 第二枚，更亮更小
  { filterFreq: 4800, startAt: 0.05, duration: 0.03, gain: 0.22 }, // 第三枚，尾音收着
];

// 播真声音文件——用 AudioBuffer 提前 decode 好,之后每次开红包直接 BufferSource
// 播,零延迟。第一次调用时懒加载,依次尝试 REAL_COIN_URLS 里的每个路径,
// 第一个成功的就用；全都失败就把 realCoinAvailable 置 false 永久回退合成。
async function tryLoadRealCoin(ctx: AudioContext): Promise<void> {
  if (realCoinAvailable !== null) return; // 已经探过了
  for (const url of REAL_COIN_URLS) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const arrayBuffer = await resp.arrayBuffer();
      realCoinBuffer = await ctx.decodeAudioData(arrayBuffer);
      realCoinAvailable = true;
      return;
    } catch {
      // 这个 url 挂了,试下一个
    }
  }
  realCoinAvailable = false;
}

function playRealCoin(ctx: AudioContext): void {
  if (!realCoinBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = realCoinBuffer;
  const gainNode = ctx.createGain();
  gainNode.gain.value = 0.9; // 真声源一般已经 mixed 好,不用像合成那样疯狂 boost
  src.connect(gainNode).connect(ctx.destination);
  src.start();
}

function playSynthCoin(ctx: AudioContext): void {
  const now = ctx.currentTime;
  for (const clink of COIN_CLINKS) {
    metalClink(ctx, now + clink.startAt, clink.duration, clink.gain, clink.filterFreq);
  }
}

// 拆红包音效：优先播 /assets/sound/coin.mp3（真硬币录音），没有就回退到合成的
// 窄带噪声脉冲。播放失败静默降级，绝不抛错卡住开红包的动效。
export function playHongbaoChime(): void {
  if (!SOUND_ENABLED) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    // 首次调用会 async 加载真声文件,但为了不阻塞开红包的动效,这次调用先播合成的、
    // 加载好之后下一次开红包就走真声了。realCoinAvailable 已确定后走各自分支。
    if (realCoinAvailable === null) {
      void tryLoadRealCoin(ctx);
      playSynthCoin(ctx); // 首次先合成兜底
      return;
    }
    if (realCoinAvailable && realCoinBuffer) {
      playRealCoin(ctx);
    } else {
      playSynthCoin(ctx);
    }
  } catch {
    // 静默降级
  }
}
