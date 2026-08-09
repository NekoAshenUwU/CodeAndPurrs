import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
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
const CARGO_PAGE_SIZE = 6;
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

export function ExportPodPage() {
  const navigate = useNavigate();
  const timeOfDay = useTimeOfDay();
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const resolvedTheme = theme === 'auto' ? (timeOfDay === 'night' ? 'night' : 'day') : theme;
  const [snapshot, setSnapshot] = useState<ExportPodSnapshot>(() => readExportPodSnapshot());
  const [selectedId, setSelectedId] = useState('');
  const [cargoPage, setCargoPage] = useState(0);
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
  const cargoPageCount = Math.max(1, Math.ceil(snapshot.windows.length / CARGO_PAGE_SIZE));
  const visibleCargo = useMemo(
    () => snapshot.windows.slice(cargoPage * CARGO_PAGE_SIZE, (cargoPage + 1) * CARGO_PAGE_SIZE),
    [cargoPage, snapshot.windows],
  );

  useEffect(() => {
    setCargoPage((current) => Math.min(current, cargoPageCount - 1));
  }, [cargoPageCount]);

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 主题仍可在当前页面切换。
    }
  };

  const goToCargoPage = (nextPage: number) => {
    const bounded = Math.max(0, Math.min(nextPage, cargoPageCount - 1));
    setCargoPage(bounded);
    const nextSelected = snapshot.windows[bounded * CARGO_PAGE_SIZE];
    if (nextSelected) setSelectedId(nextSelected.meta.id);
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

  const exportSelectedJson = () => {
    if (!selected) {
      setNotice({ tone: 'info', text: '这里还没有可以单独封装的记忆匣。' });
      return;
    }
    const backup = makeBackup({
      windows: [selected],
      messageCount: selected.turns.length,
      tokenEstimate: selected.tokenEstimate,
    });
    const stem = safeFilename(selected.meta.name, selected.meta.id);
    downloadText(`${stem}-${timestampSlug()}.json`, 'application/json', JSON.stringify(backup, null, 2));
    setNotice({ tone: 'ok', text: `「${selected.meta.name}」已装进独立 JSON 记忆匣。` });
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
        <section className="pod-cargo-bay" aria-labelledby="pod-cargo-title">
          <div className="pod-gate" aria-hidden="true">
            <span className="pod-gate__corner pod-gate__corner--tl" />
            <span className="pod-gate__corner pod-gate__corner--tr" />
            <span className="pod-gate__corner pod-gate__corner--bl" />
            <span className="pod-gate__corner pod-gate__corner--br" />
            <span className="pod-gate__scan" />
          </div>

          <div className="pod-gate__readout">
            <small id="pod-cargo-title">MEMORY CARGO</small>
            <strong><i>≈</i>{formatTokens(snapshot.tokenEstimate)}</strong>
            <em>TOKENS</em>
          </div>

          <button
            type="button"
            className="pod-launch"
            onClick={exportAll}
            disabled={!snapshot.windows.length}
            aria-label={`封装全部，${snapshot.windows.length} 个窗口，估算约 ${snapshot.tokenEstimate} token`}
          >
            <span aria-hidden="true">✦</span>
            <strong>封装全部</strong>
            <small>EXPORT ALL</small>
          </button>

          <div className="pod-cargo-summary" aria-label="聊天备份舱单">
            <span><strong>{snapshot.windows.length}</strong> 个记忆匣</span>
            <i aria-hidden="true" />
            <span><strong>{snapshot.messageCount}</strong> 条消息</span>
          </div>

          <div className="pod-conveyor" aria-hidden="true">
            <span />
            <i />
            <b />
          </div>

          {snapshot.windows.length ? (
            <div className="pod-cargo-rack" role="list" aria-label="等待装载的聊天记忆匣">
              {visibleCargo.map((item, index) => {
                const cargoIndex = cargoPage * CARGO_PAGE_SIZE + index;
                const active = selected?.meta.id === item.meta.id;
                const visual = modelVisual(item.meta.provider);
                const fill = maxWindowTokens > 0 ? Math.max(7, Math.round((item.tokenEstimate / maxWindowTokens) * 100)) : 7;
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={item.meta.id}
                    className={`pod-cargo${active ? ' is-active' : ''}`}
                    style={{
                      '--cargo-index': cargoIndex,
                      '--cargo-fill': `${fill}%`,
                      '--cargo-a': visual.colors[0],
                      '--cargo-b': visual.colors[1],
                      '--cargo-c': visual.colors[2],
                      '--cargo-ring': visual.ring,
                    } as CSSProperties}
                    onClick={() => setSelectedId(item.meta.id)}
                    aria-pressed={active}
                    aria-label={`${item.meta.name}，${visual.label}，估算约 ${item.tokenEstimate} token，${item.turns.length} 条消息`}
                  >
                    <span className="pod-cargo__latch" aria-hidden="true" />
                    <span className="pod-cargo__serial">CARGO {String(cargoIndex + 1).padStart(2, '0')}</span>
                    <span className="pod-cargo__body">
                      <small>{visual.label}</small>
                      <strong>{item.meta.name || '未命名窗口'}</strong>
                      <i>{item.turns.length} 条消息</i>
                    </span>
                    <span className="pod-cargo__weight">
                      <small>记忆重量</small>
                      <strong><i>≈</i>{formatTokens(item.tokenEstimate)}</strong>
                      <em>TOKENS</em>
                    </span>
                    <span className="pod-cargo__meter" aria-hidden="true"><i /></span>
                    <span className="pod-cargo__route" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="pod-cargo-empty">货架空着，第一段聊天会成为第一枚记忆匣。</div>
          )}

          {snapshot.windows.length > CARGO_PAGE_SIZE ? (
            <nav className="pod-cargo-pages" aria-label="记忆匣货架分页">
              <button type="button" onClick={() => goToCargoPage(cargoPage - 1)} disabled={cargoPage === 0} aria-label="上一页记忆匣">‹</button>
              <span><strong>{String(cargoPage + 1).padStart(2, '0')}</strong> / {String(cargoPageCount).padStart(2, '0')}</span>
              <button type="button" onClick={() => goToCargoPage(cargoPage + 1)} disabled={cargoPage === cargoPageCount - 1} aria-label="下一页记忆匣">›</button>
            </nav>
          ) : null}
          <p className="pod-token-note">卡匣内的光量代表文字重量 · Token 为本地估算</p>
        </section>

        <section className="pod-dock" aria-label="单窗口导出与旧备份返航控制台">
          <div className="pod-dock__head">
            <span className="pod-dock__glyph" aria-hidden="true">⌁</span>
            <div>
              <small>出舱台 · SELECTED CARGO</small>
              <strong>{selected?.meta.name || '还没有聊天窗口'}</strong>
              {selected ? (
                <em>{modelVisual(selected.meta.provider).label} · {selected.turns.length} 条 · ≈{formatTokens(selected.tokenEstimate)} tokens</em>
              ) : null}
            </div>
          </div>

          <div className="pod-dock__actions">
            <button type="button" onClick={() => exportSelected('md')} disabled={!selected} aria-label="导出 Markdown">MD</button>
            <button type="button" onClick={() => exportSelected('txt')} disabled={!selected} aria-label="导出纯文字 TXT">TXT</button>
            <button type="button" onClick={exportSelectedJson} disabled={!selected} aria-label="导出独立 JSON">JSON</button>
          </div>

          <details className="pod-restore">
            <summary><span aria-hidden="true">↺</span> 返航舱</summary>
            <div className="pod-restore__body">
              <div className="pod-segment" aria-label="恢复方式">
                <button type="button" className={restoreMode === 'merge' ? 'is-active' : ''} onClick={() => setRestoreMode('merge')}>合并</button>
                <button type="button" className={restoreMode === 'replace' ? 'is-active' : ''} onClick={() => setRestoreMode('replace')}>替换</button>
              </div>
              <p>{restoreMode === 'merge' ? '保留本机窗口，补进缺少的消息。' : '用备份覆盖本机聊天与调频设定。'}</p>
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
              <button type="button" className="pod-upload" onClick={() => fileRef.current?.click()}>＋ 选择 JSON 备份</button>
            </div>
          </details>
        </section>

        <footer className="pod-footer">
          <span>私密聊天只装进你下载的文件里。</span>
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
