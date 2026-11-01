// 换回浅色背景时用：拿掉 apply-night-text.mjs 加的那一整段，字变回原来的深紫。
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
const css = readFileSync(CSS, 'utf8');
const next = css.replace(/\n*\/\* ===== night-text-start[\s\S]*?night-text-end ===== \*\/\n?/, '\n');
if (next === css) {
  console.log('没有夜景字样式，不用拿。');
  process.exit(0);
}
writeFileSync(CSS, next);
console.log('DAY-OK 字变回原来的颜色了，接着 npm run build && pm2 restart codeandpurrs');
