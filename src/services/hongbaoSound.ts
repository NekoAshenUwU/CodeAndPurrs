// 甜甜口袋 —— 红包开启音效。默认用 Web Audio API 合成一声"叮～"，不依赖素材文件。
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
  osc.type = 'sine';
  osc.frequency.value = freq;
  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.008);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gainNode).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

// 拆红包的"叮～"：两个短正弦音 E6 → A6，各约 80ms，带快速衰减，音量压低不刺耳。
// 播放失败（AudioContext 建不了、被静音策略挡住等）静默降级，绝不抛错卡住开红包的动效。
export function playHongbaoChime(): void {
  if (!SOUND_ENABLED) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    beep(ctx, 1318.51, now, 0.08, 0.28); // E6
    beep(ctx, 1760.0, now + 0.08, 0.09, 0.24); // A6
  } catch {
    // 静默降级
  }
}
