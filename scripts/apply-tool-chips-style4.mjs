// 工具那一行：顺风体 + 樱花粉，比思考字小一号，前面一颗淡粉 ✧。
// 只在 global.css 末尾追加覆盖样式；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'src/styles/global.css';
const MARK = 'think-tool-style-v4';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== ${MARK}：工具那一行 = 顺风体 + 樱花粉，像别在思考里的小便签 ===== */
.think-card__body .think-tool {
  display: flex;
  align-items: baseline;
  gap: 5px;
  width: auto;
  margin: 4px 0 6px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
  font-family: "ShunFengFull", var(--round);
  font-size: 0.78rem;
  line-height: 1.6;
  letter-spacing: 0.04em;
  color: #d07aa6;
  opacity: 1;
}
.think-card__body .think-tool__icon { display: none; }
.think-card__body .think-tool::before { content: "✧"; color: #e8b5cf; }
.think-card__body .think-tool__name { font-weight: 400; }
.think-card__body .think-tool__state {
  margin-left: 2px;
  padding: 0;
  background: none;
  font-size: 0.74rem;
  color: #c9b6d9;
}
.think-card__body .think-tool.is-ok .think-tool__state { background: none; color: #8cc3ae; }
.think-card__body .think-tool.is-err .think-tool__state { background: none; color: #d08aa4; }
`;
writeFileSync(CSS, css);
console.log('STYLE4-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
