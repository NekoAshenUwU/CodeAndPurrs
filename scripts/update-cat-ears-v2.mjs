// 换成新的猫耳朵图（白紫渐层 + 蓝紫蝴蝶结），稍微大一点。图片：public/ears/ears-cat-v2.png
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const CSS = 'src/styles/global.css';
if (!existsSync('public/ears/ears-cat-v2.png')) {
  console.error('没改任何东西：缺图片 public/ears/ears-cat-v2.png');
  process.exit(1);
}
let css = readFileSync(CSS, 'utf8');
if (css.includes('ears-cat-v2.png')) {
  console.log('已经换过了，不用再跑。');
  process.exit(0);
}
const re = /(\.bubble--user::after \{\n(?:  [^\n]*\n)*?)  width: \d+px;\n  height: \d+px;\n  background-image: url\("\/ears\/ears-cat\.png"\);/;
if (!re.test(css)) {
  console.error('没改任何东西：找不到猫耳朵的样式（先跑 apply-bubble-ears.mjs）');
  process.exit(1);
}
css = css.replace(re, '$1  width: 54px;\n  height: 35px;\n  background-image: url("/ears/ears-cat-v2.png");');
writeFileSync(CSS, css);
console.log('CATEARS-OK 猫耳朵换好了，接着 npm run build && pm2 restart codeandpurrs');
