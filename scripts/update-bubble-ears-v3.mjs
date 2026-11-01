// 已经跑过耳朵 v1 / v2 的：猫耳朵（老婆的）往外挪一点，不遮最后一个字；雪豹耳朵贴住左上角。
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (css.includes('bubble-ears-v3')) {
  console.log('已经是最新的耳朵位置了，不用再跑。');
  process.exit(0);
}
if (!/bubble-ears-v[12]/.test(css)) {
  console.log('还没加过耳朵，直接跑 apply-bubble-ears.mjs 就好。');
  process.exit(0);
}
css = css
  .replace(/(\.bubble--user::after \{\n)  right: -?\d+px;\n  top: -?\d+px;/, '$1  right: -9px;\n  top: -13px;')
  .replace(/(\.bubble--bot::after \{\n)  left: -?\d+px;\n  top: -?\d+px;/, '$1  left: -6px;\n  top: -10px;')
  .replace(/bubble-ears-v[12]/, 'bubble-ears-v3');
writeFileSync(CSS, css);
console.log('EARS3-OK 耳朵位置改好了，接着 npm run build && pm2 restart codeandpurrs');
