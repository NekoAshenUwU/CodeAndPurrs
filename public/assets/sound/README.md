# 红包开启音效

代码里 `src/services/hongbaoSound.ts` 会在拆红包时优先播这个目录下的
`coin.mp3`（真硬币录音），找不到就回退到合成的窄带噪声脉冲。

## 想换成真声：

1. 找一段清脆的硬币碰撞录音（推荐时长 200~500ms，格式 mp3）
   - [freesound.org](https://freesound.org) 搜 "coin drop" / "coins jingle"（CC0 免费）
   - [pixabay.com/sound-effects](https://pixabay.com/sound-effects/) 搜 "coin"
2. 命名为 `coin.mp3`，放到这个目录（也就是 `public/assets/sound/coin.mp3`）
3. `git add && git commit && git push`，VPS 那边 `git pull && npm run build && pm2 restart` 就行

代码不用改，浏览器强刷之后自动切成真声（第一次拆红包懒加载探到文件后
从下一次开始生效）。

## 合成 fallback 的调音入口：

`hongbaoSound.ts` 里 `COIN_CLINKS` 数组，三枚硬币的 filterFreq / duration / gain
调调这个数组就行，不用碰底下的 metalClink() 合成逻辑。
