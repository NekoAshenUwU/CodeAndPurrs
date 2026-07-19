# 红包开启音效

代码里 `src/services/hongbaoSound.ts` 会在拆红包时优先播这个目录下的
真声音文件（依次找 `coin.wav`, `coin.mp3`；找到就用，找不到就回退到
Web Audio 合成的窄带噪声脉冲）。

## 当前音效

`coin.wav` —— clinkingcoins9 by AlexZavesa（freesound.org #853714, CC0），
0.79s / 44.1kHz / stereo，硬币碰撞质感。

## 想再换其它音效

1. 找一段清脆的硬币碰撞录音（推荐时长 200~800ms，wav 或 mp3 都行）
   - [freesound.org](https://freesound.org)（免费注册后 CC0 音效可下）
   - [pixabay.com/sound-effects](https://pixabay.com/sound-effects/)（不用注册）
2. 命名 `coin.wav` 或 `coin.mp3`，放到这个目录覆盖旧的
3. `git add && git commit && git push`，VPS `git pull && npm run build && pm2 restart`

代码不用改，浏览器强刷之后自动生效（第一次拆红包懒加载探到文件后从下一次开始生效）。

## 合成 fallback 的调音入口

`hongbaoSound.ts` 里 `COIN_CLINKS` 数组，三枚硬币的 filterFreq / duration / gain
调这个数组就行，不用碰底下的 `metalClink()` 合成逻辑。
