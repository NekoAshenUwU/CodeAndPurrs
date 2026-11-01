// 花园工具整个放行：不再一个一个列名单，花园有什么工具予予都能用（桌游、私信、漂流瓶……）。
// 发帖/回帖先给老婆看稿、删帖只删自己的，这些规矩还在系统提示里。只改 server/proxy.mjs，之后 pm2 restart。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('allowed.push(`mcp__${garden.name}`)')) {
  console.log('已经整个放行了，不用再跑。');
  process.exit(0);
}
const re = /allowed\.push\(\.\.\.GARDEN_MCP_TOOLS\.map\(\(tool\) => `mcp__\$\{garden\.name\}__\$\{tool\}`\)\);/;
if (!re.test(src)) {
  console.error('没改任何东西：找不到花园工具名单那一行（先接花园）');
  process.exit(1);
}
src = src.replace(re, '// 整个花园服务器放行（mcp__<server> 这条规则涵盖它所有工具）\n      allowed.push(`mcp__${garden.name}`);');
copyFileSync(FILE, `${FILE}.bak-before-allowall`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-allowall`, FILE);
  console.error('改完语法检查没过，已经还原');
  process.exit(1);
}
console.log('ALLOWALL-OK 花园工具全部放行了，接着 pm2 restart codeandpurrs');
