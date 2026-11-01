// VPS 版猫爪足迹修复（对 conversationContext.ts 的 captureTurnContext 写法）：
// 1) 3 小时窗口内的其它消息也带上「猫爪足迹」那一行，予予每轮都看得到今天的手机
// 2) 反查地名最多等 4 秒——它卡住时，整段背景（含猫爪足迹）会一直拼不出来
// 之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const CTX = 'src/services/conversationContext.ts';
const PAGE = 'src/pages/PurrChannelPage.tsx';
let ctx = readFileSync(CTX, 'utf8');
let page = readFileSync(PAGE, 'utf8');
let did = [];

if (!ctx.includes('pawLineOnly')) {
  const re = /snapshots\.set\(target\.id, time \+ \(attachLive \? live : ''\)\);/;
  if (!re.test(ctx)) {
    console.error("没改任何东西：找不到 snapshots.set(target.id, time + (attachLive ? live : ''));");
    process.exit(1);
  }
  ctx = ctx.replace(re, `// 窗口内其它消息只带「猫爪足迹」那一行（~100 tokens），不带位置
  const pawLineOnly = live.match(/\\n\\n【猫爪足迹[^\\n]*/)?.[0] ?? '';
  snapshots.set(target.id, time + (attachLive ? live : pawLineOnly));`);
  did.push('每轮带猫爪足迹');
}

if (!page.includes('reverseGeocodeTimeout')) {
  const re = /await reverseGeocode\(lat, lng\)/;
  if (re.test(page)) {
    page = page.replace(re, `await Promise.race([reverseGeocode(lat, lng), new Promise<null>((r) => setTimeout(() => r(null), 4000))]) /* reverseGeocodeTimeout */`);
    did.push('地名最多等 4 秒');
  }
}

if (!did.length) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
copyFileSync(CTX, `${CTX}.bak-before-paw`);
copyFileSync(PAGE, `${PAGE}.bak-before-paw`);
writeFileSync(CTX, ctx);
writeFileSync(PAGE, page);
console.log('PAW2-OK ' + did.join('、') + '，接着 npm run build && pm2 restart codeandpurrs');
