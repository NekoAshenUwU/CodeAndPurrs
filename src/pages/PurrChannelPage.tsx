import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage, type Provider } from '../services/chat';
import { clearLocal, loadLocal, saveLocal } from '../services/storage';
import { speak, transcribeAudio, VoiceRecorder, type Recording } from '../services/voice';

const WINDOWS_KEY = 'purr-channel:windows';
const LEGACY_TURNS_KEY = 'purr-channel:turns'; // 旧版单一对话，首次进入迁移成一个窗口
const PROVIDER_KEY = 'purr-channel:provider';
const turnsKey = (id: string) => `purr-channel:turns:${id}`;

// 一个聊天窗口的元信息（聊天记录另存在 turnsKey(id) 下）
type WindowMeta = { id: string; name: string; createdAt: number; updatedAt: number; preview?: string };

type Voice = { url?: string; duration: number };

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: 'streaming' | 'done' | 'error';
  voice?: Voice; // 用户语音消息才有；content 存转写出来的文字
  transcribing?: boolean;
};

const SYSTEM_PROMPT =
  '你是「呼噜频道」里的猫咪伙伴，说话温柔、俏皮、带一点猫感，偶尔用「喵」。回答简洁自然，像在跟最亲近的人聊天。';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'gemini', label: 'Gemini' },
];

const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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

// 微信式语音气泡：播放 + 时长 + 转文字。
function VoiceBubble({ voice, transcript, transcribing }: { voice: Voice; transcript: string; transcribing: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [showText, setShowText] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = () => {
    if (!voice.url) return;
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(voice.url);
      audio.onended = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play();
      setPlaying(true);
    }
  };

  // 宽度跟时长走，像微信那样越长气泡越宽
  const width = Math.min(70, 30 + voice.duration * 4);

  return (
    <div className="voice-wrap">
      <button
        type="button"
        className={`voice-bubble${playing ? ' is-playing' : ''}`}
        style={{ minWidth: `${width}%` }}
        onClick={togglePlay}
        disabled={!voice.url}
        title={voice.url ? '点击播放' : '这段录音刷新后就听不到了，文字还在'}
      >
        <span className="voice-bubble__icon">{playing ? '⏸' : '▶'}</span>
        <span className="voice-bubble__bars" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <i key={i} style={{ height: `${30 + ((i * 7) % 60)}%` }} />
          ))}
        </span>
        <span className="voice-bubble__dur">{fmt(voice.duration)}</span>
      </button>
      <button
        type="button"
        className="voice-wrap__t2t"
        onClick={() => setShowText((v) => !v)}
        disabled={transcribing}
      >
        {transcribing ? '转写中…' : showText ? '收起文字' : '转文字'}
      </button>
      {showText && !transcribing ? <div className="voice-wrap__text">{transcript || '（没听清）'}</div> : null}
    </div>
  );
}

// 猫咪消息旁的「听一声」：点了才生成（ElevenLabs），生成过的缓存起来，再点不重复烧额度。
function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const urlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = (url: string) => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setState('idle');
    audio.onerror = () => setState('idle');
    void audio.play();
    setState('playing');
  };

  const onClick = async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      return;
    }
    if (urlRef.current) {
      play(urlRef.current);
      return;
    }
    setState('loading');
    try {
      const url = await speak(text);
      urlRef.current = url;
      play(url);
    } catch (err) {
      setState('idle');
      window.alert(`没发出声音：${(err as Error).message}`);
    }
  };

  return (
    <button type="button" className={`speak-btn is-${state}`} onClick={() => void onClick()} title="听猫咪念这句">
      {state === 'loading' ? '…' : state === 'playing' ? '⏸' : '🔊'}
      <span>{state === 'loading' ? '生成中' : state === 'playing' ? '播放中' : '听一声'}</span>
    </button>
  );
}

// ===== 输入区玻璃珠图标（VisionOS 玻璃风，白色线性字形）=====
function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5.5v13M5.5 12h13" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
function IconArrowUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 18.5V6M6.5 11l5.5-5.2 5.5 5.2" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconMic() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="#fff" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}
// 跳动音波：5 根白柱，错峰弹跳（语音录制中状态）
function IconWave() {
  return (
    <span className="cg-wave" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function IconStop() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2.5" fill="#fff" />
    </svg>
  );
}
function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 5.5l4 4M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19l-4 1z" stroke="#7a5fce" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6" stroke="#b06a8a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MORE_ITEMS = [
  { key: 'image', label: '图片' },
  { key: 'redpacket', label: '红包' },
  { key: 'meme', label: '表情包' },
];

// ===== 单个聊天窗口的聊天室（沿用原有全部聊天逻辑，记录按 win.id 分开存）=====
function ChatRoom({
  win,
  onBack,
  onTouch,
}: {
  win: WindowMeta;
  onBack: () => void;
  onTouch: (id: string, preview: string) => void;
}) {
  // 从小暗格读出这个窗口的聊天记录；半截没说完的归位，语音 blob 刷新后失效就丢掉播放地址。
  const [turns, setTurns] = useState<Turn[]>(() =>
    loadLocal<Turn[]>(turnsKey(win.id), []).map((t) => ({
      ...t,
      status: t.status === 'streaming' ? 'done' : t.status,
      transcribing: false,
      voice: t.voice ? { duration: t.voice.duration } : undefined,
    })),
  );
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>(() => loadLocal<Provider>(PROVIDER_KEY, 'deepseek'));
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  useEffect(() => {
    if (sending) return;
    saveLocal(turnsKey(win.id), turns);
    // 顺便回写窗口预览/更新时间，给列表用
    const last = [...turns].reverse().find((t) => t.content.trim());
    onTouch(win.id, last ? last.content.slice(0, 24) : '');
    // onTouch 每次渲染都是新引用，故意不进依赖，避免回环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, sending, win.id]);

  useEffect(() => {
    saveLocal(PROVIDER_KEY, provider);
  }, [provider]);

  // 小提示自动消失
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 「+」菜单：图片 / 红包 / 表情包（后端待接，先给温柔占位）
  const pickMore = (label: string) => {
    setMoreOpen(false);
    setNotice(`「${label}」马上就来啦，先占个位～`);
  };

  const clearHistory = () => {
    if (sending) return;
    if (turns.length && !window.confirm('清空这个窗口的聊天记录？暗格里也会一起删掉哦。')) return;
    setTurns([]);
    clearLocal(turnsKey(win.id));
  };

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const toMessages = (ts: Turn[]): ChatMessage[] => [
    { role: 'system', content: SYSTEM_PROMPT },
    ...ts.filter((t) => t.content.trim()).map((t) => ({ role: t.role, content: t.content })),
  ];

  // 让猫咪基于给定历史回一条
  const runAssistant = async (history: ChatMessage[]) => {
    const botId = uid();
    setTurns((prev) => [...prev, { id: botId, role: 'assistant', content: '', reasoning: '', status: 'streaming' }]);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    await streamChat(
      { provider, messages: history, signal: controller.signal },
      {
        onReasoning: (chunk) =>
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, reasoning: t.reasoning + chunk } : t))),
        onContent: (chunk) =>
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: t.content + chunk } : t))),
        onError: (message) => patchTurn(botId, { status: 'error', content: `(｡•́︿•̀｡) 出错了：${message}` }),
        onDone: () => patchTurn(botId, { status: 'done' }),
      },
    );

    setSending(false);
    abortRef.current = null;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const userTurn: Turn = { id: uid(), role: 'user', content: text, reasoning: '', status: 'done' };
    const history = toMessages([...turns, userTurn]);
    setTurns((prev) => [...prev, userTurn]);
    setInput('');
    await runAssistant(history);
  };

  // 录音结束 → 上语音气泡 → 转文字 → 把文字喂给猫咪
  const onRecordingDone = async (rec: Recording, prevTurns: Turn[]) => {
    const vId = uid();
    const voiceTurn: Turn = {
      id: vId,
      role: 'user',
      content: '',
      reasoning: '',
      status: 'done',
      voice: { url: rec.url, duration: rec.duration },
      transcribing: true,
    };
    setTurns((prev) => [...prev, voiceTurn]);
    try {
      const text = await transcribeAudio(rec);
      patchTurn(vId, { content: text, transcribing: false });
      if (text.trim()) {
        await runAssistant(toMessages([...prevTurns, { ...voiceTurn, content: text, transcribing: false }]));
      }
    } catch (err) {
      patchTurn(vId, { transcribing: false, content: `（转写失败：${(err as Error).message}）` });
    }
  };

  const startRec = async () => {
    if (sending || recording) return;
    if (!VoiceRecorder.supported) {
      window.alert('这个浏览器不支持录音，换 Chrome/Safari 试试～');
      return;
    }
    try {
      const recorder = new VoiceRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      window.alert('没拿到麦克风权限，去浏览器设置里允许一下哦。');
    }
  };

  const stopRec = async (sendIt: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    if (!sendIt) {
      recorder.cancel();
      return;
    }
    const snapshot = turns; // 录音这会儿的历史
    try {
      const rec = await recorder.stop();
      if (rec.duration < 1) return;
      await onRecordingDone(rec, snapshot);
    } catch {
      // 忽略
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setTurns((prev) => prev.map((t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t)));
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
        <button type="button" onClick={onBack} className="chat-head__back" aria-label="回窗口列表">
          ‹
        </button>
        <div className="chat-head__title">
          <span className="chat-head__name">{win.name}</span>
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
            <span>打字或按住🎙️说话都行，没配 key 会先 mock。</span>
          </div>
        ) : null}

        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="bubble-row is-user">
              {turn.voice ? (
                <VoiceBubble voice={turn.voice} transcript={turn.content} transcribing={!!turn.transcribing} />
              ) : (
                <div className="bubble bubble--user">{turn.content}</div>
              )}
            </div>
          ) : (
            <div key={turn.id} className="bubble-row is-bot">
              <div className="bubble-stack">
                <ThinkingCard text={turn.reasoning} streaming={turn.status === 'streaming'} />
                <div className={`bubble bubble--bot${turn.status === 'error' ? ' is-error' : ''}`}>
                  {turn.content || (turn.status === 'streaming' ? <span className="typing-dots"><i /><i /><i /></span> : '')}
                </div>
                {turn.status === 'done' && turn.content ? <SpeakButton text={turn.content} /> : null}
              </div>
            </div>
          ),
        )}
      </div>

      <footer className="chat-input">
        {/* + 更多：点开图片 / 红包 / 表情包菜单 */}
        <div className="chat-more-wrap">
          <button
            type="button"
            className={`chat-glass-btn cg-plus${moreOpen ? ' is-open' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
            disabled={sending || recording}
            aria-label="更多"
            aria-expanded={moreOpen}
            title="更多"
          >
            <IconPlus />
          </button>
          {moreOpen ? (
            <>
              <button
                type="button"
                className="chat-more__scrim"
                aria-label="关闭菜单"
                onClick={() => setMoreOpen(false)}
              />
              <div className="chat-more" role="menu">
                {MORE_ITEMS.map((it) => (
                  <button key={it.key} type="button" role="menuitem" onClick={() => pickMore(it.label)}>
                    {it.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="发消息…（Enter 发送 / Shift+Enter 换行）"
          rows={1}
        />

        {/* 语音键：平时麦克风，按住变跳动音波（松开发送 · 移开取消）*/}
        <button
          type="button"
          className={`chat-glass-btn cg-voice${recording ? ' is-rec' : ''}`}
          disabled={sending}
          onPointerDown={() => void startRec()}
          onPointerUp={() => void stopRec(true)}
          onPointerLeave={() => recording && void stopRec(false)}
          aria-label={recording ? '松开发送，移开取消' : '按住说话'}
          title={recording ? '松开发送 · 移开取消' : '按住说话'}
        >
          {recording ? <IconWave /> : <IconMic />}
        </button>

        {/* 发送 / 停止 */}
        {sending ? (
          <button type="button" className="chat-glass-btn cg-send is-stop" onClick={stop} aria-label="停止">
            <IconStop />
          </button>
        ) : (
          <button
            type="button"
            className="chat-glass-btn cg-send"
            onClick={() => void send()}
            disabled={!input.trim()}
            aria-label="发送"
          >
            <IconArrowUp />
          </button>
        )}

        {notice ? <div className="chat-toast">{notice}</div> : null}
      </footer>
    </main>
  );
}

// 相对时间：刚刚 / x分钟前 / x小时前 / x天前
function fmtWhen(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

// ===== 窗口列表：进入呼噜频道先看到这一屏，可开新窗口 / 重命名 / 删除 =====
function WindowList({
  windows,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: {
  windows: WindowMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startEdit = (w: WindowMeta) => {
    setEditingId(w.id);
    setDraft(w.name);
  };
  const commitEdit = () => {
    if (editingId) onRename(editingId, draft.trim() || '新对话');
    setEditingId(null);
  };

  return (
    <main className="chat-page win-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">呼噜频道</span>
          <span className="chat-head__sub">Purr Channel · 聊天窗</span>
        </div>
        <button
          type="button"
          className="chat-glass-btn cg-newwin"
          onClick={onNew}
          aria-label="开新窗口"
          title="开新窗口"
        >
          <IconPlus />
        </button>
      </header>

      <div className="win-list">
        {windows.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__paw">🐾</div>
            <p>还没有窗口呢</p>
            <span>点右上角 ＋ 开一个新窗口，开始跟猫咪聊天吧～</span>
          </div>
        ) : (
          windows.map((w) => (
            <div key={w.id} className="win-card">
              {editingId === w.id ? (
                <input
                  className="win-card__rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={commitEdit}
                  maxLength={24}
                />
              ) : (
                <button type="button" className="win-card__open" onClick={() => onOpen(w.id)}>
                  <span className="win-card__name">{w.name}</span>
                  <span className="win-card__preview">{w.preview || '还没说话…'}</span>
                  <span className="win-card__when">{fmtWhen(w.updatedAt)}</span>
                </button>
              )}
              <div className="win-card__actions">
                <button type="button" className="win-act" onClick={() => startEdit(w)} aria-label="重命名" title="重命名">
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="win-act"
                  onClick={() => {
                    if (window.confirm(`删除「${w.name}」？这个窗口的聊天记录也会一起删掉哦。`)) onDelete(w.id);
                  }}
                  aria-label="删除"
                  title="删除"
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}

// 首次进入：迁移旧版单一对话成一个窗口
function initWindows(): WindowMeta[] {
  const wins = loadLocal<WindowMeta[]>(WINDOWS_KEY, []);
  if (wins.length) return wins;
  const legacy = loadLocal<Turn[]>(LEGACY_TURNS_KEY, []);
  if (legacy.length) {
    const id = uid();
    saveLocal(turnsKey(id), legacy);
    clearLocal(LEGACY_TURNS_KEY);
    const last = [...legacy].reverse().find((t) => t.content.trim());
    return [
      {
        id,
        name: '之前的对话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        preview: last ? last.content.slice(0, 24) : '',
      },
    ];
  }
  return [];
}

export function PurrChannelPage() {
  const [windows, setWindows] = useState<WindowMeta[]>(initWindows);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    saveLocal(WINDOWS_KEY, windows);
  }, [windows]);

  const newWindow = () => {
    const id = uid();
    setWindows((prev) => [{ id, name: '新对话', createdAt: Date.now(), updatedAt: Date.now() }, ...prev]);
    setActiveId(id);
  };
  const renameWindow = (id: string, name: string) =>
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
  const deleteWindow = (id: string) => {
    clearLocal(turnsKey(id));
    setWindows((prev) => prev.filter((w) => w.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  };
  const touchWindow = (id: string, preview: string) =>
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, updatedAt: Date.now(), preview } : w)));

  const active = windows.find((w) => w.id === activeId) ?? null;

  if (active) {
    return <ChatRoom key={active.id} win={active} onBack={() => setActiveId(null)} onTouch={touchWindow} />;
  }
  return (
    <WindowList
      windows={windows}
      onOpen={(id) => setActiveId(id)}
      onNew={newWindow}
      onRename={renameWindow}
      onDelete={deleteWindow}
    />
  );
}
