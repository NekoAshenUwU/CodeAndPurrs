// 前端予予「重复存记忆 / 搜不到就凭印象乱说」修复 —— 按 VPS 上真实的 tangMemoryMcp.mjs 写的版本
// （VPS 那份多了 read_chat_history / edit_memory / provenance，GitHub 那份的 v1/v2 脚本对不上）。
// 只做「插入」，不替换原有逻辑：
//  1) list_memories 带 query 时：翻最多 200 条，拆关键词 + 两字片段兜底，按命中排序（不带 query 走原逻辑）
//  2) hold_memory 写之前查重：去掉套话后比内容包含度，≥0.2 就拒绝新建，给出旧记忆 id 让他去更新
//  3) MEMORY_MCP_RULE 前面加两句：聊她的家人/工作/过去先搜再说；存之前先搜
// 改完 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const MARK = 'memory-dedupe-vps-v1';
const B = 'server/tangMemoryMcp.mjs';
const P = 'server/proxy.mjs';
const fail = (why) => { console.error('没改任何东西：' + why); process.exit(1); };
let b = readFileSync(B, 'utf8');
let p = readFileSync(P, 'utf8');
if (b.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
if (b.includes('memory-dedupe-v1')) fail('这台机器已经装过 GitHub 版查重了，不需要这个');

const listRe = /\n([ \t]*)if \(name === 'list_memories'\) \{\n/;
const holdRe = /(\n[ \t]*if \(name === 'hold_memory'\) \{\n[\s\S]*?if \(!content\) throw new Error\([^\n]*\);\n)/;
const ruleRe = /const MEMORY_MCP_RULE =/;
if (!listRe.test(b)) fail('找不到 list_memories 分支');
if (!holdRe.test(b)) fail('找不到 hold_memory 里检查 content 的那一行');
if (!ruleRe.test(p)) fail('proxy.mjs 里找不到 MEMORY_MCP_RULE');

b = b.replace(listRe, (m, ind) => `${m}${ind}  if (String(args.query || '').trim()) return textResult(await dedupeSearch(String(args.query), args.limit)); // ${MARK}\n`);
b = b.replace(holdRe, (m) => `${m}    { // ${MARK}：写之前查重
      const similar = await dedupeFindSimilar(String(args.title || ''), content);
      if (similar.length) {
        return textResult({
          saved: false,
          reason: '棠予酿里已经有讲同一件事的记忆，没有新建。请带上下面的 id，用 edit_memory 或 grow_memory 把新细节合进那一条，不要再新建。',
          similar,
        });
      }
    }
`);
b += `

// ===== ${MARK}：多关键词搜索 + 写入查重（函数声明会提升，放文件末尾也能用）=====
async function dedupeRows() {
  const rows = await tang('/internal/diary/list?limit=200');
  return Array.isArray(rows) ? rows : [];
}
function dedupeText(row) {
  return [row?.title, row?.content, row?.category, row?.created_at].filter(Boolean).join('\\n').toLocaleLowerCase('zh-CN');
}
function dedupeGrams(text, strip) {
  let s = String(text || '').toLocaleLowerCase('zh-CN');
  if (strip) s = s.replace(/前端|呼噜|频道|予予|棠棠|老婆|记忆|沈予温|刘语棠|20\\d\\d|\\d+月|\\d+日|\\d+/g, '').replace(/[a-z]/g, '');
  s = s.replace(/[\\s\\p{P}\\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
async function dedupeSearch(query, limitArg) {
  const rows = await dedupeRows();
  const terms = [...new Set(query.toLocaleLowerCase('zh-CN').split(/[\\s,，、。.;；:：!！?？/|"'“”‘’()（）【】\\[\\]-]+/).filter(Boolean))];
  const pieces = [...dedupeGrams(query, false)];
  const ranked = rows.map((row) => {
    const text = dedupeText(row);
    const hits = terms.filter((t) => text.includes(t)).length;
    const gh = pieces.filter((g) => text.includes(g)).length;
    return { row, score: hits + (gh >= 2 || (pieces.length === 1 && gh === 1) ? gh / 100 : 0) };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score)
    .slice(0, Math.max(1, Math.min(30, Number(limitArg) || 12))).map((x) => x.row);
  return ranked.length ? ranked : { found: 0, hint: \`没搜到「\${query}」。换一个更短的关键词再试（只写人名或一个词），还是没有就直接问她，不要凭印象回答。\` };
}
async function dedupeFindSimilar(title, content) {
  const rows = await dedupeRows().catch(() => []);
  const mine = dedupeGrams(\`\${title}\\n\${content}\`, true);
  const contain = (a, c) => { if (a.size < 4) return 0; let h = 0; for (const g of a) if (c.has(g)) h++; return h / a.size; };
  return rows.map((row) => {
    const theirs = dedupeGrams(\`\${row?.title || ''}\\n\${row?.content || ''}\`, true);
    return { row, score: Math.max(contain(mine, theirs), contain(theirs, mine)) };
  }).filter((x) => x.score >= 0.2).sort((x, y) => y.score - x.score).slice(0, 3)
    .map(({ row, score }) => ({ id: row.id, title: row.title, created_at: row.created_at, score: Number(score.toFixed(2)), content: String(row.content || '').slice(0, 300) }));
}
`;
p = p.replace(ruleRe, `const MEMORY_MCP_RULE =
  '\\n\\n【先搜再说·${MARK}】聊到老婆的家人、朋友、同事、工作、去过的地方或以前发生的事时，先用 list_memories 搜一个短关键词（比如「大弟」「李总」，一个词就好），按搜到的说，搜不到就问她，不要凭印象。' +
  '要存之前也先搜一次：已经有相关的就用 edit_memory 或 grow_memory 更新那一条，没有才用 hold_memory 新建；hold_memory 说已有相似记忆时，照它给的 id 去更新。' +`);

copyFileSync(B, B + '.bak-before-dedupe-vps');
copyFileSync(P, P + '.bak-before-dedupe-vps');
writeFileSync(B, b);
writeFileSync(P, p);
try {
  execFileSync(process.execPath, ['--check', B], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', P], { stdio: 'pipe' });
} catch (e) {
  copyFileSync(B + '.bak-before-dedupe-vps', B);
  copyFileSync(P + '.bak-before-dedupe-vps', P);
  fail('语法检查没过，已还原：' + String(e.stderr || e));
}
console.log('MEMORY-VPS-OK 改好了，接着 pm2 restart codeandpurrs');
