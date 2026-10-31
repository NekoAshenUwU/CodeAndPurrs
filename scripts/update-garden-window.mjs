// 已经用 apply-garden-mcp.mjs 接过花园的 VPS：把「只看最后一句」改成「看最近 8 条」。
// 用法：node scripts/update-garden-window.mjs，然后 pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('const recentTexts =')) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
const re = /^(\s*)const lastUserMsg = \[\.\.\.messages\]\.reverse\(\)\.find\([^\n]*\n\s*const wantsGarden = gardenTurnOk && !!lastUserMsg && GARDEN_TRIGGER_RE\.test\(gardenTextOf\(lastUserMsg\.content\)\);\n/m;
const m = src.match(re);
if (!m) {
  console.error('没改任何东西：找不到原来那两行（const lastUserMsg / const wantsGarden）');
  process.exit(1);
}
const ind = m[1];
src = src.replace(re, `${ind}// 最近 8 条对话（她和予予都算）提到过花园/帖子就挂上，她回「发吧」也摸得到发帖工具。
${ind}const recentTexts = messages.filter((m) => m.role !== 'system' && !m.cue).slice(-8).map((m) => gardenTextOf(m.content));
${ind}const wantsGarden = gardenTurnOk && recentTexts.some((t) => GARDEN_TRIGGER_RE.test(t));
`);
copyFileSync(FILE, `${FILE}.bak-before-garden-window`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-garden-window`, FILE);
  console.error('改完语法检查没过，已经还原');
  process.exit(1);
}
console.log('WINDOW-OK 改好了，接着 pm2 restart codeandpurrs');
