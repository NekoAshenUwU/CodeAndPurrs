// 思考链里予予调用的工具，改成单独一颗「工具胶囊」显示，跟思考文字区分开。
// 后端 apply-tool-trace.mjs 会在思考流里插「🔧 读一段记忆　✓」这样的行，这里把它们挑出来换样式。
// 改 src/pages/PurrChannelPage.tsx（ThinkingCard）和 global.css 末尾，之后要 npm run build。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const TSX = 'src/pages/PurrChannelPage.tsx';
const CSS = 'src/styles/global.css';
let tsx = readFileSync(TSX, 'utf8');
let css = readFileSync(CSS, 'utf8');
if (tsx.includes('renderThinkingWithTools')) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
const fail = (why) => {
  console.error(`没改任何东西：${why}`);
  process.exit(1);
};

const fnAnchor = /^function ThinkingCard\(/m;
if (!fnAnchor.test(tsx)) fail('找不到 function ThinkingCard(');
const bodyAnchor = /(className=\{`think-card__body[^\n]*\n(?:[^\n]*\n){0,3}?\s*)\{text\}/;
if (!bodyAnchor.test(tsx)) fail('找不到思考链正文的 {text}');

tsx = tsx.replace(fnAnchor, (m) => `// 思考流里后端插的「🔧 工具名　✓ / ✗ 没成功」行 → 单独的工具胶囊，跟思考文字分开。
const TOOL_TRACE_RE = /🔧 ([^\\n]*?)(?:\\u3000(✓|✗ 没成功))?(?=\\n|$)/g;
function toolChip(key: string, state: string, name: string, done?: string) {
  return (
    <span key={key} className={\`think-tool \${state}\`}>
      <span className="think-tool__icon" aria-hidden="true">🔧</span>
      <span className="think-tool__name">{name}</span>
      <span className="think-tool__state">{done ? (done === '✓' ? '✓ 完成' : '✗ 没成功') : '…'}</span>
    </span>
  );
}
function renderThinkingWithTools(text: string) {
  const out: (string | ReturnType<typeof toolChip>)[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOOL_TRACE_RE)) {
    const at = m.index ?? 0;
    const before = text.slice(last, at).replace(/\\n+$/, '\\n');
    if (before.trim()) out.push(before);
    const state = m[2] ? (m[2] === '✓' ? 'is-ok' : 'is-err') : 'is-pending';
    out.push(toolChip(\`tool-\${i++}\`, state, m[1], m[2]));
    last = at + m[0].length;
  }
  const rest = text.slice(last).replace(/^\\n+/, '');
  if (rest) out.push(rest);
  return out;
}

${m}`);
tsx = tsx.replace(bodyAnchor, (m, head) => `${head}{renderThinkingWithTools(text)}`);

css += `

/* ===== 思考链里的工具胶囊：跟思考文字分开，一眼看出予予动了什么工具 ===== */
.think-tool {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
  margin: 8px 0;
  padding: 5px 12px 5px 9px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.85);
  background: linear-gradient(100deg, rgba(225, 236, 255, 0.85), rgba(240, 226, 255, 0.85));
  box-shadow: 0 3px 10px rgba(120, 100, 180, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  font-family: var(--round);
  font-size: 0.74rem;
  line-height: 1.3;
  color: #5d4a8c;
  white-space: normal;
}
.think-tool__icon { font-size: 0.8rem; }
.think-tool__name { font-weight: 700; overflow-wrap: anywhere; }
.think-tool__state {
  flex-shrink: 0;
  margin-left: 2px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.68rem;
  background: rgba(255, 255, 255, 0.7);
  color: #8a79b0;
}
.think-tool.is-ok .think-tool__state { color: #3f8a73; background: rgba(206, 245, 230, 0.9); }
.think-tool.is-err .think-tool__state { color: #b14d6a; background: rgba(255, 220, 230, 0.9); }
`;

copyFileSync(TSX, `${TSX}.bak-before-toolchips`);
copyFileSync(CSS, `${CSS}.bak-before-toolchips`);
writeFileSync(TSX, tsx);
writeFileSync(CSS, css);
console.log('CHIPS-OK 改好了，接着 npm run build && pm2 restart codeandpurrs');
