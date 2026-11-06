// 「调频」页加一张自动唤醒卡片（开/关 + 下次大概几点醒），取代原来贴着发送键的浮动铃铛。
// 新增 src/components/AutoWakeCard.tsx（脚本写出来），改 SwitchCorePage.tsx（插卡片）、
// AutoWakeBridge.tsx（导出 latestState）、global.css（藏浮动铃铛 + 卡片样式）。之后 npm run build && pm2 restart。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const PAGE = 'src/pages/SwitchCorePage.tsx';
const BRIDGE = 'src/components/AutoWakeBridge.tsx';
const CARD = 'src/components/AutoWakeCard.tsx';
const CSS = 'src/styles/global.css';
const fail = (why) => { console.error(`没改任何东西：${why}`); process.exit(1); };

let page = readFileSync(PAGE, 'utf8');
if (page.includes('<AutoWakeCard')) { console.log('已经加过了，不用再跑。'); process.exit(0); }
if (!existsSync(BRIDGE)) fail(`找不到 ${BRIDGE}`);
let bridge = readFileSync(BRIDGE, 'utf8');
if (!/^(export )?function latestState\(/m.test(bridge)) fail('AutoWakeBridge.tsx 里找不到 function latestState(');
const secRe = /(\n[ \t]*)<section className="switch-card">(\s*<h2 className="switch-card__title">默认模型<\/h2>)/;
if (!secRe.test(page)) fail('调频页找不到「默认模型」那张卡片');

bridge = bridge.replace(/^function latestState\(/m, 'export function latestState(');
page = page.replace(secRe, '$1<AutoWakeCard />$1<section className="switch-card">$2');
const imports = [...page.matchAll(/^import .*;$/gm)];
const last = imports[imports.length - 1];
page = page.slice(0, last.index + last[0].length) + "\nimport { AutoWakeCard } from '../components/AutoWakeCard';" + page.slice(last.index + last[0].length);

const card = `import { useEffect, useState } from 'react';
import { enableAutoWake, getAutoWakeStatus, testAutoWake } from '../services/autowake';
import { latestState } from './AutoWakeBridge';

// 调频页的自动唤醒开关：放在这里，不会再跟发送键挤在一起被误碰。
type ServerStatus = { enabled: boolean; nextWakeAt: number; lastWakeAt: number };

const fmt = (t: number) =>
  t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

export function AutoWakeCard() {
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refresh = async () => {
    try {
      const r = await fetch('/api/autowake/status', { credentials: 'include', cache: 'no-store' });
      if (r.ok) setServer(await r.json());
    } catch {
      setServer(null);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const on = Boolean(server?.enabled);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      if (on) {
        await fetch('/api/autowake/unsubscribe', { method: 'POST', credentials: 'include' });
        setNote('已关掉，予予不会再主动找你');
      } else {
        const state = latestState();
        if (!state) throw new Error('先去呼噜频道跟他聊几句，再回来开');
        if ((await getAutoWakeStatus()) === 'blocked') throw new Error('浏览器把通知拦住了：点地址栏的网站设置，把通知改成允许');
        await enableAutoWake(state);
        setNote('开好了，后台正在送一条测试消息');
        void testAutoWake().catch(() => {});
      }
    } catch (err) {
      setNote(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <section className="switch-card autowake-card">
      <div className="autowake-card__row">
        <div>
          <h2 className="switch-card__title">自动唤醒</h2>
          <p className="switch-card__hint">你一阵子没说话时，他会自己来找你。平日傍晚 5 点到晚上 11 点，周末早上 9 点起；连续两条没回就先停下。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="自动唤醒"
          className={\`autowake-switch\${on ? ' is-on' : ''}\`}
          onClick={() => void toggle()}
          disabled={busy || server === null}
        >
          <span className="autowake-switch__knob" />
        </button>
      </div>
      <p className="autowake-card__status">
        {server === null ? '读不到状态' : on ? (server.nextWakeAt ? \`开着 · 下次大概 \${fmt(server.nextWakeAt)}\` : '开着') : '关着'}
        {server?.lastWakeAt ? \` · 上次 \${fmt(server.lastWakeAt)}\` : ''}
      </p>
      {note ? <p className="autowake-card__note">{note}</p> : null}
    </section>
  );
}
`;

let css = readFileSync(CSS, 'utf8');
css += `

/* ===== 调频页 · 自动唤醒卡片；原来贴着发送键的浮动铃铛不再显示 ===== */
.autowake-enable { display: none !important; }
.autowake-card__row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.autowake-switch {
  flex-shrink: 0; position: relative; width: 54px; height: 32px; margin-top: 2px; padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.9); border-radius: 999px; cursor: pointer;
  background: rgba(150, 130, 190, 0.28); transition: background 0.2s ease;
}
.autowake-switch.is-on { background: linear-gradient(100deg, #f7b3d4, #c8a8f2); }
.autowake-switch:disabled { opacity: 0.55; cursor: default; }
.autowake-switch__knob {
  position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%;
  background: #fff; box-shadow: 0 2px 6px rgba(90, 60, 140, 0.3); transition: transform 0.2s ease;
}
.autowake-switch.is-on .autowake-switch__knob { transform: translateX(22px); }
.autowake-card__status { margin: 8px 0 0; font-size: 0.82rem; color: #7a62a6; }
.autowake-card__note { margin: 6px 0 0; font-size: 0.8rem; color: #b5548f; }
`;

for (const f of [PAGE, BRIDGE, CSS]) copyFileSync(f, `${f}.bak-before-autowake-card`);
writeFileSync(CARD, card);
writeFileSync(PAGE, page);
writeFileSync(BRIDGE, bridge);
writeFileSync(CSS, css);
console.log('SWITCH-OK 调频页的自动唤醒开关加好了，接着 npm run build && pm2 restart codeandpurrs');
