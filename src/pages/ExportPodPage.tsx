import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTimeOfDay } from '../components/ambient/timeOfDay';
import {
  clearLocalChats,
  downloadText,
  makeBackup,
  parseBackup,
  readExportPodSnapshot,
  restoreBackup,
  safeFilename,
  timestampSlug,
  windowToMarkdown,
  windowToText,
  type ExportPodSnapshot,
  type RestoreMode,
} from '../services/exportPod';
import '../styles/export-pod.css';

type ThemeChoice = 'auto' | 'day' | 'night';
type Notice = { tone: 'ok' | 'error' | 'info'; text: string } | null;
type ModelVisual = {
  key: string;
  label: string;
  colors: [string, string, string];
  ring: string;
};

const THEME_KEY = 'codeandpurrs:export-pod:theme';
const THEME_ORDER: ThemeChoice[] = ['auto', 'day', 'night'];
const THEME_META: Record<ThemeChoice, { icon: string; label: string }> = {
  auto: { icon: '✦', label: '跟随时间' },
  day: { icon: '☼', label: '白日舱' },
  night: { icon: '☾', label: '月夜舱' },
};

const MODEL_VISUALS: Array<{ match: RegExp; visual: ModelVisual }> = [
  {
    match: /(?:chatgpt-)?gpt-?4o/i,
    visual: { key: 'gpt-4o', label: 'GPT-4o', colors: ['#7af2da', '#5ab7d9', '#ce8ff0'], ring: '#b7fff2' },
  },
  {
    match: /(?:^|[-_])o3(?:$|[-_])/i,
    visual: { key: 'o3', label: 'o3', colors: ['#6bd4ff', '#6875ed', '#9d74e8'], ring: '#a9e8ff' },
  },
  {
    match: /deep\s*seek.*(?:v4)?.*flash|v4[-_ ]?flash/i,
    visual: { key: 'deepseek-v4-flash', label: 'V4 Flash', colors: ['#78f4e2', '#48c7db', '#8ee995'], ring: '#b7fff0' },
  },
  {
    match: /deep\s*seek.*(?:v4)?.*pro|v4[-_ ]?pro/i,
    visual: { key: 'deepseek-v4-pro', label: 'V4 Pro', colors: ['#60d5ff', '#4f7ce8', '#705bd5'], ring: '#9ce8ff' },
  },
  {
    match: /deep\s*seek/i,
    visual: { key: 'deepseek', label: 'DeepSeek', colors: ['#71e1ff', '#5583e9', '#755fd4'], ring: '#a8efff' },
  },
  {
    match: /(?:cc[-_ ]?p|jiake|claude.?code).*opus.*4[-_. ]?6|jiake-opus-4-6/i,
    visual: { key: 'ccp-opus-4.6', label: 'CC-P 4.6', colors: ['#ffd39b', '#ef9e91', '#c88ad8'], ring: '#ffe2b5' },
  },
  {
    match: /(?:cc[-_ ]?p|jiake|claude.?code).*opus.*4[-_. ]?7|jiake-opus-4-7/i,
    visual: { key: 'ccp-opus-4.7', label: 'CC-P 4.7', colors: ['#f3a4da', '#b27be5', '#7d79df'], ring: '#ffc1ec' },
  },
  {
    match: /(?:cc[-_ ]?p|jiake|claude.?code).*opus.*4[-_. ]?8|jiake-opus-4-8/i,
    visual: { key: 'ccp-opus-4.8', label: 'CC-P 4.8', colors: ['#9ad5ff', '#8d8af2', '#bd79d9'], ring: '#c8e6ff' },
  },
  {
    match: /(?:cc[-_ ]?p|jiake|claude.?code).*opus.*5|jiake-opus-5/i,
    visual: { key: 'ccp-opus-5', label: 'CC-P 5', colors: ['#d4b4ff', '#8060d6', '#f0b86d'], ring: '#ebd8ff' },
  },
];

const DEFAULT_MODEL_VISUAL: ModelVisual = {
  key: 'default',
  label: '跟随默认',
  colors: ['#f2d9ff', '#a98cda', '#efa6c9'],
  ring: '#fff0ff',
};

function modelVisual(provider?: string): ModelVisual {
  if (!provider) return DEFAULT_MODEL_VISUAL;
  return MODEL_VISUALS.find(({ match }) => match.test(provider))?.visual ?? {
    ...DEFAULT_MODEL_VISUAL,
    key: provider,
    label: provider,
  };
}

function loadTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'auto' || saved === 'day' || saved === 'night') return saved;
  } catch {
    // 本地存储被浏览器禁用时继续使用自动主题。
  }
  return 'auto';
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function bubbleSize(value: number, max: number): number {
  if (max <= 0) return 68;
  return Math.round(57 + Math.sqrt(value / max) * 54);
}

export function ExportPodPage() {
  const navigate = useNavigate();
  const timeOfDay = useTimeOfDay();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const resolvedTheme = theme === 'auto' ? (timeOfDay === 'night' ? 'night' : 'day') : theme;
  const [snapshot, setSnapshot] = useState<ExportPodSnapshot>(() => readExportPodSnapshot());
  const [selectedId, setSelectedId] = useState('');
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [notice, setNotice] = useState<Notice>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const next = readExportPodSnapshot();
    setSnapshot(next);
    setSelectedId((current) => {
      if (next.windows.some((item) => item.meta.id === current)) return current;
      return next.windows[0]?.meta.id ?? '';
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = useMemo(
    () => snapshot.windows.find((item) => item.meta.id === selectedId) ?? snapshot.windows[0] ?? null,
    [selectedId, snapshot.windows],
  );
  const maxWindowTokens = useMemo(
    () => Math.max(0, ...snapshot.windows.map((item) => item.tokenEstimate)),
    [snapshot.windows],
  );
  const visibleModelVisuals = useMemo(() => {
    const unique = new Map<string, ModelVisual>();
    snapshot.windows.forEach((item) => {
      const visual = modelVisual(item.meta.provider);
      unique.set(visual.key, visual);
    });
    return [...unique.values()];
  }, [snapshot.windows]);

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 主题仍可在当前页面切换。
    }
  };

  const exportAll = () => {
    if (!snapshot.windows.length) {
      setNotice({ tone: 'info', text: '记忆舱还是空的，聊过以后再来封装。' });
      return;
    }
    const backup = makeBackup(snapshot);
    const filename = `codeandpurrs-${timestampSlug()}.json`;
    downloadText(filename, 'application/json', JSON.stringify(backup, null, 2));
    setNotice({ tone: 'ok', text: `封装完成：${snapshot.windows.length} 个窗口已经落进 ${filename}` });
  };

  const exportSelected = (kind: 'md' | 'txt') => {
    if (!selected) {
      setNotice({ tone: 'info', text: '这里还没有可以单独带走的窗口。' });
      return;
    }
    const stem = safeFilename(selected.meta.name, selected.meta.id);
    if (kind === 'md') {
      downloadText(`${stem}.md`, 'text/markdown', windowToMarkdown(selected));
    } else {
      downloadText(`${stem}.txt`, 'text/plain', windowToText(selected));
    }
    setNotice({ tone: 'ok', text: `「${selected.meta.name}」已经导出为 ${kind.toUpperCase()}。` });
  };

  const importFile = async (file: File) => {
    try {
      const backup = parseBackup(await file.text());
      const count = restoreBackup(backup, restoreMode);
      refresh();
      setNotice({
        tone: 'ok',
        text: restoreMode === 'merge' ? `旧备份已合并，现在共有 ${count} 个窗口。` : `已用备份替换为 ${count} 个窗口。`,
      });
    } catch {
      setNotice({ tone: 'error', text: '这不是导出舱 v2 的有效备份，文件没有被写入。' });
    }
  };

  const clearChats = () => {
    if (!snapshot.windows.length) return;
    if (!window.confirm('会移除这台设备上的全部聊天窗口、消息与滚动摘要。设定和已下载备份会保留。')) return;
    clearLocalChats();
    refresh();
    setNotice({ tone: 'ok', text: '本机聊天已经清空，调频设定仍在。' });
  };

  return (
    <main className="pod-page" data-theme={resolvedTheme}>
      <div className="pod-page__scene" aria-hidden="true" />
      <div className="pod-page__veil" aria-hidden="true" />

      <header className="pod-topbar">
        <button type="button" className="pod-icon-button" onClick={() => navigate('/')} aria-label="回到房间首页">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <div className="pod-topbar__title">
          <strong>导出舱</strong>
          <span>Export Pod</span>
        </div>
        <button
          type="button"
          className="pod-theme-button"
          onClick={cycleTheme}
          aria-label={`切换舱内光线，当前${THEME_META[theme].label}`}
        >
          <span aria-hidden="true">{THEME_META[theme].icon}</span>
          <small>{THEME_META[theme].label}</small>
        </button>
      </header>

      <div className="pod-shell">
        <section className="pod-core" aria-labelledby="pod-core-title">
          <div className="pod-core__glow" aria-hidden="true" />
          <div className="pod-core__content">
            <p className="pod-eyebrow">MEMORY CARGO · LOCAL ONLY</p>
            <h1 id="pod-core-title">把聊天装进星球</h1>
            <p className="pod-core__copy">留在这台设备，封装后由你亲手带走。</p>

            <div className="pod-core__meter" aria-label={`全部窗口估算约 ${snapshot.tokenEstimate} token`}>
              <span>全部窗口估算</span>
              <strong><i>≈</i>{formatTokens(snapshot.tokenEstimate)}</strong>
              <em>tokens</em>
            </div>

            <div className="pod-core__stats">
              <span><strong>{snapshot.windows.length}</strong> 个窗口</span>
              <span><strong>{snapshot.messageCount}</strong> 条消息</span>
            </div>

            <button type="button" className="pod-primary" onClick={exportAll} disabled={!snapshot.windows.length}>
              <span className="pod-primary__spark" aria-hidden="true">✦</span>
              封装全部 JSON
              <span className="pod-primary__arrow" aria-hidden="true">↗</span>
            </button>
            <p className="pod-core__fineprint">文字、模型与调频设定会装入；照片、语音和贴纸原图暂不嵌入。</p>
          </div>
        </section>

        <section className="pod-bubbles" aria-labelledby="pod-bubbles-title">
          <div className="pod-section-heading">
            <div>
              <p className="pod-eyebrow">TOKEN CONSTELLATION</p>
              <h2 id="pod-bubbles-title">窗口星泡带</h2>
            </div>
            <span>气泡越大，文字越多</span>
          </div>

          {snapshot.windows.length ? (
            <div className="pod-bubbles__rail" role="list" aria-label="聊天窗口 token 估算">
              {snapshot.windows.map((item, index) => {
                const size = bubbleSize(item.tokenEstimate, maxWindowTokens);
                const active = selected?.meta.id === item.meta.id;
                const visual = modelVisual(item.meta.provider);
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={item.meta.id}
                    className={`pod-bubble${active ? ' is-active' : ''}`}
                    style={{
                      '--bubble-size': `${size}px`,
                      '--bubble-index': index,
                      '--bubble-a': visual.colors[0],
                      '--bubble-b': visual.colors[1],
                      '--bubble-c': visual.colors[2],
                      '--bubble-ring': visual.ring,
                    } as CSSProperties}
                    onClick={() => setSelectedId(item.meta.id)}
                    aria-pressed={active}
                    aria-label={`${item.meta.name}，估算约 ${item.tokenEstimate} token，${item.turns.length} 条消息`}
                  >
                    <span className="pod-bubble__shine" aria-hidden="true" />
                    <strong>{formatTokens(item.tokenEstimate)}</strong>
                    <small>{item.meta.name || '未命名'}</small>
                    <i>{visual.label}</i>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="pod-bubbles__empty">
              <span aria-hidden="true">✧</span>
              第一颗聊天星泡会在这里亮起来。
            </div>
          )}
          <div className="pod-bubbles__meta">
            <div className="pod-model-legend" aria-label="窗口模型色彩图例">
              {visibleModelVisuals.map((visual) => (
                <span key={visual.key}>
                  <i
                    aria-hidden="true"
                    style={{ '--legend-a': visual.colors[0], '--legend-b': visual.colors[1] } as CSSProperties}
                  />
                  {visual.label}
                </span>
              ))}
            </div>
            <p className="pod-bubbles__note">≈ 本地启发式估算；不同模型的 tokenizer 会产生少量差异。</p>
          </div>
        </section>

        <section className="pod-actions" aria-label="导出与恢复工具">
          <article className="pod-card pod-card--take">
            <div className="pod-card__icon" aria-hidden="true">⌁</div>
            <div className="pod-card__body">
              <p className="pod-eyebrow">ONE WINDOW</p>
              <h2>单独带走一段</h2>
              {selected ? (
                <>
                  <div className="pod-selection">
                    <span>
                      <strong>{selected.meta.name || '未命名窗口'}</strong>
                      <small>{modelVisual(selected.meta.provider).label} · {selected.turns.length} 条消息 · ≈{formatTokens(selected.tokenEstimate)} tokens</small>
                    </span>
                    <em>已选择</em>
                  </div>
                  <div className="pod-card__buttons">
                    <button type="button" onClick={() => exportSelected('md')}>Markdown</button>
                    <button type="button" onClick={() => exportSelected('txt')}>纯文字 TXT</button>
                  </div>
                </>
              ) : (
                <p className="pod-card__empty">聊过以后，就能把某一段单独带去日记或笔记。</p>
              )}
            </div>
          </article>

          <article className="pod-card pod-card--restore">
            <div className="pod-card__icon" aria-hidden="true">↺</div>
            <div className="pod-card__body">
              <p className="pod-eyebrow">RETURN HOME</p>
              <h2>把旧备份装回来</h2>
              <div className="pod-segment" aria-label="恢复方式">
                <button type="button" className={restoreMode === 'merge' ? 'is-active' : ''} onClick={() => setRestoreMode('merge')}>
                  合并
                </button>
                <button type="button" className={restoreMode === 'replace' ? 'is-active' : ''} onClick={() => setRestoreMode('replace')}>
                  替换
                </button>
              </div>
              <p className="pod-card__hint">
                {restoreMode === 'merge' ? '保留本机窗口，只补进备份里缺少的消息。' : '用备份覆盖本机聊天；调频设定随备份恢复。'}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                  event.target.value = '';
                }}
              />
              <button type="button" className="pod-upload" onClick={() => fileRef.current?.click()}>
                <span aria-hidden="true">＋</span> 选择 JSON 备份
              </button>
            </div>
          </article>
        </section>

        <footer className="pod-footer">
          <span>备份文件请收好，它包含私密聊天内容。</span>
          <button type="button" onClick={clearChats} disabled={!snapshot.windows.length}>清空本机聊天</button>
        </footer>
      </div>

      {notice ? (
        <div className={`pod-notice pod-notice--${notice.tone}`} role="status">
          <span aria-hidden="true">{notice.tone === 'ok' ? '✓' : notice.tone === 'error' ? '!' : '✦'}</span>
          <p>{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
        </div>
      ) : null}
    </main>
  );
}
