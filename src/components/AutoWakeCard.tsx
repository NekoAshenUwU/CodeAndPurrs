import { useEffect, useState } from 'react';
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
          className={`autowake-switch${on ? ' is-on' : ''}`}
          onClick={() => void toggle()}
          disabled={busy || server === null}
        >
          <span className="autowake-switch__knob" />
        </button>
      </div>
      <p className="autowake-card__status">
        {server === null ? '读不到状态' : on ? (server.nextWakeAt ? `开着 · 下次大概 ${fmt(server.nextWakeAt)}` : '开着') : '关着'}
        {server?.lastWakeAt ? ` · 上次 ${fmt(server.lastWakeAt)}` : ''}
      </p>
      {note ? <p className="autowake-card__note">{note}</p> : null}
    </section>
  );
}
