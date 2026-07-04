// 落予棠 —— 红包开启音效。默认用 Web Audio API 合成"硬币叮当"声，不依赖素材文件。
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
// 以后想换成真实音效素材：保留 SOUND_ENABLED 这个总开关，playHongbaoChime() 内部
// 改成 new Audio('/assets/sound/xxx.mp3').play() 即可，调用方（RedPacketBubble）不用动。
const COIN_CLINKS: { filterFreq: number; startAt: number; duration: number; gain: number }[] = [
  { filterFreq: 4200, startAt: 0, duration: 0.045, gain: 0.26 }, // 第一枚，稍重
  { filterFreq: 5600, startAt: 0.028, duration: 0.035, gain: 0.2 }, // 第二枚，更亮更小
  { filterFreq: 4800, startAt: 0.05, duration: 0.03, gain: 0.15 }, // 第三枚，尾音收着
];

// 拆红包的"叮当～"：几声窄带噪声短脉冲错开衰减，模拟硬币碰撞，音量压低不刺耳。
// 播放失败（AudioContext 建不了、被静音策略挡住等）静默降级，绝不抛错卡住开红包的动效。
export function playHongbaoChime(): void {
  if (!SOUND_ENABLED) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const clink of COIN_CLINKS) {
      metalClink(ctx, now + clink.startAt, clink.duration, clink.gain, clink.filterFreq);
    }
  } catch {
    // 静默降级
  }
}
