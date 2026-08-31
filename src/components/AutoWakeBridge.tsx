import { useEffect, useRef, useState } from 'react';
import { getModel } from '../data/models';
import {
  acknowledgeAutoWake,
  enableAutoWake,
  fetchAutoWakeInbox,
  getAutoWakeStatus,
  syncAutoWakeState,
  testAutoWake,
  type AutoWakeClientState,
  type AutoWakeInboxMessage,
  type AutoWakeStatus,
} from '../services/autowake';
import { buildSystemPrompt, loadPersona } from '../services/purrConfig';

const PREFIX = 'codeandpurrs:';
const WINDOWS_KEY = `${PREFIX}purr-channel:windows`;
const turnsKey = (id: string) => `${PREFIX}purr-channel:turns:${id}`;

type WindowMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  provider?: string;
};

type StoredTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  status?: 'streaming' | 'done' | 'error';
  meme?: string;
  photo?: string;
  redPacket?: { amount: number; note: string; from: 'user' | 'ai' };
  at?: number;
  autoWakeId?: string;
};

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function textOf(turn: StoredTurn): string {
  if (turn.meme) return '[发了一张表情包]';
  if (turn.photo) return '[发了一张照片]';
  if (turn.redPacket) return `[发了一个红包：${turn.redPacket.amount}，${turn.redPacket.note || '没有留言'}]`;
  return String(turn.content || '').trim();
}

function latestState(): AutoWakeClientState | null {
  const windows = readLocal<WindowMeta[]>(WINDOWS_KEY, []);
  const win = [...windows]
    .filter((item) => item?.id)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
  if (!win) return null;
  const turns = readLocal<StoredTurn[]>(turnsKey(win.id), []);
  const modelId = win.provider || 'deepseek';
  const model = getModel(modelId);
  const recent = turns
    .filter((turn) => turn.status !== 'error' && (turn.role === 'user' || turn.role === 'assistant'))
    .map((turn) => ({ role: turn.role, content: textOf(turn) }))
    .filter((item) => item.content)
    .slice(-20);
  const userTurns = turns.filter((turn) => turn.role === 'user' && Number(turn.at || 0) > 0);
  const assistantTurns = turns.filter((turn) => turn.role === 'assistant' && Number(turn.at || 0) > 0);
  const persona = loadPersona(model.brand);
  return {
    windowId: win.id,
    windowName: win.name || '呼噜频道',
    assistantName: persona.name || '',
    modelId,
    provider: model.provider,
    model: model.model,
    systemPrompt: buildSystemPrompt(modelId),
    messages: recent,
    lastUserAt: Number(userTurns[userTurns.length - 1]?.at || 0),
    lastAssistantAt: Number(assistantTurns[assistantTurns.length - 1]?.at || 0),
  };
}

function deliver(messages: AutoWakeInboxMessage[]): string[] {
  if (!messages.length) return [];
  const windows = readLocal<WindowMeta[]>(WINDOWS_KEY, []);
  const byId = new Map(windows.map((item) => [item.id, item]));
  const delivered: string[] = [];

  for (const item of messages) {
    if (!item?.id || !item.windowId || !item.content) continue;
    const key = turnsKey(item.windowId);
    const turns = readLocal<StoredTurn[]>(key, []);
    if (!turns.some((turn) => turn.autoWakeId === item.id)) {
      turns.push({
        id: `autowake-${item.id}`,
        autoWakeId: item.id,
        role: 'assistant',
        content: item.content,
        reasoning: '',
        status: 'done',
        at: item.at || Date.now(),
      });
      writeLocal(key, turns);
    }
    const current = byId.get(item.windowId);
    if (current) {
      byId.set(item.windowId, {
        ...current,
        updatedAt: Math.max(Number(current.updatedAt || 0), Number(item.at || Date.now())),
        preview: item.content.slice(0, 24),
      });
    }
    delivered.push(item.id);
  }
  writeLocal(WINDOWS_KEY, [...byId.values()]);
  window.dispatchEvent(new CustomEvent('codeandpurrs:autowake-delivered'));
  return delivered;
}

export function AutoWakeBridge() {
  const [status, setStatus] = useState<AutoWakeStatus>('off');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const syncing = useRef(false);

  const refreshInbox = async () => {
    try {
      const ids = deliver(await fetchAutoWakeInbox());
      await acknowledgeAutoWake(ids);
    } catch {
      // 收件箱会在下次打开/轮询继续领，短暂网络错误不会丢消息。
    }
  };

  const sync = async () => {
    if (syncing.current) return;
    const state = latestState();
    if (!state) return;
    syncing.current = true;
    try {
      if (await syncAutoWakeState(state)) setStatus('on');
    } catch {
      // 背景同步失败不打扰正常聊天，下轮再补。
    } finally {
      syncing.current = false;
    }
  };

  useEffect(() => {
    let alive = true;
    void getAutoWakeStatus().then((next) => alive && setStatus(next));
    void refreshInbox();
    void sync();
    const timer = window.setInterval(() => {
      void refreshInbox();
      void sync();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshInbox();
      void sync();
    };
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'codeandpurrs:autowake') void refreshInbox();
    };
    const onStorageChanged = () => void sync();
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    window.addEventListener('codeandpurrs:storage', onStorageChanged);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      window.removeEventListener('codeandpurrs:storage', onStorageChanged);
    };
    // 初始化一次，后续由事件和定时同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const enable = async () => {
    if (busy) return;
    const state = latestState();
    if (!state) {
      setNotice('去呼噜频道聊几句、选好想让谁主动找你，再回来开启');
      return;
    }
    if (status === 'on') {
      setNotice('真后台自动唤醒已经开着啦');
      return;
    }
    if (status === 'blocked') {
      setNotice('浏览器把通知拦住了：点地址栏网站设置，把通知改成允许');
      return;
    }
    setBusy(true);
    try {
      await enableAutoWake(state);
      setStatus('on');
      setNotice('自动唤醒已开启，后台正在送一条测试消息');
      void testAutoWake().catch((err) => setNotice(`已开启；测试消息：${String((err as Error)?.message || err)}`));
    } catch (err) {
      setStatus(await getAutoWakeStatus());
      setNotice(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'unsupported' || status === 'on') {
    return notice ? <div className="autowake-toast">{notice}</div> : null;
  }

  return (
    <>
      <button
        type="button"
        className={`autowake-enable is-${status}`}
        onClick={() => void enable()}
        disabled={busy}
        aria-label="开启真正的后台自动唤醒"
      >
        <span aria-hidden="true">{busy ? '…' : '🔔'}</span>
        <span>{status === 'blocked' ? '允许通知后自动找你' : '开启自动唤醒'}</span>
      </button>
      {notice ? <div className="autowake-toast">{notice}</div> : null}
    </>
  );
}
