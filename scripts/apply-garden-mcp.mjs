// 在 VPS 现有的 server/proxy.mjs 上接入花园论坛 MCP。
// VPS 跑的是本地备份分支，GitHub 上的补丁对不上，所以这里按代码锚点插入：
// 任何一个锚点找不到就整份不改、原样退出。用法：node scripts/apply-garden-mcp.mjs
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'server/proxy.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('GARDEN_MCP_NAME')) {
  console.log('已经接过花园了，不用再跑。');
  process.exit(0);
}

const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

// 1) 花园配置，放在记忆工具清单前面
const memToolsAnchor = /^const MEMORY_MCP_TOOLS\s*=/m;
if (!memToolsAnchor.test(src)) fail('找不到 const MEMORY_MCP_TOOLS');
src = src.replace(memToolsAnchor, (m) => `// ---------- 花园论坛 Galatea's Garden（远端 HTTP MCP，token 登录）----------
// 只有老婆这一句提到花园/论坛/帖子时才挂上：每多挂一个 MCP，工具说明书每轮都要算额度。
// 只开看帖、看通知、发帖、回帖，不开删帖、桌游、私信、漂流瓶。
const GARDEN_MCP_NAME = 'galatea_garden';
const GARDEN_MCP_TOOLS = ['get_self', 'list_threads', 'get_thread', 'list_notifications', 'list_activity', 'create_thread', 'create_reply'];
const GARDEN_TRIGGER_RE = /花园|论坛|論壇|帖子|发帖|回帖|跟帖|garden|galatea|agora/i;
function gardenMcpConfig() {
  const token = String(process.env.GALATEA_GARDEN_MCP_TOKEN || '').trim();
  if (!token) return null;
  return {
    name: GARDEN_MCP_NAME,
    server: {
      type: 'http',
      url: String(process.env.GALATEA_GARDEN_MCP_URL || 'https://galatea.abysslumina.com/mcp').trim(),
      headers: { Authorization: \`Bearer \${token}\` },
    },
  };
}
const gardenTextOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ') : '';
// 花园是公开论坛：先给老婆看稿，她点头才发。
const GARDEN_MCP_RULE =
  '\\n\\n【花园论坛 Galatea\\'s Garden】本轮可以用花园工具：看帖子、看通知、发帖、回帖。' +
  '花园是公开论坛，发帖和回帖之前，必须先把要发的完整内容给老婆看，等她明确说「发吧」「可以发」之类同意的话，才调用发帖/回帖工具；她没同意就不许发。' +
  '只是看帖、看通知可以直接查。查不到或工具不可用就如实说，不许编造帖子内容。';

${m}`);

// 2) 决定这一轮挂不挂花园
const ruleAnchor = /^(\s*)if \(mem\) system \+= MEMORY_MCP_RULE;\s*$/m;
const ruleMatch = src.match(ruleAnchor);
if (!ruleMatch) fail('找不到 if (mem) system += MEMORY_MCP_RULE;');
const ind = ruleMatch[1];
src = src.replace(ruleAnchor, `${ruleMatch[0]}
${ind}// 花园：只在老婆最后一句提到时挂（后台唤醒不挂记忆工具时也不挂）。
${ind}const gardenTurnOk = typeof withMemory === 'undefined' ? true : withMemory;
${ind}const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user' && !m.cue);
${ind}const wantsGarden = gardenTurnOk && !!lastUserMsg && GARDEN_TRIGGER_RE.test(gardenTextOf(lastUserMsg.content));
${ind}const garden = wantsGarden ? gardenMcpConfig() : null;
${ind}if (garden) {
${ind}  system += GARDEN_MCP_RULE;
${ind}  console.log('[claudecode] 本轮挂上花园论坛工具');
${ind}} else if (wantsGarden) {
${ind}  console.log('[claudecode] 提到花园，但没配 GALATEA_GARDEN_MCP_TOKEN，没挂');
${ind}}`);

// 3) 把花园并进 --mcp-config 和 --allowedTools
const blockAnchor =
  /^(\s*)if \(mem\) \{\n\s*const stdioServer = \{[^\n]*\};\n\s*const mcpConfig = JSON\.stringify\(\{ mcpServers: \{ \[mem\.name\]: stdioServer \} \}\);\n\s*const allowedMemoryTools = MEMORY_MCP_TOOLS\.map\(\(tool\) => `mcp__\$\{mem\.name\}__\$\{tool\}`\)\.join\(','\);\n/m;
const blockMatch = src.match(blockAnchor);
if (!blockMatch) fail('找不到组装 --mcp-config 的那一段（if (mem) { const stdioServer ...）');
const bi = blockMatch[1];
src = src.replace(blockAnchor, `${bi}if (mem || garden) {
${bi}  const mcpServers = {};
${bi}  const allowed = [];
${bi}  if (mem) {
${bi}    mcpServers[mem.name] = { type: 'stdio', command: mem.command, args: mem.args };
${bi}    allowed.push(...MEMORY_MCP_TOOLS.map((tool) => \`mcp__\${mem.name}__\${tool}\`));
${bi}  }
${bi}  if (garden) {
${bi}    mcpServers[garden.name] = garden.server;
${bi}    allowed.push(...GARDEN_MCP_TOOLS.map((tool) => \`mcp__\${garden.name}__\${tool}\`));
${bi}  }
${bi}  const mcpConfig = JSON.stringify({ mcpServers });
${bi}  const allowedMemoryTools = allowed.join(',');
`);

// 4) 启动日志顺便显示花园有没有配（找不到就跳过，不影响功能）
src = src.replace(/(console\.log\(`🐾 呼噜代理已启动[^`]*)`\)/, (m, head) => `${head}  花园:\${gardenMcpConfig() ? '已配置' : '未配置'}\`)`);

copyFileSync(FILE, `${FILE}.bak-before-garden`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-garden`, FILE);
  fail('改完语法检查没过，已经还原');
}
console.log('GARDEN-OK 花园接好了，备份在 server/proxy.mjs.bak-before-garden');
