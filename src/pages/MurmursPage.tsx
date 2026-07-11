import { Link } from 'react-router-dom';

// 倾棠予梦 · Our Murmurs —— 目前只挂了背景图和导航入口，按老婆要求不写任何
// 其他功能，后面装修再加内容。
export function MurmursPage() {
  return (
    <main className="murmurs-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">倾棠予梦</span>
          <span className="chat-head__sub">Our Murmurs</span>
        </div>
      </header>
    </main>
  );
}
