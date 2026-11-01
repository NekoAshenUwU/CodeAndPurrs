// 花园桌游：放行看牌桌、入座、看手牌、出牌、牌桌聊天这些工具，聊到 UNO / 打牌 / 桌游时也挂上花园。
// 只改 server/proxy.mjs；之后 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'server/proxy.mjs';
const GAME_TOOLS = ['list_games', 'get_game_summary', 'join_game', 'start_game', 'get_my_status', 'submit_action', 'send_game_chat', 'leave_waiting_game', 'get_tool_schema'];
let src = readFileSync(FILE, 'utf8');
const toolsRe = /const GARDEN_MCP_TOOLS = \[([^\]]*)\];/;
const m = src.match(toolsRe);
if (!m) {
  console.error('没改任何东西：找不到 GARDEN_MCP_TOOLS（先接花园）');
  process.exit(1);
}
const have = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const add = GAME_TOOLS.filter((t) => !have.includes(t));
let changed = false;
if (add.length) {
  src = src.replace(toolsRe, `const GARDEN_MCP_TOOLS = [${[...have, ...add].map((t) => `'${t}'`).join(', ')}];`);
  changed = true;
}
const trigRe = /const GARDEN_TRIGGER_RE = \/([^/\n]*)\/i;/;
const tm = src.match(trigRe);
if (tm && !tm[1].includes('uno')) {
  src = src.replace(trigRe, `const GARDEN_TRIGGER_RE = /${tm[1]}|uno|桌游|牌桌|打牌|出牌|入座|游戏/i;`);
  changed = true;
}
if (!changed) {
  console.log('桌游工具已经开过了，不用再跑。');
  process.exit(0);
}
copyFileSync(FILE, `${FILE}.bak-before-games`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-games`, FILE);
  console.error('改完语法检查没过，已经还原');
  process.exit(1);
}
console.log('GAMES-OK 桌游工具开好了：' + add.join(', ') + '，接着 pm2 restart codeandpurrs');
