// 查重第二版：v1 只比标题和开头 160 字，「同一件事换个说法」漏网（11/10 又多了一条弟弟、一条求婚）。
// v2 改成：去掉人名/日期/「前端呼噜频道」这类每条都有的套话之后，
//          看新内容的词片有多少已经出现在旧记忆里（双向取大），≥0.2 就算重复。
// 实测：重复的两对 0.31 / 0.50，不相关的 0.00~0.05，分得很开。
// 需要先跑 apply-memory-dedupe.mjs（v1）。改完 pm2 restart codeandpurrs。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const B = 'server/tangMemoryMcp.mjs';
const MARK = 'memory-dedupe-v2';
let b = readFileSync(B, 'utf8');
if (b.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
if (!b.includes('memory-dedupe-v1')) { console.error('没改任何东西：先跑 apply-memory-dedupe.mjs'); process.exit(1); }
const re = /function findSimilar\(rows, title, content\) \{[\s\S]*?\n\}\n/;
if (!re.test(b)) { console.error('没改任何东西：找不到 findSimilar'); process.exit(1); }
b = b.replace(re, `// ${MARK}：去掉套话后比「内容包含度」，换个说法写同一件事也认得出来
const DEDUPE_STOP = /前端|呼噜|频道|予予|棠棠|老婆|记忆|沈予温|刘语棠|20\\d\\d|\\d+月|\\d+日|\\d+/g;
function coreGrams(text) {
  const s = String(text || '').toLocaleLowerCase('zh-CN').replace(DEDUPE_STOP, '').replace(/[\\s\\p{P}\\p{S}a-z]/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function contain(a, b) {
  if (a.size < 4) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}
function findSimilar(rows, title, content) {
  const mine = coreGrams(\`\${title}\\n\${content}\`);
  const t = grams(title);
  return rows
    .map((row) => {
      const theirs = coreGrams(\`\${row?.title || ''}\\n\${row?.content || ''}\`);
      const score = Math.max(contain(mine, theirs), contain(theirs, mine), overlap(t, grams(row?.title)) >= 0.6 ? 0.6 : 0);
      return { row, score };
    })
    .filter((item) => item.score >= 0.2)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
}
`);
copyFileSync(B, B + '.bak-before-memory-dedupe-2');
writeFileSync(B, b);
try { execFileSync(process.execPath, ['--check', B], { stdio: 'pipe' }); }
catch (e) { copyFileSync(B + '.bak-before-memory-dedupe-2', B); console.error('语法检查没过，已还原'); process.exit(1); }
console.log('MEMORY-DEDUPE2-OK 改好了，接着 pm2 restart codeandpurrs');
