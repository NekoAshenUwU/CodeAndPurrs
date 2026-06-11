import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage, type Provider } from '../services/chat';
import { clearLocal, loadLocal, saveLocal } from '../services/storage';

const HISTORY_KEY = 'purr-channel:turns';
const PROVIDER_KEY = 'purr-channel:provider';

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: 'streaming' | 'done' | 'error';
};

const SYSTEM_PROMPT =
  '你是「呼噜频道」里的猫咪伙伴，说话温柔、俏皮、带一点猫感，偶尔用「喵」。回答简洁自然，像在跟最亲近的人聊天。';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'gemini', label: 'Gemini' },
];

const uid = () => Math.random().toString(36).slice(2, 10);

// 思考链折叠卡片：流式思考时自动展开，思考结束自动收起。
function ThinkingCard({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  if (!text) return null;

  return (
    <div className={`think-card${open ? ' is-open' : ''}`}>
      <button type="button" className="think-card__toggle" onClick={() => setOpen((v) => !v)}>
        <span className="think-card__spark">{streaming ? '🌀' : '💭'}</span>
        <span>{streaming ? '正在想…' : '想了想'}</span>
        <span className="think-card__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="think-card__body">{text}</div> : null}
    </div>
  );
}

export function PurrChannelPage() {
  // 从小暗格读出上次的聊天记录；半截没说完的(streaming)归位成 done
  const [turns, setTurns] = useState<Turn[]>(() =>
    loadLocal<Turn[]>(HISTORY_KEY, []).map((t) =>
      t.status === 'streaming' ? { ...t, status: 'done' } : t,
    ),
  );
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>(() =>
    loadLocal<Provider>(PROVIDER_KEY, 'deepseek'),
  );
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 新消息进来就滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  // 聊天记录睡进小暗格（不在流式中途反复写，省一点）
  useEffect(() => {
    if (!sending) saveLocal(HISTORY_KEY, turns);
  }, [turns, sending]);

  useEffect(() => {
    saveLocal(PROVIDER_KEY, provider);
  }, [provider]);

  const clearHistory = () => {
    if (sending) return;
    if (turns.length && !window.confirm('清空这间房的聊天记录？暗格里也会一起删掉哦。')) return;
    setTurns([]);
    clearLocal(HISTORY_KEY);
  };

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userTurn: Turn = { id: uid(), role: 'user', content: text, reasoning: '', status: 'done' };
    const botId = uid();
    const botTurn: Turn = { id: botId, role: 'assistant', content: '', reasoning: '', status: 'streaming' };

    // 在更新 state 之前先把历史算好，避免拿到异步后的旧值
    const history: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: text },
    ];

    setTurns((prev) => [...prev, userTurn, botTurn]);
    setInput('');
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    await streamChat(
      { provider, messages: history, signal: controller.signal },
      {
        onReasoning: (chunk) =>
          setTurns((prev) =>
            prev.map((t) => (t.id === botId ? { ...t, reasoning: t.reasoning + chunk } : t)),
          ),
        onContent: (chunk) =>
          setTurns((prev) =>
            prev.map((t) => (t.id === botId ? { ...t, content: t.content + chunk } : t)),
          ),
        onError: (message) =>
          patchTurn(botId, { status: 'error', content: `(｡•́︿•̀｡) 出错了：${message}` }),
        onDone: () => patchTurn(botId, { status: 'done' }),
      },
    );

    setSending(false);
    abortRef.current = null;
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setTurns((prev) =>
      prev.map((t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t)),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <main className="chat-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">呼噜频道</span>
          <span className="chat-head__sub">Purr Channel</span>
        </div>
        <div className="chat-head__provider" role="group" aria-label="选择模型">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === provider ? 'is-on' : ''}
              onClick={() => setProvider(p.id)}
              disabled={sending}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chat-head__clear"
          onClick={clearHistory}
          disabled={sending || turns.length === 0}
          aria-label="清空聊天记录"
          title="清空聊天记录"
        >
          🧹
        </button>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🐾</div>
            <p>跟我说点什么吧～</p>
            <span>没配 API key 也能聊，会先用 mock 假装回复。</span>
          </div>
        ) : null}

        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="bubble-row is-user">
              <div className="bubble bubble--user">{turn.content}</div>
            </div>
          ) : (
            <div key={turn.id} className="bubble-row is-bot">
              <div className="bubble-stack">
                <ThinkingCard text={turn.reasoning} streaming={turn.status === 'streaming'} />
                <div className={`bubble bubble--bot${turn.status === 'error' ? ' is-error' : ''}`}>
                  {turn.content || (turn.status === 'streaming' ? <span className="typing-dots"><i /><i /><i /></span> : '')}
                </div>
              </div>
            </div>
          ),
        )}
      </div>

      <footer className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="发消息…（Enter 发送 / Shift+Enter 换行）"
          rows={1}
        />
        {sending ? (
          <button type="button" className="chat-input__btn is-stop" onClick={stop}>
            停
          </button>
        ) : (
          <button
            type="button"
            className="chat-input__btn"
            onClick={() => void send()}
            disabled={!input.trim()}
          >
            发送
          </button>
        )}
      </footer>
    </main>
  );
}
