// 首页第二轮：房间小灯从樱花粉换成薰衣草紫；「他的歌单」图标本身画得小，单独放大一点。
// 只在 global.css 末尾追加（会盖过第一轮的粉灯）；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
const MARK = 'home-clarity-v2';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
css += `

/* ===== ${MARK}：小灯薰衣草紫；他的歌单图标放大 ===== */
.room-tile__dot.is-ready {
  background: radial-gradient(circle at 35% 35%, #f1e6ff 0%, #b994f5 55%, #8f63e0 100%);
  box-shadow: 0 0 0 3px rgba(185, 148, 245, 0.28), 0 0 8px rgba(160, 120, 240, 0.8), inset 0 0 0 1px rgba(255, 255, 255, 0.75);
}
.room-tile__img[src*="his-playlist"] {
  transform: scale(1.4);
}
`;
writeFileSync(CSS, css);
console.log('HOME2-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
