// 思考链里显示予予调用了什么工具（翻棠予酿、逛花园……）以及成没成功。
// 只改 server/proxy.mjs，前端不用动、不用 build。按代码锚点插入，找不到就整份不改。
// 用法：node scripts/apply-tool-trace.mjs，然后 pm2 restart codeandpurrs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] || 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('toolTraceLine')) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

// 1) 工具名 → 人话，放在 callClaudeCode 前面
const fnAnchor = /^async function callClaudeCode\(/m;
if (!fnAnchor.test(src)) fail('找不到 async function callClaudeCode(');
src = src.replace(fnAnchor, (m) => `// ---------- 思考链里的「予予刚刚做了什么」 ----------
// Claude Code 每调一次工具，就在思考链里插一行人话；工具回来了再补一个 ✓ / ✗。
const TOOL_TRACE_LABELS = {
  list_memories: '翻棠予酿的目录',
  read_memory: '读一段记忆',
  hold_memory: '存下一段新记忆',
  grow_memory: '更新一段记忆',
  get_self: '看看花园里的自己',
  list_threads: '逛花园的帖子列表',
  get_thread: '点开一篇花园帖子',
  list_notifications: '看花园通知',
  list_activity: '看花园动态',
  create_thread: '在花园发帖',
  create_reply: '在花园回帖',
  interact: '在花园点赞 / 互动',
};
function toolTraceLine(blk) {
  const raw = String(blk.name || '');
  const short = raw.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const label = TOOL_TRACE_LABELS[short] || short || raw;
  const input = blk.input && typeof blk.input === 'object' ? blk.input : {};
  const pick = ['query', 'title', 'keyword', 'thread_id', 'id', 'action', 'content', 'body'].map((k) => input[k]).find((v) => typeof v === 'string' || typeof v === 'number');
  let hint = pick == null ? '' : String(pick).replace(/\\s+/g, ' ').trim();
  if (hint.length > 24) hint = hint.slice(0, 24) + '…';
  return \`\\n\\n🔧 \${label}\${hint ? \`「\${hint}」\` : ''}\`;
}

${m}`);

// 2) 看到 tool_use 就在思考链里插一行
const useAnchor = /^(\s*)if \(blk\?\.type === 'tool_use' && blk\.name\) toolCalls\.push\(blk\.name\);\s*$/m;
const um = src.match(useAnchor);
if (!um) fail("找不到 if (blk?.type === 'tool_use' && blk.name) toolCalls.push(blk.name);");
src = src.replace(useAnchor, `${um[1]}if (blk?.type === 'tool_use' && blk.name) {
${um[1]}  toolCalls.push(blk.name);
${um[1]}  send(res, { type: 'reasoning', text: toolTraceLine(blk) });
${um[1]}}`);

// 3) 工具结果回来（type:user 里的 tool_result）就补 ✓ / ✗
const asstAnchor = /^(\s*)if \(obj\.type === 'assistant' && Array\.isArray\(obj\.message\?\.content\)\) \{\s*$/m;
const am = src.match(asstAnchor);
if (!am) fail("找不到 if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {");
const ai = am[1];
src = src.replace(asstAnchor, `${ai}if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
${ai}  for (const blk of obj.message.content) {
${ai}    if (blk?.type === 'tool_result') send(res, { type: 'reasoning', text: blk.is_error ? '　✗ 没成功\\n\\n' : '　✓\\n\\n' });
${ai}  }
${ai}  return;
${ai}}
${am[0]}`);

copyFileSync(FILE, `${FILE}.bak-before-tooltrace`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-tooltrace`, FILE);
  fail('改完语法检查没过，已经还原');
}
console.log('TRACE-OK 加好了，接着 pm2 restart codeandpurrs');
