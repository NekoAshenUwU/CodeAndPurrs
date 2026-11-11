// 搜索省额度：list_memories 带关键词搜时，每条只回标题 + 前 200 字预览，
// 需要细看哪条再用 read_memory 按 id 读全文（像先看目录再借书）。需要先跑 apply-memory-dedupe-vps.mjs。
// 改完 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const B = 'server/tangMemoryMcp.mjs';
const MARK = 'memory-search-preview-v1';
const fail = (why) => { console.error('没改任何东西：' + why); process.exit(1); };
let b = readFileSync(B, 'utf8');
if (b.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
if (!b.includes('memory-dedupe-vps-v1')) fail('先跑 apply-memory-dedupe-vps.mjs');
const a1 = '.slice(0, Math.max(1, Math.min(30, Number(limitArg) || 12))).map((x) => x.row);';
const a2 = '  return ranked.length ? ranked : {';
if (!b.includes(a1) || !b.includes(a2)) fail('找不到搜索结果那两行');
b = b.replace(a1, `.slice(0, Math.max(1, Math.min(30, Number(limitArg) || 12))).map((x) => x.row)
    .map((row) => { // ${MARK}：只给预览，省额度
      const full = String(row?.content || '');
      return { id: row?.id, title: row?.title, category: row?.category, created_at: row?.created_at, preview: full.length > 200 ? full.slice(0, 200) + '…' : full, chars: full.length };
    });`);
b = b.replace(a2, `  if (ranked.length) return { results: ranked, note: '这里只有每条的前 200 字。要细看哪一条，用 read_memory 带它的 id 读全文；预览已经够用就不必读。' };
  return {`);
copyFileSync(B, B + '.bak-before-search-preview');
writeFileSync(B, b);
try { execFileSync(process.execPath, ['--check', B], { stdio: 'pipe' }); }
catch (e) { copyFileSync(B + '.bak-before-search-preview', B); fail('语法检查没过，已还原'); }
console.log('MEMORY-PREVIEW-OK 改好了，接着 pm2 restart codeandpurrs');
