const STORAGE_PREFIX = 'codeandpurrs:';
const WINDOWS_KEY = `${STORAGE_PREFIX}purr-channel:windows`;
const LEGACY_TURNS_KEY = `${STORAGE_PREFIX}purr-channel:turns`;
const TURNS_PREFIX = `${STORAGE_PREFIX}purr-channel:turns:`;
const SUMMARY_PREFIX = `${STORAGE_PREFIX}purr-channel:rolling-summary:`;
const SETTINGS_PREFIX = `${STORAGE_PREFIX}purr-channel:`;

export type WindowMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  provider?: string;
};

export type ExportTurn = {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  reasoning?: string;
  memo?: string;
  errorDetail?: string;
  editHistory?: string[];
  status?: string;
  at?: number;
  [key: string]: unknown;
};

export type WindowCargo = {
  meta: WindowMeta;
  turns: ExportTurn[];
  summary?: unknown;
  tokenEstimate: number;
};

export type ExportPodSnapshot = {
  windows: WindowCargo[];
  messageCount: number;
  tokenEstimate: number;
};

type ExportPodBackup = {
  app: 'CodeAndPurrs';
  kind: 'purr-channel-backup';
  version: 2;
  exportedAt: string;
  note: string;
  windows: Array<{
    meta: WindowMeta;
    turns: ExportTurn[];
    summary?: unknown;
  }>;
  settings: Record<string, string>;
};

export type RestoreMode = 'merge' | 'replace';

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isWindowMeta(value: unknown): value is WindowMeta {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WindowMeta>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number'
  );
}

function isTurn(value: unknown): value is ExportTurn {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ExportTurn>;
  return (
    typeof item.id === 'string' &&
    (item.role === 'user' || item.role === 'assistant')
  );
}

function visibleTurnText(turn: ExportTurn): string {
  const history = Array.isArray(turn.editHistory) ? turn.editHistory.join('\n') : '';
  return [turn.content, turn.reasoning, turn.memo, turn.errorDetail, history]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

/**
 * A deliberately conservative local estimate, not a provider bill.
 * CJK/emoji/punctuation tend toward one token; latin/numeric runs average ~4 chars.
 */
export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  const units = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{Extended_Pictographic}\p{Emoji_Presentation}]|[A-Za-z0-9]+(?:['_-][A-Za-z0-9]+)*|[^\s]/gu,
  );
  if (!units) return 0;
  return units.reduce((total, unit) => {
    if (/^[A-Za-z0-9]/.test(unit)) return total + Math.max(1, Math.ceil(unit.length / 4));
    return total + 1;
  }, 0);
}

function readTurns(windowId: string): ExportTurn[] {
  const parsed = safeParse<unknown[]>(localStorage.getItem(`${TURNS_PREFIX}${windowId}`), []);
  return Array.isArray(parsed) ? parsed.filter(isTurn) : [];
}

export function readExportPodSnapshot(): ExportPodSnapshot {
  const parsed = safeParse<unknown[]>(localStorage.getItem(WINDOWS_KEY), []);
  const metas = Array.isArray(parsed) ? parsed.filter(isWindowMeta) : [];
  const windows = metas.map<WindowCargo>((meta) => {
    const turns = readTurns(meta.id);
    const summary = safeParse<unknown>(localStorage.getItem(`${SUMMARY_PREFIX}${meta.id}`), undefined);
    return {
      meta,
      turns,
      summary,
      tokenEstimate: turns.reduce((sum, turn) => sum + estimateTokens(visibleTurnText(turn)), 0),
    };
  });
  return {
    windows,
    messageCount: windows.reduce((sum, item) => sum + item.turns.length, 0),
    tokenEstimate: windows.reduce((sum, item) => sum + item.tokenEstimate, 0),
  };
}

export function findWindowCargo(snapshot: ExportPodSnapshot, windowId: string): WindowCargo | null {
  if (!windowId) return null;
  return snapshot.windows.find((item) => item.meta.id === windowId) ?? null;
}

function collectSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      !key ||
      !key.startsWith(SETTINGS_PREFIX) ||
      key === WINDOWS_KEY ||
      key === LEGACY_TURNS_KEY ||
      key.startsWith(TURNS_PREFIX) ||
      key.startsWith(SUMMARY_PREFIX)
    ) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value !== null) settings[key.slice(STORAGE_PREFIX.length)] = value;
  }
  return settings;
}

export function makeBackup(snapshot: ExportPodSnapshot): ExportPodBackup {
  return {
    app: 'CodeAndPurrs',
    kind: 'purr-channel-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    note: 'Token counts are local estimates. Photos, voice blobs and sticker originals stored in IndexedDB are not embedded.',
    windows: snapshot.windows.map(({ meta, turns, summary }) => ({ meta, turns, summary })),
    settings: collectSettings(),
  };
}

export function parseBackup(raw: string): ExportPodBackup {
  const value = JSON.parse(raw) as Partial<ExportPodBackup>;
  if (
    value.app !== 'CodeAndPurrs' ||
    value.kind !== 'purr-channel-backup' ||
    value.version !== 2 ||
    !Array.isArray(value.windows) ||
    !value.windows.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        isWindowMeta(item.meta) &&
        Array.isArray(item.turns) &&
        item.turns.every(isTurn),
    ) ||
    !value.settings ||
    typeof value.settings !== 'object'
  ) {
    throw new Error('invalid-backup');
  }
  return value as ExportPodBackup;
}

function mergeTurns(local: ExportTurn[], incoming: ExportTurn[]): ExportTurn[] {
  const byId = new Map(local.map((turn) => [turn.id, turn]));
  for (const turn of incoming) if (!byId.has(turn.id)) byId.set(turn.id, turn);
  return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function clearChatStorage(): void {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key &&
      (key === WINDOWS_KEY ||
        key === LEGACY_TURNS_KEY ||
        key.startsWith(TURNS_PREFIX) ||
        key.startsWith(SUMMARY_PREFIX))
    ) {
      keys.push(key);
    }
  }
  keys.forEach((key) => localStorage.removeItem(key));
}

export function restoreBackup(backup: ExportPodBackup, mode: RestoreMode): number {
  const existing = readExportPodSnapshot();
  if (mode === 'replace') clearChatStorage();

  const byId = new Map<string, WindowMeta>();
  if (mode === 'merge') existing.windows.forEach((item) => byId.set(item.meta.id, item.meta));

  for (const incoming of backup.windows) {
    const previous = byId.get(incoming.meta.id);
    byId.set(
      incoming.meta.id,
      previous && previous.updatedAt > incoming.meta.updatedAt ? previous : incoming.meta,
    );
    const currentTurns = mode === 'merge' ? readTurns(incoming.meta.id) : [];
    localStorage.setItem(
      `${TURNS_PREFIX}${incoming.meta.id}`,
      JSON.stringify(mode === 'merge' ? mergeTurns(currentTurns, incoming.turns) : incoming.turns),
    );
    if (incoming.summary !== undefined) {
      localStorage.setItem(`${SUMMARY_PREFIX}${incoming.meta.id}`, JSON.stringify(incoming.summary));
    }
  }

  localStorage.setItem(WINDOWS_KEY, JSON.stringify([...byId.values()]));
  for (const [key, value] of Object.entries(backup.settings)) {
    if (!key.startsWith('purr-channel:')) continue;
    const storageKey = `${STORAGE_PREFIX}${key}`;
    if (mode === 'replace' || localStorage.getItem(storageKey) === null) {
      localStorage.setItem(storageKey, value);
    }
  }
  return byId.size;
}

export function clearLocalChats(): void {
  clearChatStorage();
}

export function downloadText(filename: string, mime: string, content: string): void {
  const isPlainText = mime === 'text/plain' || mime === 'text/markdown';
  const normalized = isPlainText ? content.replace(/\r?\n/g, '\r\n') : content;
  const payload = isPlainText ? `\uFEFF${normalized}` : normalized;
  const blob = new Blob([payload], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(input: string, fallback: string): string {
  const cleaned = input.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 64);
  return cleaned || fallback;
}

export function timestampSlug(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '时间未记录';
}

function turnBody(turn: ExportTurn): string {
  const content = typeof turn.content === 'string' && turn.content ? turn.content : '（非文字消息）';
  const reasoning = typeof turn.reasoning === 'string' && turn.reasoning ? `\n\n> 思考记录：${turn.reasoning}` : '';
  return `${content}${reasoning}`;
}

export function windowToMarkdown(window: WindowCargo): string {
  const head = `# ${window.meta.name || '未命名窗口'}\n\n- 模型：${window.meta.provider ?? '跟随默认'}\n- 消息：${window.turns.length}\n- 估算 Token：≈${window.tokenEstimate.toLocaleString()}\n- 更新：${formatTime(window.meta.updatedAt)}\n\n---\n`;
  const body = window.turns
    .map((turn) => `\n## ${turn.role === 'user' ? 'Neko' : '予予'} · ${formatTime(turn.at)}\n\n${turnBody(turn)}\n`)
    .join('');
  return `${head}${body}`;
}

export function windowToText(window: WindowCargo): string {
  const head = `${window.meta.name || '未命名窗口'}\n模型：${window.meta.provider ?? '跟随默认'}\n消息：${window.turns.length}\n估算 Token：≈${window.tokenEstimate.toLocaleString()}\n更新：${formatTime(window.meta.updatedAt)}\n${'—'.repeat(24)}\n`;
  const body = window.turns
    .map((turn) => `\n[${formatTime(turn.at)}] ${turn.role === 'user' ? 'Neko' : '予予'}\n${turnBody(turn)}\n`)
    .join('');
  return `${head}${body}`;
}
