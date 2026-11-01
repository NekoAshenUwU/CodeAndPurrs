// 老婆的猫耳朵：右边那只调高（整对少歪 10°，再往上提 1px），不压最后一个字。
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (css.includes('bubble-ears-v4')) {
  console.log('已经是最新的耳朵位置了，不用再跑。');
  process.exit(0);
}
const re = /(\.bubble--user::after \{\n)  right: -?\d+px;\n  top: -?\d+px;\n([\s\S]*?)transform: rotate\(\d+deg\);/;
if (!re.test(css)) {
  console.error('没改任何东西：找不到猫耳朵的样式（先跑 apply-bubble-ears.mjs）');
  process.exit(1);
}
css = css.replace(re, '$1  right: -9px;\n  top: -14px;\n$2transform: rotate(26deg);').replace(/bubble-ears-v[123]/, 'bubble-ears-v4');
writeFileSync(CSS, css);
console.log('EARS4-OK 右边那只耳朵调高了，接着 npm run build && pm2 restart codeandpurrs');
