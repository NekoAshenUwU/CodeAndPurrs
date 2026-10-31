// 工具胶囊换成跟思考链同一套气质：同字体、同色系、虚线描边的小标签，不再像一颗按钮。
// 只在 global.css 末尾追加覆盖样式；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'src/styles/global.css';
const MARK = 'think-tool-style-v2';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== ${MARK}：工具标签跟思考链同字体同色系，轻一点 ===== */
.think-card__body .think-tool {
  gap: 6px;
  margin: 6px 0;
  padding: 1px 11px 1px 9px;
  border-radius: 12px;
  border: 1px dashed rgba(155, 123, 200, 0.5);
  background: rgba(255, 255, 255, 0.24);
  box-shadow: none;
  font-family: inherit;
  font-size: 0.8rem;
  line-height: 1.7;
  color: #7d5fc6;
}
.think-card__body .think-tool__icon { display: none; }
.think-card__body .think-tool::before {
  content: "✧";
  color: #b49be0;
  font-size: 0.8rem;
}
.think-card__body .think-tool__name { font-weight: 400; }
.think-card__body .think-tool__state {
  margin-left: 4px;
  padding: 0;
  border-radius: 0;
  background: none;
  font-size: 0.74rem;
  color: #a596c4;
}
.think-card__body .think-tool.is-ok .think-tool__state { background: none; color: #6fae98; }
.think-card__body .think-tool.is-err .think-tool__state { background: none; color: #c26b8a; }
`;
writeFileSync(CSS, css);
console.log('STYLE-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
