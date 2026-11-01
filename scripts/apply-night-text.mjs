// 夜景背景用：气泡字、思考链字改成珍珠白 + 淡紫光，深色背景上也看得清。
// 整段夹在 night-text-start / night-text-end 之间，换回浅色背景时跑 remove-night-text.mjs 就能整段拿掉。
// 只在 global.css 末尾追加；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (css.includes('night-text-start')) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== night-text-start：夜景背景，字改成珍珠白 + 淡紫光 ===== */
.bubble--user,
.bubble--bot {
  color: #f4eeff;
  text-shadow: 0 0 6px rgba(205, 175, 255, 0.95), 0 0 14px rgba(170, 130, 255, 0.5);
}
.think-card__body {
  color: #efe6ff;
  text-shadow: 0 0 5px rgba(205, 175, 255, 0.9), 0 0 12px rgba(160, 120, 255, 0.45);
}
.think-card__brand,
.think-card__label,
.think-card__chevron {
  color: #f1e9ff;
  text-shadow: 0 0 6px rgba(205, 175, 255, 0.9);
}
.think-card__body .think-tool { color: #ffc4e1; text-shadow: 0 0 6px rgba(255, 170, 215, 0.75); }
.think-card__body .think-tool::before { color: #ffd6ea; }
.think-card__body .think-tool .think-tool__state { color: #ffd6ea; }
.bubble-time { color: #e4dbf7; text-shadow: 0 0 4px rgba(60, 40, 110, 0.6); }
/* ===== night-text-end ===== */
`;
writeFileSync(CSS, css);
console.log('NIGHT-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
