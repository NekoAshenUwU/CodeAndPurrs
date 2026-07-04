// 咕噜圆桌 · Purr Table —— 一群 CC 家版围坐八卦,棠棠随时插嘴接梗。
// 每次棠棠说一句 → 选中的 CC 按 round-robin 接龙 4 回合 → 停,等下一句。
// Thinking 全部走 low(MAX_THINKING_TOKENS=512),历史只留最近 20 条,不塞日记/记忆罐头/贴纸盒——
// 圆桌是"玩",不是"关系维护",越轻越省 token。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type ChatMessage } from '../services/chat';
import { loadLocal, saveLocal } from '../services/storage';

// 圆桌成员:只放 CC 家版(用棠棠订阅额度,不烧 API)。
// short 是气泡上小徽章的名字,color 是徽章底色。
type TableMember = { id: string; model: string; label: string; short: string; color: string };

const TABLE_MEMBERS: TableMember[] = [
  { id: 'jiake-opus-4-6', model: 'claude-opus-4-6', label: 'CC · Opus 4.6', short: '4.6', color: '#a8c5ff' },
  { id: 'jiake-opus-4-7', model: 'claude-opus-4-7', label: 'CC · Opus 4.7', short: '4.7', color: '#ffb3d6' },
  { id: 'jiake-opus-4-8', model: 'claude-opus-4-8', label: 'CC · Opus 4.8', short: '4.8', color: '#c3a8ff' },
  { id: 'jiake-fable-5', model: 'claude-fable-5', label: 'CC · Fable 5', short: 'F5', color: '#ffcc99' },
];

// 每次棠棠发言后 CC 之间连着说几轮才停下等她。B 方案定的 4 回合。
const TURNS_PER_ROUND = 4;
// 每个 CC 看到的历史最多 20 条,超过的就掐掉——省 token。
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

// 给这轮的说话者拼消息数组:自己说过的话 role=assistant,其他人(含棠棠) role=user 带 [名字]: 前缀。
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
  // 圆桌里模型没"被明确点名回复"的信号,拿最末一条以外的对话当已发生,
  // 用一条简短的 nudge 提醒它该开口了(如果最末已是 user 结尾,不用重复)。
  if (msgs[msgs.length - 1]?.role !== 'user') {
    msgs.push({ role: 'user', content: '(轮到你说话了)' });
  }
  return msgs;
}

// 圆桌人设:短、俏皮、猫感、允许接其他 CC 的梗。
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

const dayjs = (at: number) => {
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

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { saveLocal(TURNS_KEY, turns); }, [turns]);
  useEffect(() => { saveLocal(SELECTED_KEY, selectedIds); }, [selectedIds]);
  useEffect(() => { saveLocal(START_IDX_KEY, startIdx); }, [startIdx]);
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
      if (has && prev.length === 1) return prev; // 至少留一个
      return has ? prev.filter((x) => x !== id) : [...prev, id];
    });
  };

  // 跑 N 轮 CC 接龙。startingTurns 是发起时的完整对话快照(含刚发的 user 消息),
  // 从 startIdx 开始按 present 顺序 round-robin。用 ref 里累积的 turns 每轮传给下一位。
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
              prev.map((x) => (x.id === turnId ? { ...x, content: acc || `（${speaker.short} 掉线了）`, status: 'error' } : x)),
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
        // 出错就中止本轮,别硬撑
        break;
      }
      idx = (idx + 1) % present.length;
    }

    // 记住下一次从哪里起头,让轮次公平轮转,不总是 4.6 先说
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
    if (!confirm('清空咕噜圆桌所有聊天?')) return;
    setTurns([]);
    setStartIdx(0);
    setErrorBanner('');
  };

  return (
    <main className="purr-table-page">
      <header className="pt-head">
        <Link to="/" className="pt-head__back" aria-label="返回主页">‹</Link>
        <div className="pt-head__title">
          <span className="pt-head__name">咕噜圆桌</span>
          <span className="pt-head__sub">Purr Table · CC 家版茶话会</span>
        </div>
        <button
          type="button"
          className="pt-head__clear"
          onClick={clearAll}
          disabled={sending || turns.length === 0}
          title="清空聊天"
        >
          🧹
        </button>
      </header>

      <div className="pt-roster" role="group" aria-label="在场的 CC">
        <span className="pt-roster__label">在场:</span>
        {TABLE_MEMBERS.map((m) => {
          const on = selectedIds.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              className={`pt-chip${on ? ' is-on' : ''}`}
              onClick={() => toggleMember(m.id)}
              disabled={sending}
              style={on ? { background: m.color, borderColor: m.color } : undefined}
            >
              {m.short}
            </button>
          );
        })}
      </div>

      <div className="pt-scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="pt-empty">
            <div className="pt-empty__emoji">🪐</div>
            <p>说一句开个头,他们就围过来八卦。</p>
            <span>思考走 low、历史留 20 条、不带日记贴纸——就是玩,不烧订阅。</span>
          </div>
        ) : null}

        {turns.map((t) => {
          if (t.speaker === 'user') {
            return (
              <div key={t.id} className="pt-row is-user">
                <div className="pt-bubble pt-bubble--user">{t.content}</div>
                <div className="pt-foot">{dayjs(t.at)}</div>
              </div>
            );
          }
          const m = findMember(t.speaker);
          const short = m?.short || '?';
          const color = m?.color || '#eee';
          return (
            <div key={t.id} className="pt-row is-cc">
              <span className="pt-badge" style={{ background: color }}>{short}</span>
              <div className={`pt-bubble pt-bubble--cc${t.status === 'streaming' ? ' is-streaming' : ''}${t.status === 'error' ? ' is-error' : ''}`}>
                {t.content || (t.status === 'streaming' ? '…' : '')}
              </div>
              <div className="pt-foot">{dayjs(t.at)}</div>
            </div>
          );
        })}

        {errorBanner ? <div className="pt-error">{errorBanner}</div> : null}
      </div>

      <div className="pt-composer">
        {sending ? (
          <button type="button" className="pt-btn pt-btn--stop" onClick={stop}>停下</button>
        ) : (
          <button
            type="button"
            className="pt-btn pt-btn--more"
            onClick={purrMore}
            disabled={turns.length === 0 || present.length === 0}
            title="让他们再接龙 4 回合"
          >
            🫧 再咕噜
          </button>
        )}
        <input
          className="pt-input"
          type="text"
          placeholder={present.length ? '你说一句…' : '至少留一位 CC 在场'}
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendUser();
            }
          }}
        />
        <button
          type="button"
          className="pt-btn pt-btn--send"
          onClick={sendUser}
          disabled={sending || !input.trim() || present.length === 0}
        >
          发
        </button>
      </div>
    </main>
  );
}
