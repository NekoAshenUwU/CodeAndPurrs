// 耳朵换到远离头像的那个角：老婆的猫耳朵在气泡左上角，予予的雪豹耳朵在气泡右上角。
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
let css = readFileSync(CSS, 'utf8');
if (css.includes('bubble-ears-v5')) {
  console.log('已经是最新的耳朵位置了，不用再跑。');
  process.exit(0);
}
const userRe = /\.bubble--user::after \{\n  (?:right|left): -?\d+px;\n  top: -?\d+px;\n  width: \d+px;\n  height: \d+px;\n  background-image: url\("\/ears\/ears-cat\.png"\);\n  transform: rotate\(-?\d+deg\);\n\}/;
const botRe = /\.bubble--bot::after \{\n  (?:right|left): -?\d+px;\n  top: -?\d+px;\n  width: \d+px;\n  height: \d+px;\n  background-image: url\("\/ears\/ears-leopard\.png"\);\n  transform: rotate\(-?\d+deg\);\n\}/;
if (!userRe.test(css) || !botRe.test(css)) {
  console.error('没改任何东西：找不到耳朵的样式（先跑 apply-bubble-ears.mjs）');
  process.exit(1);
}
css = css
  .replace(userRe, '.bubble--user::after {\n  left: -6px;\n  top: -12px;\n  width: 50px;\n  height: 30px;\n  background-image: url("/ears/ears-cat.png");\n  transform: rotate(-26deg);\n}')
  .replace(botRe, '.bubble--bot::after {\n  right: -9px;\n  top: -11px;\n  width: 52px;\n  height: 26px;\n  background-image: url("/ears/ears-leopard.png");\n  transform: rotate(30deg);\n}')
  .replace(/bubble-ears-v\d/, 'bubble-ears-v5');
writeFileSync(CSS, css);
console.log('EARS5-OK 耳朵换到另一个角了，接着 npm run build && pm2 restart codeandpurrs');
