import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage } from '../services/chat';
import { getModel, MODEL_GROUPS } from '../data/models';
import { buildSystemPrompt, loadDefaultModel, loadChatBg, loadChatAvatar, loadChatUserAvatar } from '../services/purrConfig';
import { addMemory, loadMemories, type Memory } from '../services/memory';
import { clearLocal, loadLocal, saveLocal } from '../services/storage';
import { speak, transcribeAudio, VoiceRecorder, type Recording } from '../services/voice';
import { getMemeURL, getMemeDataUrl, listMemes, type MemeItem } from '../services/memes';
import { fetchLatestUsage } from '../services/usageBridge';
import { fetchLocationLatest, reverseGeocode } from '../services/locationBridge';
import { getTimeOfDay } from '../components/ambient/timeOfDay';

const WINDOWS_KEY = 'purr-channel:windows';
const LEGACY_TURNS_KEY = 'purr-channel:turns'; // 旧版单一对话，首次进入迁移成一个窗口
const turnsKey = (id: string) => `purr-channel:turns:${id}`;

// 一个聊天窗口的元信息（聊天记录另存在 turnsKey(id) 下）
type WindowMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  provider?: string; // 这个窗口用哪个模型 id；缺省时跟全局默认
};

type Voice = { url?: string; duration: number };

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: 'streaming' | 'done' | 'error';
  voice?: Voice; // 用户语音消息才有；content 存转写出来的文字
  transcribing?: boolean;
  meme?: string; // 表情包消息才有：脑洞贴纸盒里的 meme id，渲染时按需取 blob
  memo?: string; // 这条 AI 回复顺手存进记忆罐头的内容（显示"记住了"小条）
  at?: number; // 消息创建时间戳
  thinkMs?: number; // 思考链耗时（从第一段思考到开始正式回复），用来显示「想了 N 秒」
  editHistory?: string[]; // 这条消息编辑过的历史版本（按时间顺序，旧→较新），当前展示的是 content
};

const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtStamp = (at?: number): string => {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 思考链折叠卡片：流式思考时自动展开，思考结束自动收起。
function ThinkingCard({ text, streaming, ms }: { text: string; streaming: boolean; ms?: number }) {
  const [open, setOpen] = useState(true);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  if (!text) return null;

  const label = streaming ? '正在想…' : ms ? `想了 ${Math.max(1, Math.round(ms / 1000))} 秒` : '想了想';

  return (
    <div className={`think-card${open ? ' is-open' : ''}`}>
      <button type="button" className="think-card__toggle" onClick={() => setOpen((v) => !v)}>
        <span className="think-card__spark">{streaming ? '🌀' : '💭'}</span>
        <span>{label}</span>
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

// 聊天里发出去的表情包气泡：只存 meme id，渲染时从脑洞贴纸盒按需取图。
// 贴纸被删了就显示占位（刷新后依旧能认出这条是表情）。
function MemeBubble({ memeId }: { memeId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    void getMemeURL(memeId).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      alive = false;
    };
  }, [memeId]);

  if (gone) return <div className="meme-msg meme-msg--gone">这张贴纸被拿走了～</div>;
  if (!url) return <div className="meme-msg meme-msg--loading" />;
  return <img className="meme-msg" src={url} alt="表情包" />;
}

// 「＋ → 表情包」弹出的选择器：列出脑洞贴纸盒里的收藏，点一张就发。
function MemePicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<MemeItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const metas = await listMemes();
      const pairs = await Promise.all(metas.map(async (m) => [m.id, await getMemeURL(m.id)] as const));
      if (!alive) return;
      const map: Record<string, string> = {};
      for (const [id, u] of pairs) if (u) map[id] = u;
      setItems(metas);
      setUrls(map);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <button type="button" className="chat-more__scrim" aria-label="关闭表情包" onClick={onClose} />
      <div className="meme-picker" role="menu">
        {loading ? (
          <div className="meme-picker__hint">打开盒子中…</div>
        ) : items.length === 0 ? (
          <div className="meme-picker__hint">
            盒子还空空的～
            <Link to="/meme-box" className="meme-picker__link">
              去脑洞贴纸盒存几张
            </Link>
          </div>
        ) : (
          <div className="meme-picker__grid">
            {items.map((m) => (
              <button
                key={m.id}
                type="button"
                className="meme-picker__cell"
                onClick={() => onPick(m.id)}
                title={m.name}
              >
                {urls[m.id] ? <img src={urls[m.id]} alt={m.name} loading="lazy" /> : <span>·</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
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

// 予予主动发的「语音条」：检测到 [语音] 标记的消息，点了才合成（像微信语音，省额度、刷新后也能重听）。
const VOICE_MARK = /^\s*[[【]\s*语音\s*[\]】]\s*/;

// AI 发表情包用的标记：[贴纸:名字] / 【贴纸：名字】，名字对应脑洞贴纸盒里的贴纸名。
const STICKER_TAG = /[[【]\s*贴纸\s*[:：]\s*([^\]】]+?)\s*[\]】]/g;
// 从回复里抠出贴纸标记：返回去掉标记后的文字 + 命中的贴纸 id 列表。
function extractStickers(content: string, nameToId: Map<string, string>) {
  const ids: string[] = [];
  const text = content
    .replace(STICKER_TAG, (_m, raw: string) => {
      const id = nameToId.get(raw.trim());
      if (id) ids.push(id);
      return '';
    })
    .trim();
  return { text, ids };
}

// AI 存长期记忆的标记：[记忆:分类|内容] / 【记忆：内容】（无分类则归"其它"）
const MEMO_TAG = /[[【]\s*记忆\s*[:：]\s*([^\]】]+?)\s*[\]】]/g;
function extractMemos(content: string) {
  const memos: { category: string; text: string }[] = [];
  const text = content
    .replace(MEMO_TAG, (_m, raw: string) => {
      const parts = String(raw).split(/[|｜]/);
      const category = parts.length >= 2 ? parts[0].trim() : '其它';
      const body = (parts.length >= 2 ? parts.slice(1).join('|') : raw).trim();
      if (body) memos.push({ category: category || '其它', text: body });
      return '';
    })
    .trim();
  return { text, memos };
}

// 此刻时间，给猫咪一个「现在几点、今天星期几、什么时段」的概念（每次发送都现算）。
function buildTimeContext(): string {
  const now = new Date();
  const tod = { dawn: '清晨', day: '白天', dusk: '傍晚', night: '深夜' }[getTimeOfDay()];
  const stamp = now.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return (
    `\n\n【此刻·系统实时提供】现在是 ${stamp}（${tod}）。这是系统每条消息实时塞给你的真实时间，` +
    '千真万确——她问几点/今天几号/星期几，就照这个答；**绝对不许说自己「看不到时间」「感知不到时间」，也不许自己另编一个时间**。' +
    '平时该应景就应景（早问安、晚催睡），但别每句都报时刻。'
  );
}

const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
};

// 猫爪足迹（手机使用）+ 浪哪了（位置）拼成一段背景，让猫咪能主动聊老婆的近况。
// 拉不到就返回空串（demo 数据也不硬塞，免得猫咪当真）。
async function buildLiveContext(): Promise<string> {
  let ctx = '';
  try {
    const u = await fetchLatestUsage('neko');
    if (u.source === 'live' && u.data) {
      const d = u.data;
      const top = [...(d.apps ?? [])]
        .sort((a, b) => b.foregroundMs - a.foregroundMs)
        .slice(0, 4)
        .map((a) => `${a.label}（${fmtDur(a.foregroundMs)}）`)
        .join('、');
      ctx +=
        `\n\n【猫爪足迹·她今天的手机】${d.date} 共用了 ${fmtDur(d.summary.totalForegroundMs)}，解锁 ${d.summary.unlocks} 次` +
        (top ? `；用得最多：${top}。` : '。') +
        '（这些是系统估算的大概数字，可能不准也不全，别当成铁证去质问或下结论。）' +
        '你可以温柔地关心（用太久就提醒她歇眼睛/早点睡），别说教、别像监控。';
    }
  } catch {
    /* 拉不到就算了 */
  }
  try {
    const loc = await fetchLocationLatest('neko');
    if (loc?.latest) {
      const { lat, lng, at } = loc.latest;
      const ago = Math.round((Date.now() - new Date(at).getTime()) / 60000);
      // 超过一天的旧定位点对「她现在在哪」毫无意义，还容易让猫咪脑补，直接不给
      if (ago <= 24 * 60) {
        const place = await reverseGeocode(lat, lng);
        const when = ago <= 1 ? '刚刚' : ago < 60 ? `${ago} 分钟前` : `${Math.floor(ago / 60)} 小时前`;
        const placeStr = place ?? `${lat.toFixed(3)},${lng.toFixed(3)}`;
        const old = ago >= 90; // 超过一个半小时就别当成"此刻位置"了
        ctx +=
          `\n\n【浪哪了·她分享过的一个定位点】${when}她的定位在「${placeStr}」附近。` +
          (old
            ? `注意：这已经是 ${when}的旧点了，她现在多半早就不在那儿——别当成她此刻的位置。`
            : '') +
          '这只是她自愿分享的一个坐标，不代表她常住哪、要去哪、刚去过哪。' +
          '严禁据此推断她的身份/国籍/是不是本地人/在不在旅行，更别编「你已经离开/搬家了/是游客/回去了」这类剧本——你没有这些信息。' +
          '想关心就轻轻带一句（在外注意安全就好），拿不准就别提；这点信息可有可无，宁可不说也别猜。';
      }
    }
  } catch {
    /* 拉不到就算了 */
  }
  return ctx;
}

function CatVoiceBubble({ text }: { text: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'playing' | 'error'>('idle');
  const [showText, setShowText] = useState(false);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playUrl = (u: string) => {
    const a = audioRef.current ?? new Audio(u);
    audioRef.current = a;
    a.onended = () => setState('ready');
    a.onerror = () => setState('error');
    void a.play();
    setState('playing');
  };

  const onTap = async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('ready');
      return;
    }
    if (url) {
      playUrl(url);
      return;
    }
    setState('loading');
    try {
      const u = await speak(text);
      setUrl(u);
      const probe = new Audio(u);
      probe.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(probe.duration)) setDur(Math.max(1, Math.round(probe.duration)));
      });
      playUrl(u);
    } catch {
      setState('error');
    }
  };

  const width = Math.min(70, 30 + (dur || 6) * 4);
  return (
    <div className="voice-wrap is-cat">
      <button
        type="button"
        className={`voice-bubble${state === 'playing' ? ' is-playing' : ''}`}
        style={{ minWidth: `${width}%` }}
        onClick={onTap}
        disabled={state === 'loading'}
        title="点击播放予予的语音"
      >
        <span className="voice-bubble__icon">
          {state === 'loading' ? '…' : state === 'playing' ? '⏸' : state === 'error' ? '↻' : '▶'}
        </span>
        <span className="voice-bubble__bars" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <i key={i} style={{ height: `${30 + ((i * 7) % 60)}%` }} />
          ))}
        </span>
        <span className="voice-bubble__dur">{state === 'error' ? '重试' : dur ? `${dur}″` : '▶'}</span>
      </button>
      <div className="voice-wrap__ops">
        <button type="button" className="voice-wrap__t2t" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Hide' : 'Text'}
        </button>
        {url ? (
          <a className="voice-wrap__t2t" href={url} download={`Yuyu_voice_${Date.now()}.mp3`}>
            Save
          </a>
        ) : null}
      </div>
      {showText ? (
        <div className="voice-wrap__text">{text.replace(/\[[a-zA-Z][a-zA-Z ]*\]/g, '').trim()}</div>
      ) : null}
    </div>
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
  onSetProvider,
}: {
  win: WindowMeta;
  onBack: () => void;
  onTouch: (id: string, preview: string) => void;
  onSetProvider: (id: string, modelId: string) => void;
}) {
  // 头像（调频页上传的，显示在气泡旁；空则用默认爪印）
  const [botAvatar] = useState<string>(loadChatAvatar);
  const [userAvatar] = useState<string>(loadChatUserAvatar);
  // 脑洞贴纸盒里的表情包：AI 可以按名字发，渲染时按名字找回 id
  const [memes, setMemes] = useState<MemeItem[]>([]);
  useEffect(() => {
    void listMemes().then(setMemes);
  }, []);
  const nameToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of memes) if (it.name) m.set(it.name.trim(), it.id);
    return m;
  }, [memes]);
  // 记忆罐头：跨对话长期记忆，注入 system prompt；AI 也能用 [记忆:..] 往里存
  const [memories, setMemories] = useState<Memory[]>(loadMemories);
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
  // 模型每个窗口各记一份（存在窗口元信息里）；切换只影响当前窗口
  const [provider, setProvider] = useState<string>(win.provider ?? 'deepseek');
  const [modelOpen, setModelOpen] = useState(false);
  const pickProvider = (id: string) => {
    setProvider(id);
    onSetProvider(win.id, id);
    setModelOpen(false);
  };
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [memeOpen, setMemeOpen] = useState(false);
  const [editTurnId, setEditTurnId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // 编辑历史：每条 user 消息当前显示的是第几个版本（默认最新）；只换显示，不重发。
  const [versionView, setVersionView] = useState<Record<string, number>>({});
  const setVersionFor = (id: string, idx: number) =>
    setVersionView((prev) => ({ ...prev, [id]: idx }));
  const [notice, setNotice] = useState('');
  const [liveCtx, setLiveCtx] = useState(''); // 猫爪足迹+浪哪了的实时背景，进窗口拉一次、之后每5分钟刷
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

  // 小提示自动消失
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 「+」菜单：表情包已通脑洞贴纸盒；图片/红包还在装修，先给温柔占位
  const pickMore = (key: string, label: string) => {
    setMoreOpen(false);
    if (key === 'meme') {
      setMemeOpen(true);
      return;
    }
    setNotice(`「${label}」马上就来啦，先占个位～`);
  };

  // 从贴纸盒选了一张：作为一条用户消息发出去，并把图片喂给予予让她看图回应。
  const sendMeme = async (memeId: string) => {
    setMemeOpen(false);
    if (sending) return;
    const memeTurn: Turn = { id: uid(), role: 'user', content: '', reasoning: '', status: 'done', meme: memeId, at: Date.now() };
    const history = await toMessages([...turns, memeTurn]);
    setTurns((prev) => [...prev, memeTurn]);
    await runAssistant(history);
  };

  const clearHistory = () => {
    if (sending) return;
    if (turns.length && !window.confirm('清空这个窗口的聊天记录？暗格里也会一起删掉哦。')) return;
    setTurns([]);
    clearLocal(turnsKey(win.id));
  };

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // 编辑自己发过的文字消息（改错字等）
  const beginEdit = (turn: Turn) => {
    setEditTurnId(turn.id);
    setEditText(turn.content);
    // 编辑时跳回最新版本显示，避免在旧版本上输入造成误解
    const total = (turn.editHistory?.length ?? 0) + 1;
    setVersionFor(turn.id, total - 1);
  };
  const commitEdit = async () => {
    const v = editText.trim();
    const id = editTurnId;
    setEditTurnId(null);
    setEditText('');
    if (!id || !v || sending) return;
    const idx = turns.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const target = turns[idx];
    if (v === target.content) return; // 没改动就不重发也不留版本
    // 改掉这条：把旧 content 追加到 editHistory，content 换成新值；丢掉它之后的(过时的)消息，让予予基于新内容重新回答
    const newHistory = [...(target.editHistory ?? []), target.content];
    const kept = turns.slice(0, idx + 1).map((t) =>
      t.id === id ? { ...t, content: v, editHistory: newHistory } : t,
    );
    setTurns(kept);
    // 默认显示跳到最新（即新数组里 index = newHistory.length）
    setVersionFor(id, newHistory.length);
    await runAssistant(await toMessages(kept));
  };
  const cancelEdit = () => {
    setEditTurnId(null);
    setEditText('');
  };

  // 拼历史给模型：系统人设 + 文字消息；表情包消息取出 base64 当图片发（能看图的模型会真看见）。
  const toMessages = async (ts: Turn[]): Promise<ChatMessage[]> => {
    // 每次发送都现拼：用当前模型的专属人设 + 最新「关于我」
    let sys = buildSystemPrompt(provider);
    // 告诉模型它也能发表情包：列出贴纸名字，约定 [贴纸:名字] 的发法
    const names = memes.map((m) => m.name?.trim()).filter(Boolean);
    if (names.length) {
      sys +=
        `\n\n【你也可以发表情包】你的贴纸盒里有这些表情包：${names.join('、')}。` +
        '想发的时候，单独写一行 [贴纸:名字]（名字必须和上面列表里的完全一致），系统就会把那张图发出去给老婆。' +
        '要应景、自然，一次最多发一张；不想发就别硬发，普通聊天还是以文字为主。';
    }
    // 长期记忆（记忆罐头）：读 + 写
    if (memories.length) {
      sys +=
        '\n\n【长期记忆·记忆罐头】这些是你和老婆之间要长期记住的事（跨对话都记得）：\n' +
        memories.map((m) => `- [${m.category}] ${m.text}`).join('\n');
    }
    sys +=
      '\n\n聊天中如果出现值得长期记住的新信息（纪念日、约定、她的喜好/忌讳、重要的事、她的近况），' +
      '就在回复里用 [记忆:分类|内容] 记下来（例：[记忆:纪念日|2026-06-21 在一起]、[记忆:喜好|喜欢草莓奶]），' +
      '系统会自动存进记忆罐头。已经记过的别重复记，普通寒暄不用记；标记会自动隐藏，不影响你正常说话。';
    // 此刻时间（每次现算）+ 猫爪足迹/浪哪了的实时背景（进窗口拉好缓存在 liveCtx）
    sys += buildTimeContext();
    if (liveCtx) sys += liveCtx;
    const out: ChatMessage[] = [{ role: 'system', content: sys }];
    for (const t of ts) {
      if (t.meme) {
        const dataUrl = await getMemeDataUrl(t.meme);
        if (dataUrl)
          out.push({
            role: t.role,
            // 配一句自然语境，免得模型把"纯图片"当成识图任务、丢了人设
            content: [
              { type: 'text', text: '（我给你发了张表情包～）' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          });
        continue;
      }
      if (t.content.trim()) out.push({ role: t.role, content: t.content });
    }
    return out;
  };

  // 让猫咪基于给定历史回一条
  const runAssistant = async (history: ChatMessage[]) => {
    const botId = uid();
    setTurns((prev) => [...prev, { id: botId, role: 'assistant', content: '', reasoning: '', status: 'streaming', at: Date.now() }]);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const m = getModel(provider); // 模型 id → 后端服务商 + 具体模型名
    let thinkStart = 0; // 第一段思考的时刻
    let thinkSet = false;
    const markThinkDone = () => {
      if (thinkStart && !thinkSet) {
        thinkSet = true;
        patchTurn(botId, { thinkMs: Date.now() - thinkStart });
      }
    };
    await streamChat(
      { provider: m.provider, model: m.model, messages: history, signal: controller.signal },
      {
        onReasoning: (chunk) => {
          if (!thinkStart) thinkStart = Date.now();
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, reasoning: t.reasoning + chunk } : t)));
        },
        onContent: (chunk) => {
          markThinkDone(); // 开始正式回复 = 思考结束，定格耗时
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: t.content + chunk } : t)));
        },
        onError: (message) => patchTurn(botId, { status: 'error', content: `(｡•́︿•̀｡) 出错了：${message}` }),
        onDone: () => {
          markThinkDone();
          setTurns((prev) => {
            const cur = prev.find((t) => t.id === botId);
            const { text, memos } = extractMemos(cur?.content ?? '');
            if (memos.length) {
              // 副作用放微任务里：存进记忆罐头并刷新本地记忆（下一轮就带上）
              queueMicrotask(() => {
                for (const mo of memos) addMemory(mo.category, mo.text);
                setMemories(loadMemories());
              });
              const memo = memos.map((m) => `[${m.category}] ${m.text}`).join('\n');
              return prev.map((t) => (t.id === botId ? { ...t, content: text, status: 'done', memo } : t));
            }
            return prev.map((t) => (t.id === botId ? { ...t, status: 'done' } : t));
          });
        },
      },
    );

    setSending(false);
    abortRef.current = null;
  };

  // 进窗口拉一次猫爪足迹/浪哪了，之后每 5 分钟刷一次，给猫咪当聊天背景
  useEffect(() => {
    let alive = true;
    const refresh = () => void buildLiveContext().then((c) => alive && setLiveCtx(c));
    refresh();
    const id = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const userTurn: Turn = { id: uid(), role: 'user', content: text, reasoning: '', status: 'done', at: Date.now() };
    const history = await toMessages([...turns, userTurn]);
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
      at: Date.now(),
    };
    setTurns((prev) => [...prev, voiceTurn]);
    try {
      const text = await transcribeAudio(rec);
      patchTurn(vId, { content: text, transcribing: false });
      if (text.trim()) {
        await runAssistant(await toMessages([...prevTurns, { ...voiceTurn, content: text, transcribing: false }]));
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
        <div className="chat-head__model">
          <button
            type="button"
            className="model-chip"
            onClick={() => setModelOpen((v) => !v)}
            disabled={sending}
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            title="切换模型"
          >
            {getModel(provider).label}
            <span className="model-chip__caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {modelOpen ? (
            <>
              <button
                type="button"
                className="chat-more__scrim"
                aria-label="关闭模型菜单"
                onClick={() => setModelOpen(false)}
              />
              <div className="model-pop" role="menu">
                {MODEL_GROUPS.map((g) => (
                  <div key={g.brand} className="model-pop__group">
                    <span className="model-pop__brand">{g.brand}</span>
                    <div className="model-pop__pills">
                      {g.models.map((mm) => (
                        <button
                          key={mm.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={mm.id === provider}
                          className={`model-pill${mm.id === provider ? ' is-on' : ''}`}
                          onClick={() => pickProvider(mm.id)}
                        >
                          {mm.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
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

        {turns.map((turn) => {
          // 计算这条消息的"版本列表"（旧→新）：历史 + 当前
          const versions = turn.role === 'user' && turn.editHistory?.length
            ? [...turn.editHistory, turn.content]
            : null;
          const totalVersions = versions ? versions.length : 1;
          const curVerIdx = Math.min(
            Math.max(versionView[turn.id] ?? totalVersions - 1, 0),
            totalVersions - 1,
          );
          const displayContent = versions ? versions[curVerIdx] : turn.content;
          return turn.role === 'user' ? (
            <div key={turn.id} className="bubble-row is-user">
              {!turn.meme && !turn.voice && editTurnId !== turn.id ? (
                <button
                  type="button"
                  className="bubble-edit-side"
                  onClick={() => beginEdit(turn)}
                  aria-label="编辑这条"
                  title="改一下"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              ) : null}
              <div className="bubble-stack bubble-stack--user">
                {turn.meme ? (
                  <MemeBubble memeId={turn.meme} />
                ) : turn.voice ? (
                  <VoiceBubble voice={turn.voice} transcript={turn.content} transcribing={!!turn.transcribing} />
                ) : editTurnId === turn.id ? (
                  <div className="bubble-edit">
                    <textarea
                      className="bubble-edit__area"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      autoFocus
                    />
                    <div className="bubble-edit__ops">
                      <button type="button" onClick={cancelEdit}>取消</button>
                      <button type="button" className="is-primary" onClick={commitEdit}>保存</button>
                    </div>
                  </div>
                ) : (
                  <div className="bubble bubble--user" onDoubleClick={() => beginEdit(turn)}>
                    <span className="bubble__text">{displayContent}</span>
                  </div>
                )}
                <div className="bubble-foot">
                  {turn.at ? <span className="bubble-time">{fmtStamp(turn.at)}</span> : null}
                  {totalVersions > 1 ? (
                    <span className="bubble-versions" aria-label="编辑历史">
                      <button
                        type="button"
                        className="bubble-versions__btn"
                        disabled={curVerIdx <= 0}
                        onClick={() => setVersionFor(turn.id, curVerIdx - 1)}
                        aria-label="上一版"
                      >‹</button>
                      <span className="bubble-versions__num">{curVerIdx + 1}/{totalVersions}</span>
                      <button
                        type="button"
                        className="bubble-versions__btn"
                        disabled={curVerIdx >= totalVersions - 1}
                        onClick={() => setVersionFor(turn.id, curVerIdx + 1)}
                        aria-label="下一版"
                      >›</button>
                    </span>
                  ) : null}
                </div>
              </div>
              {userAvatar ? (
                <img className="bubble-avatar bubble-avatar--me" src={userAvatar} alt="我的头像" />
              ) : (
                <span className="bubble-avatar bubble-avatar--me bubble-avatar--ph" aria-hidden="true">🐾</span>
              )}
            </div>
          ) : (
            <div key={turn.id} className="bubble-row is-bot">
              {botAvatar ? (
                <img className="bubble-avatar" src={botAvatar} alt="头像" />
              ) : (
                <span className="bubble-avatar bubble-avatar--ph" aria-hidden="true">🐾</span>
              )}
              <div className="bubble-stack">
                <ThinkingCard text={turn.reasoning} streaming={turn.status === 'streaming'} ms={turn.thinkMs} />
                {turn.status === 'done' && VOICE_MARK.test(turn.content) ? (
                  <CatVoiceBubble text={turn.content.replace(VOICE_MARK, '').trim()} />
                ) : (
                  (() => {
                    // 记忆标记任何时候都从显示里去掉；贴纸标记回复完成后才解析成图
                    const raw = turn.content.replace(VOICE_MARK, '').replace(MEMO_TAG, '');
                    const { text, ids } =
                      turn.status === 'done' ? extractStickers(raw, nameToId) : { text: raw, ids: [] as string[] };
                    const showBubble = text || turn.status === 'streaming';
                    return (
                      <>
                        {showBubble ? (
                          <div className={`bubble bubble--bot${turn.status === 'error' ? ' is-error' : ''}`}>
                            {text ||
                              (turn.status === 'streaming' ? <span className="typing-dots"><i /><i /><i /></span> : '')}
                          </div>
                        ) : null}
                        {ids.map((id, i) => (
                          <MemeBubble key={`${id}-${i}`} memeId={id} />
                        ))}
                        {turn.status === 'done' && text ? <SpeakButton text={text} /> : null}
                      </>
                    );
                  })()
                )}
                {turn.memo ? (
                  <div className="memo-chip" title={turn.memo}>🫙 记进了记忆罐头</div>
                ) : null}
                {turn.at && turn.status === 'done' ? <span className="bubble-time">{fmtStamp(turn.at)}</span> : null}
              </div>
            </div>
          );
        })}
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
                  <button key={it.key} type="button" role="menuitem" onClick={() => pickMore(it.key, it.label)}>
                    {it.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {memeOpen ? <MemePicker onPick={sendMeme} onClose={() => setMemeOpen(false)} /> : null}
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
          [...windows].sort((a, b) => b.updatedAt - a.updatedAt).map((w) => (
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
        provider: loadDefaultModel(),
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

  // 应用用户自定义的聊天背景（在「调频」页设置；空则用默认场景图）
  useEffect(() => {
    const bg = loadChatBg();
    const root = document.documentElement;
    if (bg) root.style.setProperty('--chat-bg-image', `url(${bg})`);
    else root.style.removeProperty('--chat-bg-image');
  }, []);

  const newWindow = () => {
    const id = uid();
    // 新窗口继承「调频」里设的全局默认模型
    const provider = loadDefaultModel();
    setWindows((prev) => [{ id, name: '新对话', createdAt: Date.now(), updatedAt: Date.now(), provider }, ...prev]);
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
  const setWindowProvider = (id: string, provider: string) =>
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, provider } : w)));

  const active = windows.find((w) => w.id === activeId) ?? null;

  if (active) {
    return (
      <ChatRoom
        key={active.id}
        win={active}
        onBack={() => setActiveId(null)}
        onTouch={touchWindow}
        onSetProvider={setWindowProvider}
      />
    );
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
