// 修思考链里工具重复出现：Claude Code 有时会把同一条 assistant / 工具结果消息吐两次，
// 这里按工具 id 去重，每个工具只显示一行、一个结果。之后 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] || 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('seenToolUseIds')) {
  console.log('已经修过了，不用再跑。');
  process.exit(0);
}
const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

const lineAnchor = /^(\s*)const handleLine = \(line\) => \{\s*$/m;
const lm = src.match(lineAnchor);
if (!lm) fail('找不到 const handleLine = (line) => {');
src = src.replace(lineAnchor, `${lm[1]}// 同一个工具调用 / 结果可能被吐两次，按 id 只显示一次
${lm[1]}const seenToolUseIds = new Set();
${lm[1]}const seenToolResultIds = new Set();
${lm[0]}`);

const resAnchor = /if \(blk\?\.type === 'tool_result'\) send\(res, \{ type: 'reasoning', text: blk\.is_error \? '　✗ 没成功\\n\\n' : '　✓\\n\\n' \}\);/;
if (!resAnchor.test(src)) fail('找不到工具结果那一行（先跑 apply-tool-trace.mjs）');
src = src.replace(resAnchor, `if (blk?.type === 'tool_result' && !seenToolResultIds.has(blk.tool_use_id)) {
              seenToolResultIds.add(blk.tool_use_id);
              send(res, { type: 'reasoning', text: blk.is_error ? '　✗ 没成功\\n\\n' : '　✓\\n\\n' });
            }`);

const useAnchor = /^(\s*)send\(res, \{ type: 'reasoning', text: toolTraceLine\(blk\) \}\);\s*$/m;
const um = src.match(useAnchor);
if (!um) fail('找不到 toolTraceLine(blk) 那一行（先跑 apply-tool-trace.mjs）');
src = src.replace(useAnchor, `${um[1]}if (!seenToolUseIds.has(blk.id)) {
${um[1]}  seenToolUseIds.add(blk.id);
${um[1]}  send(res, { type: 'reasoning', text: toolTraceLine(blk) });
${um[1]}}`);

copyFileSync(FILE, `${FILE}.bak-before-dedupe`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-dedupe`, FILE);
  fail('改完语法检查没过，已经还原');
}
console.log('DEDUPE-OK 修好了，接着 pm2 restart codeandpurrs');
