// 工具那一行：顺风体不变，樱花粉调深一档成玫瑰粉，加一圈很淡的白光，
// 在蓝紫渐变的思考卡上也看得清。只在 global.css 末尾追加；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'src/styles/global.css';
const MARK = 'think-tool-style-v5';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== ${MARK}：玫瑰粉 + 淡白光，蓝紫底上也不费眼 ===== */
.think-card__body .think-tool {
  font-family: "ShunFengFull", var(--round);
  color: #b4528a;
  text-shadow: 0 0 6px rgba(255, 255, 255, 0.75), 0 0 1px rgba(255, 255, 255, 0.9);
}
.think-card__body .think-tool::before { color: #d48cb4; }
.think-card__body .think-tool.is-ok .think-tool__state { color: #4f9c82; }
.think-card__body .think-tool.is-err .think-tool__state { color: #c0577c; }
`;
writeFileSync(CSS, css);
console.log('STYLE5-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
