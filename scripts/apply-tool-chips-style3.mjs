// 工具标签第三版：不要框、不要底色，只是思考里一行轻轻的小字，前面一颗 ✧。
// 只在 global.css 末尾追加覆盖样式；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = 'src/styles/global.css';
const MARK = 'think-tool-style-v3';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== ${MARK}：工具不用框，就是思考里一行轻轻的小字 ===== */
.think-card__body .think-tool {
  display: flex;
  gap: 5px;
  margin: 4px 0 6px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
  font-family: inherit;
  font-size: 0.76rem;
  line-height: 1.6;
  letter-spacing: 0.04em;
  color: #a58fd4;
  opacity: 0.92;
}
.think-card__body .think-tool__icon { display: none; }
.think-card__body .think-tool::before {
  content: "✧";
  color: #c6b3ec;
}
.think-card__body .think-tool__name { font-weight: 400; }
.think-card__body .think-tool__state {
  margin-left: 2px;
  padding: 0;
  background: none;
  font-size: 0.72rem;
  color: #b9a9d8;
}
.think-card__body .think-tool.is-ok .think-tool__state { background: none; color: #8cc3ae; }
.think-card__body .think-tool.is-err .think-tool__state { background: none; color: #d08aa4; }
`;
writeFileSync(CSS, css);
console.log('STYLE3-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
