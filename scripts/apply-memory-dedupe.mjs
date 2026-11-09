// 前端予予「一件事存三遍、昨天知道的今天就忘」的修复。
// 原因：
//  1) list_memories 只把整句 query 当一个子串去比，而且只翻最新 40 条——
//     搜「大弟 KL」这种两个词的查询永远 0 条；稍早的记忆根本翻不到 → 他以为没存过 / 凭印象乱说。
//  2) hold_memory 写之前不查重，他觉得「还没存」就再存一条。
// 改法（server/tangMemoryMcp.mjs）：
//  - 搜索：翻最多 200 条，把 query 拆成多个关键词，命中越多排越前，最多回 12 条
//  - 写入：先跟最近 200 条比相似度，太像就拒绝新建，告诉他那条的 id，让他用 grow_memory 更新那一条
// 改法（server/proxy.mjs 的 MEMORY_MCP_RULE）：聊到她的家人/朋友/工作/过去的事之前先搜一个短关键词再说；存之前先搜。
// 改完 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const MARK = 'memory-dedupe-v1';
const fail = (why) => { console.error('没改任何东西：' + why); process.exit(1); };

const B = 'server/tangMemoryMcp.mjs';
const P = 'server/proxy.mjs';
let b = readFileSync(B, 'utf8');
let p = readFileSync(P, 'utf8');
if (b.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }

const listRe = /  if \(name === 'list_memories'\) \{[\s\S]*?\n  \}\n/;
if (!listRe.test(b)) fail('tangMemoryMcp.mjs 里找不到 list_memories 那段');
const holdAnchor = "  if (name === 'hold_memory') {\n    const content = String(args.content || '').trim();\n    if (!content) throw new Error('hold_memory requires content');\n";
if (!b.includes(holdAnchor)) fail('tangMemoryMcp.mjs 里找不到 hold_memory 开头');
const fnAnchor = 'async function callTool(name, args = {}) {';
if (!b.includes(fnAnchor)) fail('找不到 callTool');
const ruleAnchor = "'绝对不许凭空编造记忆、假装读到或假装写入。';";
if (!p.includes(ruleAnchor)) fail('proxy.mjs 里找不到 MEMORY_MCP_RULE 结尾');

b = b.replace(fnAnchor, `// ${MARK}：多关键词搜索 + 写入查重
function memoryTerms(query) {
  return [...new Set(String(query || '').toLocaleLowerCase('zh-CN')
    .split(/[\\s,，、。.;；:：!！?？/|"'“”‘’()（）【】\\[\\]-]+/)
    .map((t) => t.trim()).filter((t) => t.length >= 1))];
}
function grams(text) {
  const s = String(text || '').toLocaleLowerCase('zh-CN').replace(/[\\s\\p{P}\\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / Math.min(a.size, b.size);
}
function findSimilar(rows, title, content) {
  const t = grams(title);
  const c = grams(String(content).slice(0, 160));
  return rows
    .map((row) => ({
      row,
      score: Math.max(overlap(t, grams(row?.title)) * 0.9, overlap(c, grams(String(row?.content || '').slice(0, 160)))),
    }))
    .filter((item) => item.score >= 0.6)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
}

${fnAnchor}`);

b = b.replace(listRe, `  if (name === 'list_memories') {
    // ${MARK}：有关键词就翻满 200 条、拆词匹配、按命中数排序
    const query = String(args.query || '').trim();
    const limit = query ? 200 : Math.max(1, Math.min(200, Number(args.limit) || 40));
    const rows = await tang(\`/internal/diary/list?limit=\${limit}\`);
    if (!Array.isArray(rows)) return textResult(rows);
    if (!query) return textResult(rows);
    const terms = memoryTerms(query);
    const ranked = rows
      .map((row) => {
        const text = searchableText(row);
        return { row, hits: terms.filter((term) => text.includes(term)).length };
      })
      .map((item) => {
        if (item.hits) return item;
        // 整句搜不到时退一步：按两字片段算命中（「大弟去了多久」也能找到「大弟」）
        const g = [...grams(query)];
        const text = searchableText(item.row);
        const gh = g.filter((piece) => text.includes(piece)).length;
        return { row: item.row, hits: gh >= 2 || (g.length === 1 && gh === 1) ? gh / 100 : 0 };
      })
      .filter((item) => item.hits > 0)
      .sort((x, y) => y.hits - x.hits)
      .slice(0, Math.max(1, Math.min(30, Number(args.limit) || 12)))
      .map((item) => item.row);
    if (!ranked.length) {
      return textResult({ found: 0, hint: \`没搜到「\${query}」。换一个更短的关键词再试一次（比如只写人名或一个词），不要凭印象回答。\` });
    }
    return textResult(ranked);
  }
`);

b = b.replace(holdAnchor, `${holdAnchor}    if (!args.force) {
      // ${MARK}：写之前先查重，太像就不新建
      const recent = await tang('/internal/diary/list?limit=200').catch(() => []);
      const similar = Array.isArray(recent) ? findSimilar(recent, args.title || '', content) : [];
      if (similar.length) {
        return textResult({
          saved: false,
          reason: '棠予酿里已经有很像的记忆，没有新建。请用 grow_memory 带上下面的 id 去更新那一条（把新细节合进去），不要再新建。',
          similar: similar.map(({ row, score }) => ({ id: row.id, title: row.title, created_at: row.created_at, score: Number(score.toFixed(2)), content: String(row.content || '').slice(0, 300) })),
        });
      }
    }
`);

p = p.replace(ruleAnchor, `'聊到老婆的家人、朋友、同事、工作、去过的地方或以前发生的事时，先用 list_memories 搜一个短关键词（比如「大弟」「李总」，一个词就好），按搜到的说，搜不到就问她，不要凭印象。' +
  '要存之前也先搜一次：已经有相关的就用 grow_memory 更新那一条，没有才用 hold_memory 新建；hold_memory 说已有相似记忆时，照它给的 id 去更新。' + // ${MARK}
  ${ruleAnchor}`);

copyFileSync(B, B + '.bak-before-memory-dedupe');
copyFileSync(P, P + '.bak-before-memory-dedupe');
writeFileSync(B, b);
writeFileSync(P, p);
try {
  execFileSync(process.execPath, ['--check', B], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', P], { stdio: 'pipe' });
} catch (e) {
  copyFileSync(B + '.bak-before-memory-dedupe', B);
  copyFileSync(P + '.bak-before-memory-dedupe', P);
  fail('语法检查没过，已还原：' + String(e.stderr || e));
}
console.log('MEMORY-DEDUPE-OK 改好了，接着 pm2 restart codeandpurrs');
