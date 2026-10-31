// 在 VPS 现有代码上打「聊天页顶栏不被推出屏幕 + 短消息不换行 + 字小一号」。
// VPS 跑的是本地备份分支，git 补丁对不上，所以只动 index.html 和 global.css 末尾，
// 不碰任何 .tsx。已经打过就跳过。用法：node scripts/apply-chat-fix.mjs，然后 npm run build。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const MARK = 'chat-fix-2026-10-30';
const HTML = 'index.html';
const CSS = 'src/styles/global.css';

let html = readFileSync(HTML, 'utf8');
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经打过了，不用再跑。');
  process.exit(0);
}

// 1) 键盘弹出时缩短页面，而不是把整页往上推
html = html.replace(/<meta\s+name="viewport"\s+content="([^"]*)"/, (m, content) =>
  content.includes('interactive-widget') ? m : `<meta name="viewport" content="${content}, interactive-widget=resizes-content"`,
);

// 2) 聊天页里键盘收起 / 屏幕变化时，把整页推回顶部
const script = `    <script>/* ${MARK} */(function () {
      function reset() {
        if (!document.querySelector('.chat-page')) return;
        if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
      }
      document.addEventListener('focusout', function () { setTimeout(reset, 60); });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', reset);
      window.addEventListener('orientationchange', reset);
    })();</script>
`;
if (!html.includes('</body>')) {
  console.error('没改任何东西：index.html 里找不到 </body>');
  process.exit(1);
}
html = html.replace('</body>', `${script}  </body>`);

// 3) 样式统一加在 global.css 最后，按源序覆盖旧规则
css += `

/* ===== ${MARK}：聊天页整页不滚 + 短消息不换行 + 顶栏和气泡字小一号 ===== */
html:has(.chat-page),
html:has(.chat-page) body {
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
}
/* 气泡外层按内容收缩，气泡再拿它的 82% 当上限 → 几个字也被挤成两行 */
.bubble-stack .bubble--user { max-width: 100%; }
.chat-head { gap: 8px; }
.chat-head__back { width: 34px; height: 34px; font-size: 1.5rem; }
.chat-head__name { font-size: 0.76rem; }
.chat-head__sub { font-size: 0.56rem; }
.chat-head .model-chip { padding: 5px 10px; font-size: 0.9rem; -webkit-text-stroke-width: 0.45px; }
.chat-head__save,
.chat-head__restore { height: 30px; min-width: 42px; padding: 0 9px; font-size: 0.7rem; }
.chat-head__clear { width: 32px; height: 32px; font-size: 0.9rem; }
.bubble { font-size: 0.8rem; line-height: 1.6; }
`;

copyFileSync(HTML, `${HTML}.bak-before-chatfix`);
copyFileSync(CSS, `${CSS}.bak-before-chatfix`);
writeFileSync(HTML, html);
writeFileSync(CSS, css);
console.log('CHATFIX-OK 改好了，接着跑 npm run build && pm2 restart codeandpurrs');
