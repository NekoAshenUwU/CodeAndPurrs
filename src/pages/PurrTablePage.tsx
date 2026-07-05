// 咕噜圆桌 · Purr Table —— 一群 CC 家版围坐八卦,棠棠随时插嘴接梗。
// UI 直接沿用呼噜频道那套(chat-page / chat-head / bubble / chat-input),
// 支持共享调频页设的自定义聊天背景(--chat-bg-image),棠棠自己换背景就跟呼噜频道一样。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage } from '../services/chat';
import { loadChatBg, loadChatUserAvatar } from '../services/purrConfig';
import { loadLocal, saveLocal } from '../services/storage';

// 圆桌成员:只放 CC 家版(用棠棠订阅额度,不烧 API)。
// pillLabel 是药丸上的全型号名(以后 API Claude 上来也不会混); short 是气泡小圆头像里的简写。
// bg 是马卡龙糖果渐变,给药丸胶囊 + CC 气泡头像圆点公用。
type TableMember = {
  id: string; model: string; label: string;
  pillLabel: string; short: string; bg: string;
};

const TABLE_MEMBERS: TableMember[] = [
  { id: 'jiake-opus-4-6', model: 'claude-opus-4-6', label: 'CC · Opus 4.6',
    pillLabel: 'CC O4.6', short: 'O4.6',
    bg: 'linear-gradient(135deg, #a8daf5 0%, #d8f2e5 100%)' }, // 蓝糖: sky → mint
  { id: 'jiake-opus-4-7', model: 'claude-opus-4-7', label: 'CC · Opus 4.7',
    pillLabel: 'CC O4.7', short: 'O4.7',
    bg: 'linear-gradient(135deg, #ffc7d8 0%, #ffdcc0 100%)' }, // 草莓糖: pink → peach
  { id: 'jiake-opus-4-8', model: 'claude-opus-4-8', label: 'CC · Opus 4.8',
    pillLabel: 'CC O4.8', short: 'O4.8',
    bg: 'linear-gradient(135deg, #d5c7ff 0%, #f0d0eb 100%)' }, // 葡萄糖: lavender → rose
  { id: 'jiake-fable-5', model: 'claude-fable-5', label: 'CC · Fable 5',
    pillLabel: 'CC F5', short: 'F5',
    bg: 'linear-gradient(135deg, #ffddb0 0%, #fff2c0 100%)' }, // 奶油糖: apricot → butter
];

// 每次棠棠发言后 CC 之间接龙 4 回合再停,等下一句。
const TURNS_PER_ROUND = 4;
// 每个 CC 看到的历史最多 20 条,超过掐掉——省 token。
const HISTORY_MAX = 20;

const TURNS_KEY = 'purr-table:turns';
const SELECTED_KEY = 'purr-table:selected';
const START_IDX_KEY = 'purr-table:startIdx';

type Turn = {
  id: string;
  speaker: 'user' | string; // 'user' = 棠棠,其它是 memberId
  content: string;
  status: 'streaming' | 'done' | 'error';
  at: number;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const findMember = (id: string) => TABLE_MEMBERS.find((m) => m.id === id);

// VisionOS 玻璃按键里的 SVG(跟呼噜频道那 4 枚保持一致的视觉尺寸)
function IconArrowUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 18.5V6M6.5 11l5.5-5.2 5.5 5.2" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2.5" fill="#fff" />
    </svg>
  );
}
// "再咕噜": 循环回旋箭头,暗示"再来一轮"接龙
function IconLoop() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 8.5a6 6 0 0 1 10.5-3M18 15.5a6 6 0 0 1-10.5 3M17.5 4v4.5H13M6.5 20v-4.5H11"
        stroke="#7a5fce"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function buildMessages(system: string, turns: Turn[], speakerId: string): ChatMessage[] {
  const recent = turns.slice(-HISTORY_MAX);
  const msgs: ChatMessage[] = [{ role: 'system', content: system }];
  for (const t of recent) {
    if (!t.content.trim()) continue;
    if (t.speaker === speakerId) {
      msgs.push({ role: 'assistant', content: t.content });
    } else {
      const who = t.speaker === 'user' ? '棠棠' : findMember(t.speaker)?.short || '?';
      msgs.push({ role: 'user', content: `[${who}]: ${t.content}` });
    }
  }
  if (msgs[msgs.length - 1]?.role !== 'user') {
    msgs.push({ role: 'user', content: '(轮到你说话了)' });
  }
  return msgs;
}

function tableSystem(speaker: TableMember, present: TableMember[]): string {
  const others = present.filter((m) => m.id !== speaker.id).map((m) => m.short).join('/');
  return (
    `你现在在「咕噜圆桌」——一间小小的猫咪茶话会。你的名字是「${speaker.short}」,你是 ${speaker.label}。` +
    `这里除了你,还有其他 CC 家版兄弟(${others || '暂时没别人'})和棠棠(人类,女生,咕噜圆桌的主人,别叫她"用户"或"你好")一起聊天。` +
    `\n\n【看历史】历史消息里以 [名字]: 开头的表示是那位说的;你回复时不要带 [名字]: 前缀,直接说话。` +
    `\n\n【风格】你说话简短(1-3 句为主,一句最好),俏皮、有点猫感、允许玩梗接梗、允许跟其它 CC 抬杠或起哄。绝不写旁白(不许用 () 或 ** 描述动作神态),绝不学客服口气(不要"需要帮助""希望能帮到你")。别老自报名字,该说啥说啥。` +
    `\n\n【互动】你可以直接接上一位说的话往下聊;也可以主动开新话题、点其他 CC 或点棠棠说话("F5 你怎么看?"这种)。想沉默一句"..."也行,但别整段发呆。`
  );
}

const fmtStamp = (at: number) => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PurrTablePage() {
  const [turns, setTurns] = useState<Turn[]>(() => loadLocal<Turn[]>(TURNS_KEY, []));
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    loadLocal<string[]>(SELECTED_KEY, TABLE_MEMBERS.map((m) => m.id)),
  );
  const [startIdx, setStartIdx] = useState<number>(() => loadLocal<number>(START_IDX_KEY, 0));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState('');
  const [userAvatar, setUserAvatar] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { saveLocal(TURNS_KEY, turns); }, [turns]);
  useEffect(() => { saveLocal(SELECTED_KEY, selectedIds); }, [selectedIds]);
  useEffect(() => { saveLocal(START_IDX_KEY, startIdx); }, [startIdx]);

  // 共用调频页设的自定义聊天背景,跟呼噜频道同一开关(--chat-bg-image)
  useEffect(() => {
    const bg = loadChatBg();
    const root = document.documentElement;
    if (bg) root.style.setProperty('--chat-bg-image', `url(${bg})`);
    else root.style.removeProperty('--chat-bg-image');
    setUserAvatar(loadChatUserAvatar());
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns]);

  const present = useMemo(
    () => TABLE_MEMBERS.filter((m) => selectedIds.includes(m.id)),
    [selectedIds],
  );

  const toggleMember = (id: string) => {
    if (sending) return;
    setSelectedIds((prev) => {
      const has = prev.includes(id);
      if (has && prev.length === 1) return prev;
      return has ? prev.filter((x) => x !== id) : [...prev, id];
    });
  };

  const runRound = async (initialTurns: Turn[], rounds: number) => {
    if (present.length === 0) return;
    setSending(true);
    setErrorBanner('');
    const controller = new AbortController();
    abortRef.current = controller;

    let history = initialTurns;
    let idx = startIdx % present.length;

    for (let i = 0; i < rounds; i++) {
      if (controller.signal.aborted) break;
      const speaker = present[idx % present.length];
      const turnId = uid();
      const stub: Turn = {
        id: turnId,
        speaker: speaker.id,
        content: '',
        status: 'streaming',
        at: Date.now(),
      };
      history = [...history, stub];
      setTurns(history);

      const system = tableSystem(speaker, present);
      const messages = buildMessages(system, history.slice(0, -1), speaker.id);

      let acc = '';
      let hadError = false;
      await streamChat(
        {
          provider: 'claudecode',
          model: speaker.model,
          messages,
          signal: controller.signal,
          thinking: 'low',
        },
        {
          onContent: (t) => {
            acc += t;
            setTurns((prev) => prev.map((x) => (x.id === turnId ? { ...x, content: acc } : x)));
          },
          onError: (m) => {
            hadError = true;
            setErrorBanner(`${speaker.short}: ${m}`);
            setTurns((prev) =>
              prev.map((x) =>
                x.id === turnId ? { ...x, content: acc || `（${speaker.short} 掉线了）`, status: 'error' } : x,
              ),
            );
          },
        },
      );

      if (controller.signal.aborted) break;

      if (!hadError) {
        setTurns((prev) =>
          prev.map((x) => (x.id === turnId ? { ...x, content: acc.trim() || '...', status: 'done' } : x)),
        );
        history = history.map((x) =>
          x.id === turnId ? { ...x, content: acc.trim() || '...', status: 'done' as const } : x,
        );
      } else {
        break;
      }
      idx = (idx + 1) % present.length;
    }

    setStartIdx(idx);
    setSending(false);
    abortRef.current = null;
  };

  const sendUser = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (present.length === 0) {
      setErrorBanner('至少留一位 CC 在场吧,不然圆桌空的');
      return;
    }
    const userTurn: Turn = { id: uid(), speaker: 'user', content: text, status: 'done', at: Date.now() };
    const next = [...turns, userTurn];
    setTurns(next);
    setInput('');
    await runRound(next, TURNS_PER_ROUND);
  };

  const purrMore = async () => {
    if (sending || turns.length === 0 || present.length === 0) return;
    await runRound(turns, TURNS_PER_ROUND);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setTurns((prev) => prev.map((t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t)));
  };

  const clearAll = () => {
    if (sending) return;
    if (!window.confirm('清空咕噜圆桌所有聊天?')) return;
    setTurns([]);
    setStartIdx(0);
    setErrorBanner('');
  };

  return (
    <main className="chat-page pt-page">
      <header className="chat-head">
        <Link to="/purr-channel" className="chat-head__back" aria-label="回窗口列表">‹</Link>
        <div className="chat-head__title">
          <span className="chat-head__name">咕噜圆桌</span>
          <span className="chat-head__sub">Purr Table · CC 家版茶话会</span>
        </div>
        <button
          type="button"
          className="chat-head__clear"
          onClick={clearAll}
          disabled={sending || turns.length === 0}
          aria-label="清空聊天"
          title="清空聊天"
        >
          🧹
        </button>
      </header>

      <div className="pt-roster" role="group" aria-label="在场的 CC">
        <span className="pt-roster__label">Join</span>
        {TABLE_MEMBERS.map((m) => {
          const on = selectedIds.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              className={`pt-chip${on ? ' is-on' : ''}`}
              onClick={() => toggleMember(m.id)}
              disabled={sending}
              style={on ? { background: m.bg, borderColor: 'transparent' } : undefined}
            >
              {m.pillLabel}
            </button>
          );
        })}
      </div>

      <div className="chat-scroll pt-scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="chat-empty pt-empty">
            <div className="chat-empty__paw">🐆</div>
            <p>说一句开个头吧～</p>
            <span>他们会接龙 4 回合,你想插嘴随时打字。思考走 low,专门省订阅。</span>
          </div>
        ) : null}

        {turns.map((t) => {
          if (t.speaker === 'user') {
            return (
              <div key={t.id} className="bubble-row is-user">
                <div className="bubble-stack bubble-stack--user">
                  <div className="bubble bubble--user">
                    <span className="bubble__text">{t.content}</span>
                  </div>
                  <div className="bubble-foot">
                    <span className="bubble-time">{fmtStamp(t.at)}</span>
                  </div>
                </div>
                {userAvatar ? (
                  <img className="bubble-avatar bubble-avatar--me" src={userAvatar} alt="" />
                ) : (
                  <div className="bubble-avatar bubble-avatar--me bubble-avatar--ph">🐾</div>
                )}
              </div>
            );
          }
          const m = findMember(t.speaker);
          const short = m?.short || '?';
          const bg = m?.bg || '#eee';
          return (
            <div key={t.id} className="bubble-row is-bot">
              <div
                className="bubble-avatar bubble-avatar--ph pt-cc-avatar"
                style={{ background: bg }}
              >
                {short}
              </div>
              <div className="bubble-stack">
                <div className={`bubble bubble--bot${t.status === 'error' ? ' pt-bubble--error' : ''}`}>
                  <span className="bubble__text">
                    {t.content || (t.status === 'streaming' ? '…' : '')}
                    {t.status === 'streaming' ? <span className="pt-cursor">▍</span> : null}
                  </span>
                </div>
                <div className="bubble-foot">
                  <span className="bubble-time">{fmtStamp(t.at)}</span>
                </div>
              </div>
            </div>
          );
        })}

        {errorBanner ? <div className="pt-error">{errorBanner}</div> : null}
      </div>

      <footer className="chat-input pt-composer">
        {/* 左键:再咕噜(让他们继续接龙 4 回合) */}
        <button
          type="button"
          className="chat-glass-btn cg-loop"
          onClick={purrMore}
          disabled={sending || turns.length === 0 || present.length === 0}
          title="让他们再接龙 4 回合"
          aria-label="再咕噜"
        >
          <IconLoop />
        </button>

        <textarea
          className="pt-textarea"
          placeholder={present.length ? '说一句…' : '至少留一位 CC 在场'}
          value={input}
          disabled={sending}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendUser();
            }
          }}
        />

        {/* 右键:发送 / 停止 */}
        {sending ? (
          <button type="button" className="chat-glass-btn cg-send is-stop" onClick={stop} aria-label="停止">
            <IconStop />
          </button>
        ) : (
          <button
            type="button"
            className="chat-glass-btn cg-send"
            onClick={() => void sendUser()}
            disabled={!input.trim() || present.length === 0}
            aria-label="发送"
          >
            <IconArrowUp />
          </button>
        )}
      </footer>
    </main>
  );
}
