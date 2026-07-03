// 甜甜口袋 —— 红包开启音效。默认用 Web Audio API 合成"硬币叮当"声，不依赖素材文件。
// 以后想换成真实音效素材：保留 SOUND_ENABLED 这个总开关，playHongbaoChime() 内部
// 改成 new Audio('/assets/sound/xxx.mp3').play() 即可，调用方（RedPacketBubble）不用动。
const SOUND_ENABLED = true;

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

function beep(ctx: AudioContext, freq: number, startAt: number, duration: number, gain: number) {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = 'triangle'; // 比正弦波多点谐波，听着更"金属"，接近硬币质感而不是纯钟音
  osc.frequency.value = freq;
  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gainNode).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

// 硬币/零钱质感的配置：几声高频短音，错开起振时间、依次衰减，模拟几枚硬币先后碰撞。
// 想调"几枚硬币"/音高/节奏，改这个数组就行，不用动下面的合成逻辑。
// 以后想换成真实音效素材：保留 SOUND_ENABLED 这个总开关，playHongbaoChime() 内部
// 改成 new Audio('/assets/sound/xxx.mp3').play() 即可，调用方（RedPacketBubble）不用动。
const COIN_CLINKS: { freq: number; startAt: number; duration: number; gain: number }[] = [
  { freq: 3136, startAt: 0, duration: 0.05, gain: 0.22 }, // 第一枚，稍重
  { freq: 4186, startAt: 0.035, duration: 0.045, gain: 0.17 }, // 第二枚，音高一点
  { freq: 3520, startAt: 0.065, duration: 0.04, gain: 0.13 }, // 第三枚，尾音收着
];

// 拆红包的"叮当～"：几声高频短音错开衰减，模拟硬币碰撞，音量压低不刺耳。
// 播放失败（AudioContext 建不了、被静音策略挡住等）静默降级，绝不抛错卡住开红包的动效。
export function playHongbaoChime(): void {
  if (!SOUND_ENABLED) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const clink of COIN_CLINKS) {
      beep(ctx, clink.freq, now + clink.startAt, clink.duration, clink.gain);
    }
  } catch {
    // 静默降级
  }
}
