import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage, type Provider } from '../services/chat';
import { clearLocal, loadLocal, saveLocal } from '../services/storage';
import { transcribeAudio, VoiceRecorder, type Recording } from '../services/voice';

const HISTORY_KEY = 'purr-channel:turns';
const PROVIDER_KEY = 'purr-channel:provider';

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

export function PurrChannelPage() {
  // 从小暗格读出上次的聊天记录；半截没说完的归位，语音 blob 刷新后失效就丢掉播放地址。
  const [turns, setTurns] = useState<Turn[]>(() =>
    loadLocal<Turn[]>(HISTORY_KEY, []).map((t) => ({
      ...t,
      status: t.status === 'streaming' ? 'done' : t.status,
      transcribing: false,
      voice: t.voice ? { duration: t.voice.duration } : undefined,
    })),
  );
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>(() => loadLocal<Provider>(PROVIDER_KEY, 'deepseek'));
  const [sending, setSending] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

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
              </div>
            </div>
          ),
        )}
      </div>

      <footer className="chat-input">
        <button
          type="button"
          className="chat-input__mode"
          onClick={() => setVoiceMode((v) => !v)}
          disabled={sending || recording}
          aria-label={voiceMode ? '切换到键盘' : '切换到语音'}
          title={voiceMode ? '切换到键盘' : '切换到语音'}
        >
          {voiceMode ? '⌨️' : '🎙️'}
        </button>

        {voiceMode ? (
          <button
            type="button"
            className={`chat-input__hold${recording ? ' is-recording' : ''}`}
            disabled={sending}
            onPointerDown={() => void startRec()}
            onPointerUp={() => void stopRec(true)}
            onPointerLeave={() => recording && void stopRec(false)}
          >
            {recording ? '松开 发送 · 移开 取消' : '按住 说话'}
          </button>
        ) : (
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="发消息…（Enter 发送 / Shift+Enter 换行）"
            rows={1}
          />
        )}

        {sending ? (
          <button type="button" className="chat-input__btn is-stop" onClick={stop}>
            停
          </button>
        ) : voiceMode ? null : (
          <button type="button" className="chat-input__btn" onClick={() => void send()} disabled={!input.trim()}>
            发送
          </button>
        )}
      </footer>
    </main>
  );
}
