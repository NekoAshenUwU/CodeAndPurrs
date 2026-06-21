import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addMeme, getMemeURL, listMemes, removeMeme, type MemeItem } from '../services/memes';

// 脑洞贴纸盒 —— 上传/收藏表情包，存这台设备的 IndexedDB。
// 聊天时呼噜频道「＋ → 表情包」会从这里读出来发。
export function MemeBoxPage() {
  const [items, setItems] = useState<MemeItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 拉一遍贴纸列表 + 取每张的可显示地址
  const refresh = async () => {
    const metas = await listMemes();
    const pairs = await Promise.all(
      metas.map(async (m) => [m.id, await getMemeURL(m.id)] as const),
    );
    const map: Record<string, string> = {};
    for (const [id, url] of pairs) if (url) map[id] = url;
    setItems(metas);
    setUrls(map);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  const onPick = async (files: FileList | null) => {
    if (!files || !files.length) return;
    let added = 0;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        await addMeme(file);
        added += 1;
      } catch {
        // 单张失败不打断其它
      }
    }
    if (fileRef.current) fileRef.current.value = '';
    await refresh();
    setNotice(added ? `存好 ${added} 张啦～` : '没找到图片文件');
  };

  const onDelete = async (item: MemeItem) => {
    if (!window.confirm(`把「${item.name}」从盒子里拿走？`)) return;
    await removeMeme(item.id);
    await refresh();
  };

  return (
    <main className="meme-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">脑洞贴纸盒</span>
          <span className="chat-head__sub">Meme Box · 存这台设备</span>
        </div>
        <button
          type="button"
          className="meme-add-btn"
          onClick={() => fileRef.current?.click()}
          aria-label="加表情包"
          title="加表情包"
        >
          ＋ 加贴纸
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void onPick(e.target.files)}
        />
      </header>

      <div className="meme-scroll">
        {loading ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🐾</div>
            <p>正在打开盒子…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">✨</div>
            <p>盒子还空空的</p>
            <span>点右上角「加贴纸」把表情包存进来，聊天时就能发啦～</span>
            <button type="button" className="meme-empty-cta" onClick={() => fileRef.current?.click()}>
              选图片
            </button>
          </div>
        ) : (
          <div className="meme-grid">
            {items.map((item) => (
              <figure key={item.id} className="meme-cell">
                {urls[item.id] ? (
                  <img src={urls[item.id]} alt={item.name} loading="lazy" />
                ) : (
                  <span className="meme-cell__broken">图丢了</span>
                )}
                <button
                  type="button"
                  className="meme-cell__del"
                  onClick={() => void onDelete(item)}
                  aria-label={`删除 ${item.name}`}
                  title="拿走"
                >
                  ×
                </button>
              </figure>
            ))}
          </div>
        )}
      </div>

      {notice ? <div className="chat-toast meme-toast">{notice}</div> : null}
    </main>
  );
}
