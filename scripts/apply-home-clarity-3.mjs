// 首页第三轮：紫色小灯加柔光晕（去掉生硬的外圈），并且全站去掉点屏幕时的蓝色点击高亮。
// 只在 global.css 末尾追加；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
const MARK = 'home-clarity-v3';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
css += `

/* ===== ${MARK}：紫灯柔光晕；全站去掉蓝色点击高亮 ===== */
.room-tile__dot.is-ready {
  background: radial-gradient(circle at 38% 35%, #ffffff 0%, #e6d6ff 30%, #b28cf2 70%, #9a6fe6 100%);
  box-shadow:
    0 0 0 1.5px rgba(255, 255, 255, 0.95),
    0 0 8px 3px rgba(150, 95, 255, 0.85),
    0 0 18px 7px rgba(175, 120, 255, 0.5);
  animation: cp-dot-breathe 3.2s ease-in-out infinite;
}
@keyframes cp-dot-breathe {
  0%, 100% { box-shadow: 0 0 0 1.5px rgba(255,255,255,0.95), 0 0 8px 3px rgba(150,95,255,0.85), 0 0 18px 7px rgba(175,120,255,0.5); }
  50%      { box-shadow: 0 0 0 1.5px rgba(255,255,255,1), 0 0 11px 4px rgba(150,95,255,0.95), 0 0 24px 10px rgba(175,120,255,0.6); }
}
@media (prefers-reduced-motion: reduce) { .room-tile__dot.is-ready { animation: none; } }

html, body, * { -webkit-tap-highlight-color: transparent; }
*:focus:not(:focus-visible) { outline: none; }
`;
writeFileSync(CSS, css);
console.log('HOME3-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
