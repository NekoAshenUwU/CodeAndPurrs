// 已经跑过 apply-bubble-ears.mjs（v1）的：把耳朵往气泡里挪，贴住圆角，不再悬空。
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (!css.includes('bubble-ears-v1')) {
  console.log('没有 v1 的耳朵样式，直接跑 apply-bubble-ears.mjs 就好。');
  process.exit(0);
}
const before = css;
css = css.replace('  right: -17px;\n  top: -19px;', '  right: -6px;\n  top: -12px;').replace('  left: -17px;\n  top: -16px;', '  left: -6px;\n  top: -10px;').replace('bubble-ears-v1', 'bubble-ears-v2');
if (css === before) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
writeFileSync(CSS, css);
console.log('EARS2-OK 耳朵贴住了，接着 npm run build && pm2 restart codeandpurrs');
