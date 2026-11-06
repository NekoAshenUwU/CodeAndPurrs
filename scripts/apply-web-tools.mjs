// 让 CodeAndPurrs 里的予予可以上网：放行 Claude Code 自带的 WebSearch（搜网页）和 WebFetch（打开网页）。
// 只在挂记忆工具的聊天轮里开（后台唤醒不开）。想关掉：.env 里写 CC_WEB_TOOLS=off 再重启。
// 只改 server/proxy.mjs，按代码锚点插入，找不到就整份不改。之后 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] || 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('WEB_TOOLS_ON')) {
  console.log('已经开过了，不用再跑。');
  process.exit(0);
}
const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

// 1) 规则 + 开关，放在 callClaudeCode 前面
const fnAnchor = /^async function callClaudeCode\(/m;
if (!fnAnchor.test(src)) fail('找不到 async function callClaudeCode(');
src = src.replace(fnAnchor, (m) => `// ---------- 上网：Claude Code 自带的 WebSearch / WebFetch ----------
const WEB_TOOLS_ON = String(process.env.CC_WEB_TOOLS || '').trim().toLowerCase() !== 'off';
const WEB_TOOLS = 'WebSearch,WebFetch';
const WEB_RULE =
  '\\n\\n【上网】本轮可以用 WebSearch 搜索网页、用 WebFetch 打开网页。' +
  '老婆问到新闻、天气、价格、营业时间、某个网页或你不确定的最新信息时，先查再答，并说清楚是从哪里看到的；' +
  '普通聊天不用查。查不到或打不开就如实说，不许编造网页内容。';

${m}`);

// 2) 聊天轮（挂记忆工具的那一支）把内置工具从「全关」改成只开上网两个
const toolsRe = /'--tools', '',(\s*\n\s*'--mcp-config', mcpConfig,\s*\n\s*'--allowedTools', allowedMemoryTools)/;
if (!toolsRe.test(src)) fail("找不到 '--tools', '', '--mcp-config', mcpConfig, '--allowedTools', allowedMemoryTools 这一段");
src = src.replace(toolsRe, (m, rest) =>
  `'--tools', WEB_TOOLS_ON ? WEB_TOOLS : '',` + rest.replace("allowedMemoryTools", "WEB_TOOLS_ON ? `${allowedMemoryTools},${WEB_TOOLS}` : allowedMemoryTools"));

// 3) 同一支里把上网规则加进 system
const ruleRe = /^(\s*)if \(mem\) system \+= MEMORY_MCP_RULE;\s*$/m;
const rm = src.match(ruleRe);
if (!rm) fail('找不到 if (mem) system += MEMORY_MCP_RULE;');
src = src.replace(ruleRe, `${rm[0]}\n${rm[1]}if (mem && WEB_TOOLS_ON) system += WEB_RULE;`);

// 4) 思考链里的工具名（有装工具显示才加）
src = src.replace(/(const TOOL_TRACE_LABELS = \{\n)/, `$1  WebSearch: '上网搜一搜',\n  WebFetch: '打开一个网页',\n`);
src = src.replace(/(\['query', 'title', 'keyword',)/, "$1 'url',");

copyFileSync(FILE, `${FILE}.bak-before-web`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-web`, FILE);
  fail('改完语法检查没过，已经还原');
}
console.log('WEB-OK 予予可以上网了，接着 pm2 restart codeandpurrs');
