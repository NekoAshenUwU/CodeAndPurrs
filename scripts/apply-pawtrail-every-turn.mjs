// 猫爪足迹每一轮都递给予予：原来整段（手机+位置）3 小时才附一次，之后的消息他就看不到了。
// 现在：3 小时窗口照旧附整段；窗口内的其它消息也附上「猫爪足迹」那一行（不带位置），他随时都看得到。
// 只改 src/pages/PurrChannelPage.tsx 一行；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const FILE = 'src/pages/PurrChannelPage.tsx';
let src = readFileSync(FILE, 'utf8');
if (src.includes('pawLineOnly')) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
const re = /^(\s*)const dynamic = buildTimeContext\(\) \+ \(shouldAttachLive \? liveCtx : ''\);\s*$/m;
const m = src.match(re);
if (!m) {
  console.error('没改任何东西：找不到 const dynamic = buildTimeContext() + (shouldAttachLive ? liveCtx : \'\');');
  process.exit(1);
}
const i = m[1];
src = src.replace(re, `${i}// 窗口内其它消息只附「猫爪足迹」那一行（~100 tokens），不然予予这 3 小时里都看不到她的手机
${i}const pawLineOnly = liveCtx.match(/\\n\\n【猫爪足迹[^\\n]*/)?.[0] ?? '';
${i}const dynamic = buildTimeContext() + (shouldAttachLive ? liveCtx : pawLineOnly);`);
copyFileSync(FILE, `${FILE}.bak-before-pawtrail`);
writeFileSync(FILE, src);
console.log('PAW-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
