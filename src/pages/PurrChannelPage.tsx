import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { streamChat, type ChatMessage } from '../services/chat';
import { getModel, MODEL_GROUPS } from '../data/models';
import { buildSystemPrompt, loadDefaultModel, loadChatBg, loadChatAvatar, loadChatUserAvatar } from '../services/purrConfig';
import { addMemory, loadMemories, type Memory } from '../services/memory';
import { loadRollingSummary, saveRollingSummary, type RollingSummary } from '../services/rollingSummary';
import { clearLocal, loadLocal, saveLocal } from '../services/storage';
import { speak, transcribeAudio, VoiceRecorder, type Recording } from '../services/voice';
import { getMemeURL, getMemeDataUrl, listMemes, type MemeItem } from '../services/memes';
import { addPhoto, getPhotoURL, getPhotoDataUrl } from '../services/photos';
import { addPacket } from '../services/redPacket';
import { playHongbaoChime } from '../services/hongbaoSound';
import { fetchLatestUsage } from '../services/usageBridge';
import { fetchLocationLatest, reverseGeocode } from '../services/locationBridge';
import { getTimeOfDay } from '../components/ambient/timeOfDay';
import {
  controlSpotifyPlayback,
  getSpotifyPlayback,
  playSpotifyQueries,
  type SpotifyPlayback,
  type SpotifyTrack,
} from '../services/spotify';

const WINDOWS_KEY = 'purr-channel:windows';
const LEGACY_TURNS_KEY = 'purr-channel:turns'; // 旧版单一对话，首次进入迁移成一个窗口
const turnsKey = (id: string) => `purr-channel:turns:${id}`;
const CLOUD_KEY_STORAGE = 'codeandpurrs:purr-channel:cloud-key';
const SCREEN_WATCH_KEY = 'purr-channel:screen-watch-enabled';

type CloudSave = {
  version: number;
  window: WindowMeta;
  turns: Turn[];
  rollingSummary?: RollingSummary | null;
  savedAt: number;
};

function getCloudKey(): string | null {
  let key = '';
  try {
    key = localStorage.getItem(CLOUD_KEY_STORAGE)?.trim() ?? '';
  } catch {
    // 隐私模式读不到就让老婆本次输入，不让页面崩掉
  }
  if (!key) key = window.prompt('输入呼噜频道私密密码（存档 / 看屏幕）')?.trim() ?? '';
  if (!key) return null;
  try {
    localStorage.setItem(CLOUD_KEY_STORAGE, key);
  } catch {
    // 存不下也没关系，本次请求仍然能用
  }
  return key;
}

type ScreenFrame = {
  deviceId: string;
  capturedAt: number;
  receivedAt: number;
  dataUrl: string;
};

type ScreenFrameQuery = {
  after?: number;
  before?: number;
};

async function fetchLatestScreenFrame(query: ScreenFrameQuery = {}): Promise<ScreenFrame | null> {
  const key = getCloudKey();
  if (!key) throw new Error('没有输入私密密码');
  const params = new URLSearchParams();
  if (Number.isFinite(query.after)) params.set('after', String(Math.round(query.after!)));
  if (Number.isFinite(query.before)) params.set('before', String(Math.round(query.before!)));
  const response = await fetch(`/api/screen/latest${params.size ? `?${params}` : ''}`, {
    headers: { 'X-Chat-Save-Key': key },
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (response.status === 401) {
    try {
      localStorage.removeItem(CLOUD_KEY_STORAGE);
    } catch {
      // 忽略
    }
    throw new Error('私密密码不正确');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || `屏幕服务返回 ${response.status}`));
  }
  return response.json();
}

function appendScreenFrame(history: ChatMessage[], frame: ScreenFrame): ChatMessage[] {
  const next = history.map((message) => ({ ...message }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== 'user') continue;
    const existing = next[i].content;
    const parts = typeof existing === 'string'
      ? [{ type: 'text' as const, text: existing || '（请看我刚刚共享的手机屏幕）' }]
      : [...existing];
    parts.push({ type: 'text', text: '\n【这是老婆刚授权共享的手机屏幕最新画面。只根据画面中真实可见的内容回答，不要猜屏幕外的信息。】' });
    parts.push({ type: 'image_url', image_url: { url: frame.dataUrl } });
    next[i] = { ...next[i], content: parts };
    break;
  }
  return next;
}

async function cloudRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const key = getCloudKey();
  if (!key) throw new Error('没有输入存档密码');
  const headers = new Headers(init.headers);
  headers.set('X-Chat-Save-Key', key);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    try {
      localStorage.removeItem(CLOUD_KEY_STORAGE);
    } catch {
      // 忽略
    }
    throw new Error('存档密码不正确');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || `存档服务返回 ${response.status}`));
  }
  return response;
}

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
  photo?: string; // 随手发的照片才有：photos IndexedDB 里的 id，渲染时按需取 blob
  redPacket?: { amount: number; note: string; from: 'user' | 'ai' }; // 红包消息才有：落予棠账本已经记过这一笔了
  redPacketOpened?: boolean; // 不管自己发的还是收到的都要点开才展开(才有拆红包动效)，默认 false
  memo?: string; // 这条 AI 回复顺手存进记忆罐头的内容（显示"记住了"小条）
  errorDetail?: string; // status 为 error 时的原始报错文本；渲染成系统提示条，点"详情"才展开看这个
  at?: number; // 消息创建时间戳
  thinkMs?: number; // 思考链耗时（从第一段思考到开始正式回复），用来显示「想了 N 秒」
  editHistory?: string[]; // 这条消息编辑过的历史版本（按时间顺序，旧→较新），当前展示的是 content
  spotify?: { deviceName: string; tracks: SpotifyTrack[]; startedAt: number }; // AI 点歌成功后嵌在回复里的播放器卡
};

const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtStamp = (at?: number): string => {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const SPOTIFY_PLAYLIST_MARK = '[[SPOTIFY_PLAYLIST:';
const SPOTIFY_PLAYLIST_TAG = /\[\[SPOTIFY_PLAYLIST:(\{[\s\S]*?\})\]\]/g;

// 流式回复期间就隐藏控制标记（包括刚流到一半的标记），老婆只会看到自然回复。
function stripSpotifyPlaylistTags(content: string): string {
  let text = content.replace(SPOTIFY_PLAYLIST_TAG, '');
  const open = text.lastIndexOf(SPOTIFY_PLAYLIST_MARK);
  if (open >= 0 && text.indexOf(']]', open) < 0) text = text.slice(0, open);
  const partial = text.lastIndexOf('[[');
  if (partial >= 0 && SPOTIFY_PLAYLIST_MARK.startsWith(text.slice(partial))) text = text.slice(0, partial);
  return text;
}

function extractSpotifyPlaylistQueries(content: string): string[] {
  const queries: string[] = [];
  for (const match of content.matchAll(/\[\[SPOTIFY_PLAYLIST:(\{[\s\S]*?\})\]\]/g)) {
    try {
      const payload = JSON.parse(match[1]) as { queries?: unknown };
      if (!Array.isArray(payload.queries)) continue;
      for (const item of payload.queries) {
        const query = String(item || '').trim().slice(0, 200);
        if (query.length >= 2 && !queries.includes(query)) queries.push(query);
        if (queries.length >= 15) return queries;
      }
    } catch {
      // 模型偶尔写坏控制 JSON 时只忽略点歌，不影响聊天正文。
    }
  }
  return queries;
}

function SpotifyMusicCard({
  attachment,
  onError,
}: {
  attachment: NonNullable<Turn['spotify']>;
  onError: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ playback: SpotifyPlayback; checkedAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const fallback = attachment.tracks[0];

  const refresh = async () => {
    try {
      const playback = await getSpotifyPlayback();
      setSnapshot({ playback, checkedAt: Date.now() });
    } catch {
      // 卡片仍可用点歌时返回的资料显示；短暂网络错误不把整张卡变成报错。
    }
  };

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5_000);
    const tick = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
    // 每张历史卡只在挂载时建立自己的状态轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = snapshot?.playback;
  const liveUri = live?.track?.uri;
  const liveBelongsToCard = Boolean(
    liveUri && attachment.tracks.some((item) => item.uri === liveUri),
  );
  const track = liveBelongsToCard ? live?.track || fallback : fallback;
  const isPlaying = snapshot ? liveBelongsToCard && Boolean(live?.active && live.isPlaying) : true;
  const baseProgress = liveBelongsToCard ? Number(live?.progressMs || 0) : Math.max(0, snapshot ? 0 : clock - attachment.startedAt);
  const movingProgress = isPlaying && snapshot ? baseProgress + Math.max(0, clock - snapshot.checkedAt) : baseProgress;
  const duration = Math.max(1, track?.durationMs || 1);
  const progress = Math.min(duration, Math.max(0, movingProgress));
  const queued = attachment.tracks.length > 1 ? `队列 ${attachment.tracks.length} 首` : attachment.deviceName;

  const control = async (action: 'pause' | 'resume' | 'next') => {
    if (busy) return;
    setBusy(true);
    try {
      await controlSpotifyPlayback(action);
      await new Promise<void>((resolve) => window.setTimeout(resolve, action === 'next' ? 500 : 180));
      await refresh();
    } catch (err) {
      onError(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="spotify-chat-card" aria-label="Spotify 正在播放">
      {track?.image ? (
        <img className="spotify-chat-card__cover" src={track.image} alt="" />
      ) : (
        <span className="spotify-chat-card__cover spotify-chat-card__cover--empty" aria-hidden="true">♪</span>
      )}
      <div className="spotify-chat-card__body">
        <div className="spotify-chat-card__eyebrow">
          <span>Listening Together</span>
          <span>{queued}</span>
        </div>
        <strong className="spotify-chat-card__title">{track?.name || 'Spotify'}</strong>
        <span className="spotify-chat-card__artist">{track?.artist || '正在准备播放'}</span>
        <div className="spotify-chat-card__timeline" aria-label={`已播放 ${fmt(Math.floor(progress / 1000))}`}>
          <span style={{ width: `${(progress / duration) * 100}%` }} />
        </div>
        <div className="spotify-chat-card__time">
          <span>{fmt(Math.floor(progress / 1000))}</span>
          <span>{fmt(Math.floor(duration / 1000))}</span>
        </div>
      </div>
      <div className="spotify-chat-card__controls">
        <button
          type="button"
          disabled={busy || Boolean(snapshot && !liveBelongsToCard)}
          onClick={() => void control(isPlaying ? 'pause' : 'resume')}
          aria-label={isPlaying ? '暂停' : '继续播放'}
        >
          {busy ? '…' : isPlaying ? 'Ⅱ' : '▶'}
        </button>
        {attachment.tracks.length > 1 ? (
          <button type="button" disabled={busy || Boolean(snapshot && !liveBelongsToCard)} onClick={() => void control('next')} aria-label="下一首">›|</button>
        ) : null}
      </div>
    </section>
  );
}

// 思考链折叠卡片：流式思考时自动展开，思考结束自动收起。
function ThinkingCard({ text, streaming, ms }: { text: string; streaming: boolean; ms?: number }) {
  const [open, setOpen] = useState(streaming);
  const [hasNewReasoning, setHasNewReasoning] = useState(false);
  const wasStreaming = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wasStreaming.current && streaming) {
      setHasNewReasoning(false);
      setOpen(true);
    } else if (wasStreaming.current && !streaming) {
      setHasNewReasoning(false);
      setOpen(false);
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  // 思考变长后只测量有没有新内容落在可视区外，不再替用户滚动。
  // 「看最新思考」只跳一次；下一批 token 到来仍保持静止。
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !streaming || !open) return;
    const frame = requestAnimationFrame(() => {
      const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
      setHasNewReasoning(distance > 18);
    });
    return () => cancelAnimationFrame(frame);
  }, [text, streaming, open]);

  const onReasoningScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    setHasNewReasoning(body.scrollHeight - body.scrollTop - body.clientHeight > 18);
  };

  const showLatestReasoning = () => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: 'auto' });
    setHasNewReasoning(false);
  };

  if (!text) return null;

  const label = streaming ? '正在想…' : ms ? `想了 ${Math.max(1, Math.round(ms / 1000))} 秒` : '想了想';

  return (
    <div className={`think-card${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="think-card__toggle"
        aria-expanded={open}
        onClick={() => {
          setHasNewReasoning(false);
          setOpen((v) => !v);
        }}
      >
        <span className="think-card__brand">Mind Theater</span>
        <span className="think-card__label">{label}</span>
        <span className="think-card__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div
          ref={bodyRef}
          className={`think-card__body${streaming ? ' is-streaming' : ''}`}
          onScroll={onReasoningScroll}
        >
          {text}
        </div>
      ) : null}
      {open && streaming && hasNewReasoning ? (
        <button type="button" className="think-card__latest" onClick={showLatestReasoning}>
          ↓ 看最新思考
        </button>
      ) : null}
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

// 聊天里发的照片气泡：跟表情包同一套加载/失效逻辑，只是取的是 photos 库
function PhotoBubble({ photoId }: { photoId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    void getPhotoURL(photoId).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      alive = false;
    };
  }, [photoId]);

  if (gone) return <div className="meme-msg meme-msg--gone">这张照片没找到～</div>;
  if (!url) return <div className="meme-msg meme-msg--loading" />;
  return <img className="meme-msg" src={url} alt="照片" />;
}

// 红包配色主题：图片路径 + 粒子颜色都做成参数，以后接紫色款只要在这加一条配置
// （两张图路径 + 粒子色）就行，不用碰 RedPacketBubble 组件本身。
type HongbaoTheme = { closed: string; open: string; heartColors: string[] };
const HONGBAO_THEMES: Record<string, HongbaoTheme> = {
  pink: {
    closed: `${import.meta.env.BASE_URL}assets/icons/hongbao_pink_closed.png`,
    open: `${import.meta.env.BASE_URL}assets/icons/hongbao_pink_open.png`,
    heartColors: ['#FFB6D9', '#FF9EC7', '#FFC9E3'],
  },
  purple: {
    closed: `${import.meta.env.BASE_URL}assets/icons/hongbao_purple_closed.png`,
    open: `${import.meta.env.BASE_URL}assets/icons/hongbao_purple_open.png`,
    // 上一版 #C4A5E7 那批饱和度只有 ~58%（粉色那批是 ~100%），淡是淡但显灰。
    // 换成同样"高饱和 + 高明度"的淡紫，饱和度拉到跟粉色一个量级，别再靠调低饱和度做"淡"。
    heartColors: ['#D896F0', '#C67AEA', '#E3B3F5'],
  },
};
const DEFAULT_HONGBAO_THEME = 'pink';

type HeartParticle = { id: number; dx: number; dy: number; rot: number; delay: number; duration: number; color: string };

// 拆红包那一下冒出来的爱心粒子：3颗，位置/角度/时长都随机一点，错开出场不齐刷刷。
function makeHeartBurst(colors: string[]): HeartParticle[] {
  const now = Date.now();
  return Array.from({ length: 3 }, (_, i) => ({
    id: now + i,
    dx: Math.round((Math.random() - 0.5) * 40), // 水平 ±20px
    dy: -(60 + Math.round(Math.random() * 40)), // 向上飘 60~100px
    rot: Math.round((Math.random() - 0.5) * 30), // 旋转 ±15deg
    delay: i * (100 + Math.round(Math.random() * 50)), // 错开 100~150ms
    duration: 900 + Math.round(Math.random() * 300), // 900~1200ms
    color: colors[i % colors.length],
  }));
}

// 红包气泡：自己发的直接显示金额；收到的要点一下才拆开看金额和留言(像微信红包)。
// 拆的瞬间：叮一声 + 图标弹跳crossfade + 冒几颗爱心粒子，纯 CSS transform/opacity 动画。
function RedPacketBubble({
  amount,
  note,
  opened,
  onOpen,
  theme = DEFAULT_HONGBAO_THEME,
}: {
  amount: number;
  note: string;
  opened: boolean;
  onOpen: () => void;
  theme?: string;
}) {
  const cfg = HONGBAO_THEMES[theme] ?? HONGBAO_THEMES[DEFAULT_HONGBAO_THEME];
  // justOpened 只在"这一次点击拆开"时为 true，用来触发一次性动效；
  // 已经拆过、刷新页面后直接渲染成 opened=true 的历史红包不会走这条路，不会重放动画。
  const [justOpened, setJustOpened] = useState(false);
  const [hearts, setHearts] = useState<HeartParticle[]>([]);

  // 两个计时器分开挂两个 effect：justOpened 280ms 后自己翻回 false，
  // 这个状态变化不能连带把 hearts 的清理计时器也一起清掉，所以不能共用一个 effect。
  useEffect(() => {
    if (!justOpened) return;
    const t = setTimeout(() => setJustOpened(false), 280);
    return () => clearTimeout(t);
  }, [justOpened]);

  useEffect(() => {
    if (hearts.length === 0) return;
    const t = setTimeout(() => setHearts([]), 1500); // 动效放完就把粒子从 DOM 里清掉，不留垃圾节点
    return () => clearTimeout(t);
  }, [hearts]);

  const handleOpen = () => {
    playHongbaoChime(); // 点击回调里同步调用，满足 iOS Safari 要在用户手势里 resume AudioContext 的要求
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(15); // 支持的设备(主要是安卓)拆红包那一下顺手来点触感反馈；iOS Safari 没这个 API，静默跳过
      } catch {
        // 忽略
      }
    }
    setJustOpened(true);
    setHearts(makeHeartBurst(cfg.heartColors));
    onOpen();
  };

  if (!opened) {
    return (
      <button type="button" className="redpacket redpacket--closed" onClick={handleOpen}>
        <img className="redpacket__icon" src={cfg.closed} alt="" />
        <span className="redpacket__hint">点开看看</span>
      </button>
    );
  }
  return (
    <div className={`redpacket redpacket--opened${justOpened ? ' is-justOpened' : ''}`}>
      <span className={`redpacket__icon-wrap${justOpened ? ' is-opening' : ''}`}>
        {justOpened && <img className="redpacket__icon redpacket__icon--under" src={cfg.closed} alt="" />}
        <img className="redpacket__icon redpacket__icon--open" src={cfg.open} alt="" />
        {hearts.map((h) => (
          <span
            key={h.id}
            className="redpacket__heart"
            style={
              {
                '--dx': `${h.dx}px`,
                '--dy': `${h.dy}px`,
                '--rot': `${h.rot}deg`,
                color: h.color,
                animationDelay: `${h.delay}ms`,
                animationDuration: `${h.duration}ms`,
              } as CSSProperties
            }
          >
            ♥
          </span>
        ))}
      </span>
      <span className="redpacket__body">
        <span className="redpacket__note">{note || '甜甜红包'}</span>
        <span className="redpacket__amount">${amount}</span>
      </span>
      <span className="redpacket__claimed">已领取</span>
    </div>
  );
}

// 系统级报错（后端 401 之类）：不冒充予予说话，居中一条灰色小胶囊，原始报错收进可展开详情。
function SystemErrorNotice({ detail }: { detail?: string }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="system-notice">
      <div className="system-notice__pill">连接出了点问题，请稍后重试</div>
      {detail ? (
        <button
          type="button"
          className="system-notice__toggle"
          onClick={() => setShowDetail((v) => !v)}
        >
          {showDetail ? '收起详情' : '查看详情'}
        </button>
      ) : null}
      {showDetail && detail ? <div className="system-notice__detail">{detail}</div> : null}
    </div>
  );
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

// 「＋ → 红包」弹出的发红包表单：填金额 + 写句话(像微信一样)，发出去存进落予棠。
function RedPacketComposer({
  onSend,
  onClose,
}: {
  onSend: (amount: number, note: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const n = Math.round(Math.abs(Number(amount)) * 100) / 100;
  const valid = amount.trim() !== '' && n > 0;

  return (
    <>
      <button type="button" className="chat-more__scrim" aria-label="关闭红包" onClick={onClose} />
      <div className="redpacket-composer" role="dialog" aria-label="发红包">
        <div className="redpacket-composer__title">
          <img className="redpacket-composer__title-icon" src={HONGBAO_THEMES[DEFAULT_HONGBAO_THEME].closed} alt="" />
          发个红包
        </div>
        <input
          className="redpacket-composer__amount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
        <input
          className="redpacket-composer__note"
          placeholder="写句话，比如「今天很乖值得奖励」"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={40}
        />
        <div className="redpacket-composer__ops">
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="is-primary"
            disabled={!valid}
            onClick={() => valid && onSend(n, note)}
          >
            塞进红包
          </button>
        </div>
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
      <span>{state === 'loading' ? '生成中' : state === 'playing' ? '播放中' : '耳边话'}</span>
    </button>
  );
}

// 予予主动发的「语音条」：检测到 [语音] 标记的消息，点了才合成（像微信语音，省额度、刷新后也能重听）。
const VOICE_MARK = /^\s*[[【]\s*语音\s*[\]】]\s*/;

// AI 发贴纸用的标记：老写法是 [贴纸:名字]，但 system prompt 里同时出现「表情包」
// 一词做标题(【你也可以发表情包】), 予予是 LLM 常常把这两个词混起来,实际写成
// [表情包:名字] / [表情:名字] / [贴图:名字] 之类。正则原来只认「贴纸」二字,
// 其它 alias 都不匹配,tag 原封不动漏到显示层,老婆看到"[表情包:草莓奶]" 这
// 五六个字而不是那张图——这就是"仅凭图名就发"的原因。
// 修法:正则改成多 alias 都匹配(贴纸|表情包|表情|贴图|meme|sticker),命名后仍
// 用 nameToId 查图。匹配到但 name 不在 box 里(予予幻觉出一个不存在的贴纸)
// 也把标记删掉,不再漏字。
const STICKER_TAG = /[[【]\s*(?:贴纸|表情包|表情|贴图|meme|sticker)\s*[:：]\s*([^\]】]+?)\s*[\]】]/gi;
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

// AI 发红包用的标记：[红包:金额|留言]（留言可省）,存进落予棠(予予 → 棠棠这一方)
const RED_PACKET_TAG = /[[【]\s*红包\s*[:：]\s*([^\]】]+?)\s*[\]】]/g;
function extractRedPackets(content: string) {
  const packets: { amount: number; note: string }[] = [];
  const text = content
    .replace(RED_PACKET_TAG, (_m, raw: string) => {
      const parts = String(raw).split(/[|｜]/);
      const amount = Math.round(Math.abs(Number(parts[0])) * 100) / 100;
      const note = (parts.length >= 2 ? parts.slice(1).join('|') : '').trim();
      if (amount > 0) packets.push({ amount, note });
      return '';
    })
    .trim();
  return { text, packets };
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
        .slice(0, 5)
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
// 输入框上方"待发贴纸"缩略图:小方块预览 + 右上角 × 移除
function PendingMemeThumb({ memeId }: { memeId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getMemeURL(memeId).then((u) => { if (alive && u) setUrl(u); });
    return () => { alive = false; };
  }, [memeId]);
  if (!url) return <div className="pending-meme__img pending-meme__img--loading" />;
  return <img className="pending-meme__img" src={url} alt="" aria-hidden="true" />;
}
// 相册照片版:走 getPhotoURL(photos IndexedDB), 视觉跟贴纸缩略图一致
function PendingPhotoThumb({ photoId }: { photoId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getPhotoURL(photoId).then((u) => { if (alive && u) setUrl(u); });
    return () => { alive = false; };
  }, [photoId]);
  if (!url) return <div className="pending-meme__img pending-meme__img--loading" />;
  return <img className="pending-meme__img" src={url} alt="" aria-hidden="true" />;
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
  { key: 'screen', label: '看屏幕' },
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
  // 贴纸盒预览：每张贴纸的名字 + 缩略图(384px JPEG dataUrl),让家版 CC 真"看到"
  // 每个名字对应的图,以后发 [贴纸:名字] 才准确。memes 换了才重新加载(每张贴纸
  // 都要从 IndexedDB 取 blob + canvas 缩放,加载慢的话每次聊天都重跑就卡了),
  // 长驻状态里,聊天时直接拿来发给后端不阻塞。
  const [stickerGallery, setStickerGallery] = useState<{ name: string; dataUrl: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list: { name: string; dataUrl: string }[] = [];
      for (const m of memes) {
        if (!m.name) continue;
        const dataUrl = await getMemeDataUrl(m.id, 384);
        if (cancelled) return;
        if (dataUrl) list.push({ name: m.name.trim(), dataUrl });
      }
      if (!cancelled) setStickerGallery(list);
    })();
    return () => {
      cancelled = true;
    };
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
  // Service Worker 收到真后台推送后，AutoWakeBridge 会把消息落进这个窗口的
  // localStorage，再发同页事件。聊天室只合并新增 id，绝不覆盖正在流式的回复。
  useEffect(() => {
    const receiveAutoWake = () => {
      const stored = loadLocal<Turn[]>(turnsKey(win.id), []);
      setTurns((current) => {
        const ids = new Set(current.map((turn) => turn.id));
        const added = stored.filter((turn) => !ids.has(turn.id));
        return added.length ? [...current, ...added].sort((a, b) => Number(a.at || 0) - Number(b.at || 0)) : current;
      });
    };
    window.addEventListener('codeandpurrs:autowake-delivered', receiveAutoWake);
    return () => window.removeEventListener('codeandpurrs:autowake-delivered', receiveAutoWake);
  }, [win.id]);
  // 滚动摘要：HISTORY_MAX 窗口之外的老消息不再直接丢，异步压成摘要兜底（见下方 compressOldHistory）
  const [rollingSummary, setRollingSummary] = useState<RollingSummary>(() => loadRollingSummary(win.id));
  const summarizingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
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
  // 挑了贴纸/相册照片不立刻发,先钉在输入框上方的"待发"槽,让老婆再打点话一起发过去
  const [pendingMeme, setPendingMeme] = useState<string | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<string[]>([]);
  const [screenWatchEnabled, setScreenWatchEnabled] = useState(() => loadLocal<boolean>(SCREEN_WATCH_KEY, false));
  const [screenCapturedAt, setScreenCapturedAt] = useState<number | null>(null);
  const [screenFrameHeld, setScreenFrameHeld] = useState(false);
  const [redPacketOpen, setRedPacketOpen] = useState(false);
  const [editTurnId, setEditTurnId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // 编辑历史：每条 user 消息当前显示的是第几个版本（默认最新）；只换显示，不重发。
  const [versionView, setVersionView] = useState<Record<string, number>>({});
  const setVersionFor = (id: string, idx: number) =>
    setVersionView((prev) => ({ ...prev, [id]: idx }));
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [liveCtx, setLiveCtx] = useState(''); // 猫爪足迹+浪哪了的实时背景，进窗口拉一次、之后每5分钟刷
  // liveCtx 上次真正拼进 system 前缀的时间戳。之前每条消息都附一遍 usage bridge
  // 数据(~500 tokens)烧掉不少订阅额度——老婆定的规则:同一 3 小时窗口内只附一次,
  // 窗口过了才重新附。也就是:第一条消息附一次,之后 3 小时内的消息不再附;隔了
  // 3 小时以上再聊了才附下一次。
  const lastCtxAttachRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollToReplyRef = useRef(true);
  const [nearLatest, setNearLatest] = useState(true);
  const photoFileRef = useRef<HTMLInputElement | null>(null);
  // 离开 CodeAndPurrs 看其它 App 后，回到网页的第一瞬间锁住上一帧。
  // 之后即使老婆打开输入法慢慢打字，也不会把真正想给 AI 看的画面覆盖掉。
  const heldScreenFrameRef = useRef<ScreenFrame | null>(null);
  const heldScreenFrameExpiresAtRef = useRef(0);
  const screenAwayAtRef = useRef<number | null>(null);
  const screenReturnedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const syncScreenWatch = (event: StorageEvent) => {
      if (event.key === `codeandpurrs:${SCREEN_WATCH_KEY}`) {
        setScreenWatchEnabled(loadLocal<boolean>(SCREEN_WATCH_KEY, false));
      }
    };
    const syncSameTab = () => setScreenWatchEnabled(loadLocal<boolean>(SCREEN_WATCH_KEY, false));
    window.addEventListener('storage', syncScreenWatch);
    window.addEventListener('codeandpurrs:storage', syncSameTab);
    return () => {
      window.removeEventListener('storage', syncScreenWatch);
      window.removeEventListener('codeandpurrs:storage', syncSameTab);
    };
  }, []);

  useEffect(() => {
    if (!screenWatchEnabled) {
      heldScreenFrameRef.current = null;
      heldScreenFrameExpiresAtRef.current = 0;
      screenAwayAtRef.current = null;
      screenReturnedAtRef.current = null;
      setScreenFrameHeld(false);
      return;
    }

    let alive = true;
    const holdLastExternalFrame = async (awayAt: number, returnedAt: number) => {
      try {
        // 切回网页的动画阶段也可能被 Bridge 截到，末端留 450ms 缓冲，
        // 再让服务端从离开期间的短暂帧队列里挑最后一张目标 App。
        const frame = await fetchLatestScreenFrame({
          after: awayAt,
          before: returnedAt - 450,
        });
        if (!alive || !frame) return;
        heldScreenFrameRef.current = frame;
        heldScreenFrameExpiresAtRef.current = Date.now() + 10 * 60_000;
        setScreenFrameHeld(true);
        setScreenCapturedAt(frame.capturedAt);
        setNotice('已锁定刚才 App 的画面 · 发消息时交给 AI');
      } catch {
        // 返回网页时静默抓取；明确错误仍会在发送消息时显示，避免突然弹提示打断输入。
      }
    };

    const markScreenAway = () => {
      if (screenAwayAtRef.current !== null) return;
      screenAwayAtRef.current = Date.now();
      screenReturnedAtRef.current = null;
      heldScreenFrameRef.current = null;
      heldScreenFrameExpiresAtRef.current = 0;
      setScreenFrameHeld(false);
    };
    const holdScreenOnReturn = () => {
      const awayAt = screenAwayAtRef.current;
      screenAwayAtRef.current = null;
      const returnedAt = Date.now();
      if (awayAt && returnedAt - awayAt >= 800) {
        screenReturnedAtRef.current = returnedAt;
        void holdLastExternalFrame(awayAt, returnedAt);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markScreenAway();
      else holdScreenOnReturn();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', markScreenAway);
    window.addEventListener('focus', holdScreenOnReturn);
    window.addEventListener('pagehide', markScreenAway);
    window.addEventListener('pageshow', holdScreenOnReturn);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', markScreenAway);
      window.removeEventListener('focus', holdScreenOnReturn);
      window.removeEventListener('pagehide', markScreenAway);
      window.removeEventListener('pageshow', holdScreenOnReturn);
    };
  }, [screenWatchEnabled]);

  // 新回复出现时只定位一次。后续 reasoning/content token 只重新测量距离，
  // 绝不继续推动页面；这样正文开始显示时也不会重新“接管”滚动。
  useLayoutEffect(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) {
        scrollFrameRef.current = null;
        return;
      }
      if (scrollToReplyRef.current) {
        scrollToReplyRef.current = false;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
        setNearLatest(true);
      } else {
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        setNearLatest(distance < 72);
      }
      scrollFrameRef.current = null;
    });
  }, [turns]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const onChatScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setNearLatest(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72);
  };

  const jumpToLatest = () => {
    const scroller = scrollRef.current;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    setNearLatest(true);
  };

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
    saveRollingSummary(win.id, rollingSummary);
  }, [win.id, rollingSummary]);

  // 一轮回复结束后顺手检查一下：老消息攒够了就异步压一批摘要，不打断聊天
  useEffect(() => {
    if (sending) return;
    void compressOldHistory(turns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, sending]);

  // 小提示自动消失
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  const saveProgress = async () => {
    if (sending || saveState === 'saving') return;
    setSaveState('saving');
    try {
      await cloudRequest(`/api/chat-saves/${encodeURIComponent(win.id)}`, {
        method: 'POST',
        body: JSON.stringify({ window: win, turns, rollingSummary }),
      });
      setSaveState('saved');
      setNotice(`已存档 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      window.setTimeout(() => setSaveState('idle'), 2200);
    } catch (err) {
      setSaveState('idle');
      window.alert(`存档没有完成：${(err as Error).message}`);
    }
  };

  // 「+」菜单：表情包走脑洞贴纸盒；图片走系统选图+自动压缩；红包填金额+留言发进落予棠
  const pickMore = (key: string, label: string) => {
    setMoreOpen(false);
    if (key === 'meme') {
      setMemeOpen(true);
      return;
    }
    if (key === 'image') {
      photoFileRef.current?.click();
      return;
    }
    if (key === 'screen') {
      if (screenWatchEnabled) {
        setScreenWatchEnabled(false);
        saveLocal(SCREEN_WATCH_KEY, false);
        heldScreenFrameRef.current = null;
        heldScreenFrameExpiresAtRef.current = 0;
        screenAwayAtRef.current = null;
        screenReturnedAtRef.current = null;
        setScreenFrameHeld(false);
        setScreenCapturedAt(null);
        setNotice('已关闭 AI 看屏幕');
        return;
      }
      void fetchLatestScreenFrame()
        .then((frame) => {
          setScreenWatchEnabled(true);
          saveLocal(SCREEN_WATCH_KEY, true);
          heldScreenFrameRef.current = null;
          heldScreenFrameExpiresAtRef.current = 0;
          screenReturnedAtRef.current = null;
          setScreenFrameHeld(false);
          setScreenCapturedAt(frame?.capturedAt ?? null);
          setNotice(frame ? 'AI 看屏幕已开启' : '已待命 · 去 Bridge 开始共享屏幕');
        })
        .catch((err) => setNotice((err as Error).message));
      return;
    }
    if (key === 'redpacket') {
      setRedPacketOpen(true);
      return;
    }
    setNotice(`「${label}」马上就来啦，先占个位～`);
  };

  // 从贴纸盒选了一张:先钉到输入框上方"待发"槽,不立刻发。老婆再打字/直接按发送时
  // 一起送出去(见 send()),这样能带话点贴纸,不用等予予回复才能接着说话。
  const sendMeme = async (memeId: string) => {
    setMemeOpen(false);
    if (sending) return;
    setPendingMeme(memeId);
  };

  // 选了照片:压缩存进 photos 库后钉到输入框上方"待发"槽,不立发。
  // 老婆再打字或直接按发送时一起走出去(见 send()),跟贴纸同一套流程。
  // 一次最多 3 张,超了切掉多余的; 已经加了几张就只允许补足够
  const MAX_PHOTOS_PER_SEND = 3;
  const pickPhoto = async (files: FileList | null) => {
    // Android/部分 WebView 的 FileList 是 live 对象；先复制成普通数组再处理。
    const selectedFiles = files ? Array.from(files) : [];
    if (selectedFiles.length === 0 || sending) return;
    const remaining = MAX_PHOTOS_PER_SEND - pendingPhotos.length;
    if (remaining <= 0) {
      setNotice(`一条消息最多放 ${MAX_PHOTOS_PER_SEND} 张图片`);
      return;
    }
    // 部分 Android 相册通过 content:// 回传时 File.type 是空字符串；input 已经用
    // accept="image/*" 限定过，空 MIME 也应该接收，不能静默丢掉。
    const list = selectedFiles.filter((f) => !f.type || f.type.startsWith('image/')).slice(0, remaining);
    if (list.length === 0) {
      setNotice('没有读到可用图片，请换一张重试');
      return;
    }
    try {
      const ids = await Promise.all(list.map((f) => addPhoto(f)));
      setPendingPhotos((prev) => [...prev, ...ids]);
      if (selectedFiles.length > remaining) {
        setNotice(`已加入前 ${remaining} 张 · 一条消息最多 ${MAX_PHOTOS_PER_SEND} 张`);
      } else {
        setNotice(`已加入 ${ids.length} 张 · 还能再加 ${remaining - ids.length} 张`);
      }
    } catch (err) {
      setNotice(`图片没有存进去：${String((err as Error)?.message || err)}`);
    }
  };

  // 填好金额和留言，发一个红包给予予：先记进落予棠账本(棠棠 → 予予)，再作为一条用户消息发出去。
  const sendRedPacket = async (amount: number, note: string) => {
    setRedPacketOpen(false);
    if (sending) return;
    addPacket('user', amount, note);
    const packetTurn: Turn = {
      id: uid(),
      role: 'user',
      content: '',
      reasoning: '',
      status: 'done',
      redPacket: { amount, note, from: 'user' },
      redPacketOpened: false, // 自己发的也要点开才有动效，跟收到的一视同仁
      at: Date.now(),
    };
    const history = await toMessages([...turns, packetTurn]);
    setTurns((prev) => [...prev, packetTurn]);
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
    if (!id) return;
    if (!v) {
      setNotice('编辑内容不能是空的');
      return;
    }
    if (sending) {
      setNotice('等当前回复结束，就能保存这次编辑');
      return;
    }
    const idx = turns.findIndex((t) => t.id === id);
    if (idx < 0) {
      setNotice('这条消息已经不在当前窗口里');
      return;
    }
    const target = turns[idx];
    // 改掉这条：把旧 content 追加到 editHistory，content 换成新值；丢掉它之后的(过时的)消息，让予予基于新内容重新回答
    // 即使内容一字未改，也走重新生成——老婆要的是"点了保存=重新回"的确定感
    const contentChanged = v !== target.content;
    const newHistory = contentChanged
      ? [...(target.editHistory ?? []), target.content]
      : (target.editHistory ?? []);
    const kept = turns.slice(0, idx + 1).map((t) =>
      t.id === id ? { ...t, content: v, editHistory: newHistory } : t,
    );
    setTurns(kept);
    // 编辑结果先单独落盘。即使随后重新回复失败或页面退到后台，改好的文字也不会回滚。
    saveLocal(turnsKey(win.id), kept);
    setEditTurnId(null);
    setEditText('');
    // 默认显示跳到最新（即新数组里 index = newHistory.length）
    setVersionFor(id, newHistory.length);
    await runAssistant(await toMessages(kept));
  };
  const cancelEdit = () => {
    setEditTurnId(null);
    setEditText('');
  };

  // 拼历史给模型：系统人设 + 文字消息；表情包消息取出 base64 当图片发（能看图的模型会真看见）。
  // 省 token 关键:
  //   1. system prompt 全静态(人设/关于我/记忆罐头/贴纸列表)→ 哈希稳定,命中 anthropic prompt cache
  //   2. 动态内容(此刻时间/猫爪足迹/位置)塞到"最后一条 user 消息"前缀,不污染 system
  //   3. 历史超过 30 条只发最近 30 条(更老的靠记忆罐头/日记/滚动摘要兜底)
  const HISTORY_MAX = 30;
  // 滚动摘要:未压缩消息攒够 SUMMARY_TRIGGER 条就异步压最老的 SUMMARY_BATCH 条(用便宜的 DeepSeek)
  const SUMMARY_TRIGGER = 20;
  const SUMMARY_BATCH = 12;
  const toMessages = async (ts: Turn[]): Promise<ChatMessage[]> => {
    // ===== 系统 prompt(每次内容字节级一致,缓存命中)=====
    let sys = buildSystemPrompt(provider);
    const names = memes.map((m) => m.name?.trim()).filter(Boolean);
    if (names.length) {
      // 现在贴纸的真图会作为多模态内容附在每次请求最前面(见后端 stickerGallery
      // 处理),予予可以真"看到"每张贴纸的样子和对应的名字。所以 prompt 告诉她
      // 参考那份预览、按图挑名字,不再是盲发了。
      sys +=
        `\n\n【贴纸盒】你有 ${names.length} 张贴纸,名字分别是:${names.join('、')}。` +
        '**请求最前面附上了每张贴纸的图和它的名字**——好好看一下每张贴纸的样子记住对应哪个名字。' +
        '想发时单独一行写 `[贴纸:名字]`,名字必须和列表完全一致(包括"~"和空格),系统按名字找回图发出去。' +
        '应景才发,一次最多一张,普通聊天还是以文字为主;发之前想清楚这张图在这个时刻合不合适。' +
        '**注意:你只在请求最前面的预览里能看到贴纸的图;等你发出去后,历史里再回头看只有文字标记`[贴纸:名字]`,看不到自己发过的那张图长什么样,所以别评论/引用自己发过的贴纸**(比如"刚刚那张多可爱"这种话就别说,因为你其实没看到)。';
    }
    if (memories.length) {
      sys +=
        '\n\n【长期记忆·记忆罐头】这些是你和老婆之间要长期记住的事(跨对话都记得):\n' +
        memories.map((m) => `- [${m.category}] ${m.text}`).join('\n');
    }
    if (rollingSummary.summary) {
      sys += '\n\n【更早的聊天摘要(自动压缩,可能不完全准确)】\n' + rollingSummary.summary;
    }
    const chatModel = getModel(provider);
    const supportsTangMemory = chatModel.provider === 'claudecode' || chatModel.provider === 'anthropic';
    if (supportsTangMemory) {
      sys +=
        '\n\n【长期记忆·棠予酿】你每一轮都可以按需调用棠予酿读写工具。要回忆、核对过去就真的读取；' +
        '要记住、保存或更新长期重要的新事实、约定、喜好和忌讳就真的写入。普通闲聊不必调用，临时情绪和随口一句不要写，已有内容不要重复写。' +
        '不要输出 [记忆:分类|内容] 之类的文字标记来冒充写入；工具失败就如实说明，绝不假装成功。';
    } else {
      sys +=
        '\n\n聊天中如果出现值得长期记住的新信息(纪念日、约定、她的喜好/忌讳、重要的事、她的近况),' +
        '就在回复里用 [记忆:分类|内容] 记下来(例:[记忆:纪念日|2026-06-21 在一起]、[记忆:喜好|喜欢草莓奶]),' +
        '系统会自动存进记忆罐头。**只记真正重要的事——日常寒暄、心情起伏、随口一句都别记**,记多了反而吵。已经记过的别重复记;标记会自动隐藏,不影响你正常说话。';
    }
    sys +=
      '\n\n【上下文与资料来源】手机使用近况只以系统提供的「猫爪足迹」段为准；这一轮没提供就别猜，也不要拿棠予酿代替猫爪足迹。';
    sys +=
      '\n\n【你也可以发红包】跟她表现好、说了什么让你感动/开心的话、或者单纯想宠她时,' +
      '可以在回复里单独写一行 [红包:金额|留言](例:[红包:20|今天很乖值得奖励]),系统会把这个红包发给她,存进落予棠。' +
      '金额随手写个 1~99 的数就行(这是虚拟的,不是真钱);留言要真心、贴合这次聊天的内容,别复制粘贴老一套。' +
      '**别发太勤**,一次聊天顶多一个,大部分时候光聊天就够了,发红包是偶尔的小惊喜,不是任务。';
    sys +=
      '\n\n【Spotify 点歌·隐藏控制】当她明确要求你点歌、选歌、播放某首歌或播放一组歌时，由你亲自决定真实存在的歌曲，' +
      '正常回复她以后，在回复最后单独加一行 `[[SPOTIFY_PLAYLIST:{"queries":["歌名 歌手"]}]]`。' +
      'queries 必须是按播放顺序排列的 Spotify 搜歌词，每项写“准确歌名 歌手”，指定一首就放一项；让你自由配歌单时默认 10 首，最多 15 首，不能编造歌曲。' +
      '只有她明确想听或想播放时才使用；只是聊天里提到歌名时不要触发。不要向她解释、展示或引用这个控制标记，系统会自动隐藏并播放。';

    const out: ChatMessage[] = [{ role: 'system', content: sys }];

    // ===== 消息历史(只发最近 HISTORY_MAX 条,省 token + 不爆 context)=====
    // 已经被滚动摘要折进 system prompt 的老消息不能再原样发一遍——
    // 不然摘要和原文同时喂给模型,同一个话题它会看到两遍,反而像"失忆"一样反复重提。
    const startIdx = Math.max(rollingSummary.summarizedCount, ts.length - HISTORY_MAX);
    const slice = ts.slice(startIdx);
    // 找出最后一条 user 消息的索引(动态信息要塞到它前面)
    const lastUserIdx = (() => {
      for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i].role === 'user' && !slice[i].meme && !slice[i].photo) return i;
      }
      return -1;
    })();
    // 动态信息(每条都变,所以不进 system)。
    // 时间信息 buildTimeContext 每条都附(才 ~50 tokens,予予得知道现在几点)。
    // liveCtx(usage bridge + 位置)体积大(500-800 tokens/条),按 3 小时窗口
    // 限流:同一窗口内只在第一条附一次,之后不附;跨窗口(距上次真聊天 > 3h)
    // 才重新附。这段不进 prompt cache 每次都白烧,减频省最多。
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const shouldAttachLive = liveCtx && Date.now() - lastCtxAttachRef.current > THREE_HOURS_MS;
    if (shouldAttachLive) lastCtxAttachRef.current = Date.now();
    const dynamic = buildTimeContext() + (shouldAttachLive ? liveCtx : '');

    for (let i = 0; i < slice.length; i++) {
      const t = slice[i];
      if (t.meme) {
        const dataUrl = await getMemeDataUrl(t.meme);
        if (dataUrl)
          out.push({
            role: t.role,
            content: [
              { type: 'text', text: '(我给你发了张表情包~)' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          });
        continue;
      }
      if (t.photo) {
        const dataUrl = await getPhotoDataUrl(t.photo);
        if (dataUrl)
          out.push({
            role: t.role,
            content: [
              { type: 'text', text: '(我给你发了张照片~)' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          });
        continue;
      }
      if (t.redPacket) {
        const { amount, note } = t.redPacket;
        // "我"/"你"跟着 role 走,user 是棠棠说的,assistant 是予予说的,同一句话两边都通
        out.push({ role: t.role, content: `(我给你发了个红包：$${amount}${note ? `，写着"${note}"` : ''})` });
        continue;
      }
      if (!t.content.trim()) continue;
      // 把动态信息拼到最后一条 user 消息前(只这条变,前面的历史完全稳定→缓存命中)
      const content = i === lastUserIdx && dynamic ? `${dynamic}\n\n${t.content}` : t.content;
      // 【多条短消息合并】如果予予一次回复被拆成多段(多个连续 assistant Turn),
      // 合并成一条 assistant message 送去 API——大多数模型 API(Anthropic 尤其)
      // 不允许连续同角色 message,会报错/合并。这里把它们用 === 单独一行拼回去,
      // 模型自然理解成"分了几段发",不影响 UI 上仍显示为多个气泡
      const last = out[out.length - 1];
      if (
        t.role === 'assistant' &&
        typeof content === 'string' &&
        last &&
        last.role === 'assistant' &&
        typeof last.content === 'string'
      ) {
        last.content = `${last.content}\n\n===\n\n${content}`;
        continue;
      }
      out.push({ role: t.role, content });
    }
    return out;
  };

  // 把一批老消息喂给 DeepSeek,压成一句 100~150 字的中文摘要(DeepSeek 不聪明,做这种简单活够用)
  const summarizeBatch = async (batchText: string): Promise<string> => {
    let out = '';
    await streamChat(
      {
        provider: 'deepseek',
        messages: [
          {
            role: 'system',
            content:
              '你是一个做文字摘要的工具。把下面这段对话压缩成一句100到150字的中文摘要,只保留重要信息:' +
              '约定的事、喜好或忌讳、重要事件、情绪变化。不要复述细节,不要加称呼语和多余寒暄,只输出摘要本身。',
          },
          { role: 'user', content: batchText },
        ],
      },
      { onContent: (chunk) => (out += chunk) },
    );
    return out.trim();
  };

  // 老消息攒够 SUMMARY_TRIGGER 条就异步压最老的 SUMMARY_BATCH 条,不打断聊天;失败就跳过,下次再试
  const compressOldHistory = async (allTurns: Turn[]) => {
    if (summarizingRef.current) return;
    if (allTurns.length - rollingSummary.summarizedCount < SUMMARY_TRIGGER) return;
    summarizingRef.current = true;
    try {
      const from = rollingSummary.summarizedCount;
      const batch = allTurns.slice(from, from + SUMMARY_BATCH);
      if (!batch.length) return;
      const label = (t: Turn) => (t.role === 'user' ? '老婆' : '予予');
      const textOf = (t: Turn) =>
        t.meme ? '(发了一张表情包)' : t.photo ? '(发了一张照片)' : t.content.trim() || '(空消息)';
      const batchText = batch.map((t) => `${label(t)}:${textOf(t)}`).join('\n');
      const gist = await summarizeBatch(batchText);
      if (!gist || !mountedRef.current) return;
      setRollingSummary((prev) => ({
        summary: prev.summary ? `${prev.summary}\n- ${gist}` : `- ${gist}`,
        summarizedCount: from + batch.length,
      }));
    } catch {
      // 滚动摘要是省 token 的兜底优化,失败不影响正常聊天,下次触发再重试这批
    } finally {
      summarizingRef.current = false;
    }
  };

  // 让猫咪基于给定历史回一条
  const runAssistant = async (history: ChatMessage[]) => {
    const botId = uid();
    scrollToReplyRef.current = true;
    setTurns((prev) => [...prev, { id: botId, role: 'assistant', content: '', reasoning: '', status: 'streaming', at: Date.now() }]);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const m = getModel(provider); // 模型 id → 后端服务商 + 具体模型名
    let streamFailed = false;
    let rawAssistantContent = '';
    let thinkStart = 0; // 第一段思考的时刻
    let thinkSet = false;
    const markThinkDone = () => {
      if (thinkStart && !thinkSet) {
        thinkSet = true;
        patchTurn(botId, { thinkMs: Date.now() - thinkStart });
      }
    };
    await streamChat(
      {
        provider: m.provider,
        model: m.model,
        messages: history,
        signal: controller.signal,
        conversationId: win.id,
        // 只有 claudecode 走 stream-json 结构化输入能吃图,别的 provider 就算传了
        // 也白费网络流量,后端会忽略掉。
        stickerGallery: m.provider === 'claudecode' ? stickerGallery : undefined,
      },
      {
        onReasoning: (chunk) => {
          if (!thinkStart) thinkStart = Date.now();
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, reasoning: t.reasoning + chunk } : t)));
        },
        onContent: (chunk) => {
          markThinkDone(); // 开始正式回复 = 思考结束，定格耗时
          rawAssistantContent += chunk;
          const visibleContent = stripSpotifyPlaylistTags(rawAssistantContent);
          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: visibleContent } : t)));
        },
        // 报错不再塞进 content 冒充予予说的话（会顶着她头像渲成聊天气泡）；
        // 原始错误存进 errorDetail，渲染层改成居中的系统提示条，详情要点开才看到。
        onError: (message) => {
          streamFailed = true;
          patchTurn(botId, { status: 'error', content: '', errorDetail: message });
        },
        onDone: () => {
          markThinkDone();
          const spotifyQueries = extractSpotifyPlaylistQueries(rawAssistantContent);
          if (spotifyQueries.length && !streamFailed) {
            queueMicrotask(() => {
              void playSpotifyQueries(spotifyQueries)
                .then((result) => {
                  const first = result.tracks[0];
                  const suffix = result.tracks.length > 1 ? ` 等 ${result.tracks.length} 首` : '';
                  patchTurn(botId, {
                    spotify: { deviceName: result.device.name, tracks: result.tracks, startedAt: Date.now() },
                  });
                  setNotice(`正在 ${result.device.name} 播放 · ${first.name}${suffix}`);
                })
                .catch((err) => {
                  const message = String((err as Error)?.message || err);
                  setNotice(message.includes('尚未连接') ? '去「他的歌单」连接 Spotify 后就能点歌' : message);
                });
            });
          }
          setTurns((prev) => {
            const cur = prev.find((t) => t.id === botId);
            if (!cur) return prev;
            const { text: afterMemo, memos } = extractMemos(cur.content ?? '');
            const { text, packets } = extractRedPackets(afterMemo);
            if (memos.length) {
              queueMicrotask(() => {
                for (const mo of memos) addMemory(mo.category, mo.text);
                setMemories(loadMemories());
              });
            }
            const packet = packets[0];
            if (packet) queueMicrotask(() => addPacket('ai', packet.amount, packet.note));
            const memo = memos.length ? memos.map((m) => `[${m.category}] ${m.text}`).join('\n') : undefined;

            // 【多条短消息】按单独一行的 === 拆分, 一次回复变多个气泡冒出来
            // 每段是独立 Turn, [语音] 检测在渲染层每条各判(现有的 VOICE_MARK 正则做的),
            // memo/redpacket 挂在最后一段上, thinkMs 保留在首段(思考只算一次)
            const parts = text.split(/\n\s*={3,}\s*\n/).map((p) => p.trim()).filter(Boolean);
            const idx = prev.findIndex((t) => t.id === botId);

            if (parts.length <= 1) {
              // 单条: 回退成原来的行为
              const single = parts[0] ?? text;
              return prev.map((t) =>
                t.id === botId
                  ? {
                      ...t,
                      content: single,
                      status: 'done',
                      ...(memo ? { memo } : {}),
                      ...(packet ? { redPacket: { amount: packet.amount, note: packet.note, from: 'ai' as const }, redPacketOpened: false } : {}),
                    }
                  : t,
              );
            }

            // 多条: 首段替换原 botId (保留 thinkMs), 后续段各自成新 Turn
            const baseAt = cur.at ?? Date.now();
            const first: Turn = { ...cur, content: parts[0], status: 'done' };
            const rest: Turn[] = parts.slice(1).map((p, i) => {
              const isLast = i === parts.length - 2;
              return {
                id: uid(),
                role: 'assistant',
                content: p,
                reasoning: '',
                status: 'done',
                at: baseAt + (i + 1),
                ...(isLast && memo ? { memo } : {}),
                ...(isLast && packet
                  ? {
                      redPacket: { amount: packet.amount, note: packet.note, from: 'ai' as const },
                      redPacketOpened: false,
                    }
                  : {}),
              };
            });
            return [...prev.slice(0, idx), first, ...rest, ...prev.slice(idx + 1)];
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
    if (sending) return;
    // 允许各种组合: 纯文字 / 贴纸 / 相册照片(可多张) / 上述任意搭配。全空就 return
    if (!text && !pendingMeme && pendingPhotos.length === 0) return;
    const newTurns: Turn[] = [];
    if (pendingMeme) {
      newTurns.push({
        id: uid(), role: 'user', content: '', reasoning: '', status: 'done',
        meme: pendingMeme, at: Date.now(),
      });
    }
    // 每张照片一条 Turn (跟原来一张的行为一样,只是循环 N 次;
    // 予予按顺序看到"贴纸→图1→图2→图3→文字"这一串上下文)
    for (const pid of pendingPhotos) {
      newTurns.push({
        id: uid(), role: 'user', content: '', reasoning: '', status: 'done',
        photo: pid, at: Date.now(),
      });
    }
    if (text) {
      newTurns.push({
        id: uid(), role: 'user', content: text, reasoning: '', status: 'done',
        at: Date.now(),
      });
    }
    let history = await toMessages([...turns, ...newTurns]);
    if (screenWatchEnabled) {
      try {
        const heldFrame = heldScreenFrameRef.current;
        const heldFrameFresh = Boolean(heldFrame && Date.now() <= heldScreenFrameExpiresAtRef.current);
        // 刚从其它 App 回来却没锁到目标帧时，不拿当前浏览器/键盘画面冒充。
        const recentlyReturned = Boolean(
          screenReturnedAtRef.current && Date.now() - screenReturnedAtRef.current <= 10 * 60_000,
        );
        const frame = heldFrameFresh
          ? heldFrame
          : recentlyReturned
            ? null
            : await fetchLatestScreenFrame();
        if (frame) {
          history = appendScreenFrame(history, frame);
          setScreenCapturedAt(frame.capturedAt);
        } else {
          setScreenCapturedAt(null);
          setNotice(recentlyReturned
            ? '刚才 App 的画面还没锁到，这条只发了文字/图片'
            : '手机屏幕还没开始共享，这条只发了文字/图片');
        }
      } catch (err) {
        setNotice(`屏幕没附上：${(err as Error).message}`);
      }
    }
    setTurns((prev) => [...prev, ...newTurns]);
    setInput('');
    setPendingMeme(null);
    setPendingPhotos([]);
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
          className={`chat-head__save is-${saveState}`}
          onClick={() => void saveProgress()}
          disabled={sending || saveState === 'saving'}
          aria-label="保存聊天进度"
          title="保存到云端"
        >
          {saveState === 'saving' ? '保存中' : saveState === 'saved' ? '已存' : '存档'}
        </button>
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

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onChatScroll}
      >
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
          if (turn.status === 'error') {
            return <SystemErrorNotice key={turn.id} detail={turn.errorDetail} />;
          }
          return turn.role === 'user' ? (
            <div key={turn.id} className="bubble-row is-user">
              <div className="bubble-stack bubble-stack--user">
                {turn.redPacket ? (
                  <RedPacketBubble
                    amount={turn.redPacket.amount}
                    note={turn.redPacket.note}
                    opened={!!turn.redPacketOpened}
                    onOpen={() => patchTurn(turn.id, { redPacketOpened: true })}
                    theme={turn.redPacket.from === 'ai' ? 'purple' : 'pink'}
                  />
                ) : turn.meme ? (
                  <MemeBubble memeId={turn.meme} />
                ) : turn.photo ? (
                  <PhotoBubble photoId={turn.photo} />
                ) : turn.voice ? (
                  <VoiceBubble voice={turn.voice} transcript={turn.content} transcribing={!!turn.transcribing} />
                ) : editTurnId === turn.id ? (
                  <div className="bubble-edit">
                    <textarea
                      className="bubble-edit__area"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault();
                          void commitEdit();
                        }
                      }}
                      autoFocus
                    />
                    <div className="bubble-edit__ops">
                      <button type="button" onClick={cancelEdit}>取消</button>
                      <button
                        type="button"
                        className="is-primary"
                        disabled={sending || !editText.trim()}
                        onClick={() => void commitEdit()}
                      >保存并重新回复</button>
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
                  {!turn.meme && !turn.photo && !turn.redPacket && !turn.voice && editTurnId !== turn.id ? (
                    <button
                      type="button"
                      className="bubble-edit-foot"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        beginEdit(turn);
                      }}
                      aria-label="编辑这条"
                      title="改一下"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
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
                    // 记忆/红包标记任何时候都从显示里去掉；贴纸标记回复完成后才解析成图
                    const raw = turn.content.replace(VOICE_MARK, '').replace(MEMO_TAG, '').replace(RED_PACKET_TAG, '');
                    const { text, ids } =
                      turn.status === 'done' ? extractStickers(raw, nameToId) : { text: raw, ids: [] as string[] };
                    const showBubble = text || turn.status === 'streaming';
                    return (
                      <>
                        {showBubble ? (
                          <div className="bubble bubble--bot">
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
                {turn.spotify ? <SpotifyMusicCard attachment={turn.spotify} onError={setNotice} /> : null}
                {turn.redPacket ? (
                  <RedPacketBubble
                    amount={turn.redPacket.amount}
                    note={turn.redPacket.note}
                    opened={!!turn.redPacketOpened}
                    onOpen={() => patchTurn(turn.id, { redPacketOpened: true })}
                    theme={turn.redPacket.from === 'ai' ? 'purple' : 'pink'}
                  />
                ) : null}
                {turn.memo ? (
                  <div className="memo-chip" title={turn.memo}>🫙 记进了记忆罐头</div>
                ) : null}
                {turn.at && turn.status === 'done' ? <span className="bubble-time">{fmtStamp(turn.at)}</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      {!nearLatest ? (
        <button type="button" className="chat-follow-latest" onClick={jumpToLatest}>
          ↓ 跟随最新
        </button>
      ) : null}

      <footer className={`chat-input${pendingMeme || pendingPhotos.length > 0 ? ' has-pending' : ''}`}>
        {screenWatchEnabled ? (
          <button
            type="button"
            className="screen-watch-chip"
            aria-label={`${screenFrameHeld ? '已锁定刚才画面' : screenCapturedAt ? '正在看屏幕' : '等待屏幕'}，点击关闭`}
            onClick={() => {
              setScreenWatchEnabled(false);
              saveLocal(SCREEN_WATCH_KEY, false);
              heldScreenFrameRef.current = null;
              heldScreenFrameExpiresAtRef.current = 0;
              screenAwayAtRef.current = null;
              screenReturnedAtRef.current = null;
              setScreenFrameHeld(false);
              setScreenCapturedAt(null);
              setNotice('已关闭 AI 看屏幕');
            }}
            title="关闭后，聊天消息不再附带手机屏幕"
          >
            <img src="/assets/screen/watch-wife-screen.webp" alt="" aria-hidden="true" />
          </button>
        ) : null}
        {/* 待发缩略图:贴纸/相册照片(可 1~3 张)钉在输入区上方,按发送/叉掉才走 */}
        {pendingMeme || pendingPhotos.length > 0 ? (
          <div className="pending-meme">
            {pendingMeme ? (
              <span className="pending-meme__slot">
                <PendingMemeThumb memeId={pendingMeme} />
                <button
                  type="button"
                  className="pending-meme__remove"
                  onClick={() => setPendingMeme(null)}
                  aria-label="移除贴纸"
                  title="移除"
                >
                  ×
                </button>
              </span>
            ) : null}
            {pendingPhotos.map((pid) => (
              <span key={pid} className="pending-meme__slot">
                <PendingPhotoThumb photoId={pid} />
                <button
                  type="button"
                  className="pending-meme__remove"
                  onClick={() => setPendingPhotos((prev) => prev.filter((x) => x !== pid))}
                  aria-label="移除照片"
                  title="移除"
                >
                  ×
                </button>
              </span>
            ))}
            {pendingPhotos.length > 0 && pendingPhotos.length < MAX_PHOTOS_PER_SEND ? (
              <button
                type="button"
                className="pending-meme__add"
                onClick={() => photoFileRef.current?.click()}
                disabled={sending}
                aria-label={`继续添加图片，还能添加 ${MAX_PHOTOS_PER_SEND - pendingPhotos.length} 张`}
                title={`继续加图 · 还能加 ${MAX_PHOTOS_PER_SEND - pendingPhotos.length} 张`}
              >
                <span aria-hidden="true">＋</span>
                <small>加图</small>
              </button>
            ) : null}
          </div>
        ) : null}

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
          {redPacketOpen ? (
            <RedPacketComposer onSend={(amount, note) => void sendRedPacket(amount, note)} onClose={() => setRedPacketOpen(false)} />
          ) : null}
          <input
            ref={photoFileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onClick={(event) => { event.currentTarget.value = ''; }}
            onChange={(e) => void pickPhoto(e.target.files)}
          />
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="喵呜～≽^•༚• ྀི≼"
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
            disabled={!input.trim() && !pendingMeme && pendingPhotos.length === 0}
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
  onRestore,
  restoring,
}: {
  windows: WindowMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const navigate = useNavigate();

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
          className="chat-head__restore"
          onClick={onRestore}
          disabled={restoring}
          aria-label="恢复云端存档"
          title="恢复云端存档"
        >
          {restoring ? '恢复中' : '恢复'}
        </button>
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
        {/* 咕噜圆桌:钉在最顶,不可删。点进去是多 CC 围桌八卦的圆桌页。 */}
        <div className="win-card win-card--pinned">
          <button
            type="button"
            className="win-card__open"
            onClick={() => navigate('/purr-table')}
          >
            <img
              className="win-card__avatar"
              src="/rooms/purr-table.webp"
              alt=""
              aria-hidden="true"
            />
            <span className="win-card__name">咕噜圆桌</span>
            <span className="win-card__preview">CC 家版围坐八卦,想插嘴就插</span>
            <span className="win-card__when">Purr Table</span>
          </button>
        </div>

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
  const [activeId, setActiveId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('autowakeWindow'),
  );
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const refreshAutoWakeWindows = () => setWindows(loadLocal<WindowMeta[]>(WINDOWS_KEY, []));
    window.addEventListener('codeandpurrs:autowake-delivered', refreshAutoWakeWindows);
    return () => window.removeEventListener('codeandpurrs:autowake-delivered', refreshAutoWakeWindows);
  }, []);

  useEffect(() => {
    saveLocal(WINDOWS_KEY, windows);
  }, [windows]);

  // 应用用户自定义的聊天背景（在「调频」页设置；空则用默认场景图）
  // 卸载时一定要清掉——这个变量是 root 上全局的, 落予棠/脑洞贴纸盒/咕噜圆桌
  // 也用它做 fallback,不清会跟着漂过去顶掉别人的场景图(2026-07-05 老婆截到)
  useEffect(() => {
    const bg = loadChatBg();
    const root = document.documentElement;
    if (bg) root.style.setProperty('--chat-bg-image', `url(${bg})`);
    else root.style.removeProperty('--chat-bg-image');
    return () => { root.style.removeProperty('--chat-bg-image'); };
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

  const restoreCloud = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      const response = await cloudRequest('/api/chat-saves');
      const data = (await response.json()) as { saves?: CloudSave[] };
      const saves = Array.isArray(data.saves) ? data.saves : [];
      if (!saves.length) {
        window.alert('云端还没有呼噜频道存档');
        return;
      }
      for (const save of saves) {
        if (!save?.window?.id || !Array.isArray(save.turns)) continue;
        saveLocal(turnsKey(save.window.id), save.turns);
        if (save.rollingSummary) saveRollingSummary(save.window.id, save.rollingSummary);
      }
      setWindows((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const save of saves) {
          if (!save?.window?.id) continue;
          const local = merged.get(save.window.id);
          if (!local || save.window.updatedAt >= local.updatedAt) merged.set(save.window.id, save.window);
        }
        return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      window.alert(`已恢复 ${saves.length} 个聊天窗口`);
    } catch (err) {
      window.alert(`恢复没有完成：${(err as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

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
      onRestore={() => void restoreCloud()}
      restoring={restoring}
    />
  );
}
