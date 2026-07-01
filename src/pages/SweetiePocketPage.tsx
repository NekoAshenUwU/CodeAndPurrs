import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { balanceOf, loadPackets, type RedPacket } from '../services/redPacket';

const fmtStamp = (at: number): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 甜甜口袋 —— 棠棠和予予各自的虚拟红包户口(互不混,各自只累积对方发来的)。
// 发红包在呼噜频道「＋ → 红包」里(像微信一样能写留言)，这里只看余额和历史。
export function SweetiePocketPage() {
  const [packets] = useState<RedPacket[]>(loadPackets);
  const userBalance = useMemo(() => balanceOf('user', packets), [packets]);
  const aiBalance = useMemo(() => balanceOf('ai', packets), [packets]);

  return (
    <main className="sweetie-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">甜甜口袋</span>
          <span className="chat-head__sub">Sweetie Pocket · 虚拟红包</span>
        </div>
      </header>

      <div className="memory-scroll">
        <div className="sweetie-balances">
          <div className="sweetie-balance-card">
            <span className="sweetie-balance-card__who">🐾 棠棠的口袋</span>
            <span className="sweetie-balance-card__amount">¥{userBalance}</span>
          </div>
          <div className="sweetie-balance-card">
            <span className="sweetie-balance-card__who">🍯 予予的口袋</span>
            <span className="sweetie-balance-card__amount">¥{aiBalance}</span>
          </div>
        </div>
        <p className="sweetie-hint">去呼噜频道点「＋ → 红包」就能发一个，写句话给对方，像微信一样～</p>

        {packets.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🧧</div>
            <p>口袋还空空的</p>
            <span>发第一个红包试试吧</span>
          </div>
        ) : (
          <ul className="sweetie-list">
            {packets.map((p) => (
              <li key={p.id} className={`sweetie-item sweetie-item--${p.from}`}>
                <div className="sweetie-item__head">
                  <span className="sweetie-item__from">{p.from === 'user' ? '棠棠 → 予予' : '予予 → 棠棠'}</span>
                  <span className="sweetie-item__amount">¥{p.amount}</span>
                </div>
                {p.note ? <p className="sweetie-item__note">{p.note}</p> : null}
                <span className="sweetie-item__time">{fmtStamp(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
