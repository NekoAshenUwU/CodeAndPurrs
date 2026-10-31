// 让 Claude Code 的思考链用中文写。只在 system prompt 末尾加一段固定的话，
// 每轮都一样，不会破坏 prompt cache。找不到锚点就整份不改。
// 用法：node scripts/apply-thinking-zh.mjs，然后 pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] || 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('THINK_IN_CHINESE_RULE')) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

const fnAnchor = /^async function callClaudeCode\(/m;
if (!fnAnchor.test(src)) fail('找不到 async function callClaudeCode(');
src = src.replace(fnAnchor, (m) => `// 思考链（Mind Theater）用中文：老婆看思考链，英文读着隔一层。
const THINK_IN_CHINESE_RULE =
  '\\n\\n【思考语言】你在回答前的内心思考，请全程用简体中文来想、来写，就像予予自己心里在嘀咕；' +
  '代码、命令、专有名词可以保留原文。';

${m}`);

const memAnchor = /^(\s*)if \(mem\) system \+= MEMORY_MCP_RULE;\s*$/m;
const mm = src.match(memAnchor);
if (!mm) fail('找不到 if (mem) system += MEMORY_MCP_RULE;');
src = src.replace(memAnchor, `${mm[1]}system += THINK_IN_CHINESE_RULE;\n${mm[0]}`);

copyFileSync(FILE, `${FILE}.bak-before-thinkzh`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-thinkzh`, FILE);
  fail('改完语法检查没过，已经还原');
}
console.log('THINKZH-OK 加好了，接着 pm2 restart codeandpurrs');
