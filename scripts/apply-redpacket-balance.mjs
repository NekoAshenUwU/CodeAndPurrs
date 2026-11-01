// 落予棠口袋余额：原来只加「收到的红包」，自己发出去的没扣。改成 本金 + 收到的 − 发出去的。
// 只改 src/services/redPacket.ts；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const FILE = 'src/services/redPacket.ts';
let src = readFileSync(FILE, 'utf8');
if (src.includes('const sent = list')) {
  console.log('已经修过了，不用再跑。');
  process.exit(0);
}
const re = /\/\/ 某一方口袋里累积了多少[^\n]*\nexport function balanceOf\(who: Sender, list: RedPacket\[\] = loadPackets\(\)\): number \{\n[\s\S]*?\n\}/;
if (!re.test(src)) {
  console.error('没改任何东西：找不到 balanceOf 这个函数');
  process.exit(1);
}
src = src.replace(re, `// 某一方口袋里有多少：本金 + 对方发给自己的 − 自己发给对方的
export function balanceOf(who: Sender, list: RedPacket[] = loadPackets()): number {
  const senderOfOther: Sender = who === 'user' ? 'ai' : 'user';
  const received = list.filter((p) => p.from === senderOfOther).reduce((sum, p) => sum + p.amount, 0);
  const sent = list.filter((p) => p.from === who).reduce((sum, p) => sum + p.amount, 0);
  return PRINCIPAL_AMOUNT + received - sent;
}`);
copyFileSync(FILE, `${FILE}.bak-before-balance`);
writeFileSync(FILE, src);
console.log('BALANCE-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
