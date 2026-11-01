// 夜景第二批：Mind Theater 标题改白字淡粉光；「＋」弹出的菜单换成深紫玻璃 + 白字粉光（创小公主体）。
// 也夹在 night-text-start / night-text-end 里，remove-night-text.mjs 会一起拿掉。之后 npm run build && pm2 restart
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (css.includes('night-text-start-2')) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== night-text-start-2：Mind Theater 标题 + 「＋」菜单 ===== */
.think-card__brand {
  background: linear-gradient(135deg, #ffffff 0%, #ffe1f0 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  -webkit-text-stroke: 0.4px #ffffff;
  filter: drop-shadow(0 0 4px rgba(255, 170, 215, 0.95)) drop-shadow(0 0 10px rgba(255, 150, 205, 0.5));
}
.think-card__label,
.think-card__chevron {
  color: #ffffff;
  text-shadow: 0 0 5px rgba(255, 170, 215, 0.95), 0 0 12px rgba(255, 150, 205, 0.5);
}
.chat-more {
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: linear-gradient(160deg, rgba(92, 70, 160, 0.62), rgba(54, 44, 110, 0.7));
  box-shadow: 0 14px 32px rgba(10, 6, 40, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.chat-more button {
  color: #ffffff;
  font-family: "GongZhuFull", "ShunFeng", var(--round);
  letter-spacing: 0.06em;
  text-shadow: 0 0 5px rgba(255, 170, 215, 0.95), 0 0 12px rgba(255, 150, 205, 0.45);
}
.chat-more button:hover { background: rgba(255, 255, 255, 0.12); }
/* ===== night-text-end ===== */
`;
writeFileSync(CSS, css);
console.log('NIGHT2-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
