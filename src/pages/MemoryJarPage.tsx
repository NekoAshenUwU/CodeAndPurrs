import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addMemory,
  listCategories,
  loadMemories,
  removeMemory,
  updateMemory,
  type Memory,
} from '../services/memory';

// 记忆罐头 Memory Jar —— 跨对话的长期记忆库：可分类、可搜索、可手动增删改。
// 聊天里 AI 用 [记忆:分类|内容] 自动存进来，这里也能手动管理。
export function MemoryJarPage() {
  const [items, setItems] = useState<Memory[]>(loadMemories);
  const [q, setQ] = useState('');
  const [activeCat, setActiveCat] = useState('全部');
  const [newCat, setNewCat] = useState('');
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftCat, setDraftCat] = useState('');

  const refresh = () => setItems(loadMemories());
  const cats = useMemo(() => listCategories(items), [items]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return items.filter(
      (m) =>
        (activeCat === '全部' || m.category === activeCat) &&
        (!kw || m.text.toLowerCase().includes(kw) || m.category.toLowerCase().includes(kw)),
    );
  }, [items, q, activeCat]);

  const add = () => {
    if (!newText.trim()) return;
    addMemory(newCat, newText);
    setNewText('');
    setNewCat('');
    refresh();
  };
  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setDraftText(m.text);
    setDraftCat(m.category);
  };
  const commitEdit = () => {
    if (editingId && draftText.trim()) updateMemory(editingId, { text: draftText.trim(), category: draftCat.trim() });
    setEditingId(null);
    refresh();
  };
  const del = (m: Memory) => {
    if (window.confirm(`删掉这条记忆？\n「${m.text}」`)) {
      removeMemory(m.id);
      refresh();
    }
  };

  return (
    <main className="memory-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">记忆罐头</span>
          <span className="chat-head__sub">Memory Jar · 长期记忆</span>
        </div>
        <span className="memory-count">{items.length} 条</span>
      </header>

      <div className="memory-scroll">
        <section className="memory-add">
          <input
            className="memory-add__cat"
            placeholder="分类（如 纪念日 / 喜好）"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            maxLength={12}
          />
          <textarea
            className="memory-add__text"
            placeholder="想让它永远记住的事…"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
          />
          <button type="button" className="memory-add__btn" onClick={add} disabled={!newText.trim()}>
            🫙 记进罐头
          </button>
        </section>

        <div className="memory-search">
          <input placeholder="🔍 搜索记忆…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="memory-cats">
          <button type="button" className={activeCat === '全部' ? 'is-on' : ''} onClick={() => setActiveCat('全部')}>
            全部
          </button>
          {cats.map((c) => (
            <button type="button" key={c} className={activeCat === c ? 'is-on' : ''} onClick={() => setActiveCat(c)}>
              {c}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🫙</div>
            <p>{items.length ? '没找到这条记忆' : '罐头还空空的'}</p>
            <span>聊天时予予会把重要的事自己存进来，你也能在上面手动加。</span>
          </div>
        ) : (
          <ul className="memory-list">
            {filtered.map((m) => (
              <li key={m.id} className="memory-card">
                {editingId === m.id ? (
                  <div className="memory-card__edit">
                    <input value={draftCat} onChange={(e) => setDraftCat(e.target.value)} maxLength={12} placeholder="分类" />
                    <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={2} />
                    <div className="memory-card__ops">
                      <button type="button" onClick={() => setEditingId(null)}>取消</button>
                      <button type="button" className="is-primary" onClick={commitEdit}>保存</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="memory-card__cat">{m.category}</span>
                    <p className="memory-card__text">{m.text}</p>
                    <div className="memory-card__actions">
                      <button type="button" onClick={() => startEdit(m)} aria-label="改" title="改">✎</button>
                      <button type="button" onClick={() => del(m)} aria-label="删" title="删">🗑️</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
