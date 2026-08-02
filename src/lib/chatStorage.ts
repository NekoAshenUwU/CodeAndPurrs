export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type ChatSession = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type ChatBackup = {
  app: 'CodeAndPurrs';
  version: 1;
  exportedAt: number;
  currentModel: string;
  sessions: ChatSession[];
};

export const SESSIONS_KEY = 'codeandpurrs:sessions';
export const MODEL_KEY = 'codeandpurrs:currentModel';
export const DEFAULT_MODEL = 'deepseek-v4';

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false;
  const obj = m as ChatMessage;
  return (
    typeof obj.id === 'string' &&
    (obj.role === 'user' || obj.role === 'assistant') &&
    typeof obj.content === 'string' &&
    typeof obj.createdAt === 'number'
  );
}

function isValidSession(s: unknown): s is ChatSession {
  if (!s || typeof s !== 'object') return false;
  const obj = s as ChatSession;
  return (
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.model === 'string' &&
    typeof obj.createdAt === 'number' &&
    typeof obj.updatedAt === 'number' &&
    Array.isArray(obj.messages) &&
    obj.messages.every(isValidMessage)
  );
}

export function loadSessions(): ChatSession[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSession);
  } catch {
    return [];
  }
}

export function saveSessions(sessions: ChatSession[]) {
  const store = safeStorage();
  if (!store) return;
  store.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function loadCurrentModel(): string {
  const store = safeStorage();
  if (!store) return DEFAULT_MODEL;
  return store.getItem(MODEL_KEY) ?? DEFAULT_MODEL;
}

export function saveCurrentModel(model: string) {
  const store = safeStorage();
  if (!store) return;
  store.setItem(MODEL_KEY, model);
}

export function validateBackup(input: unknown): input is ChatBackup {
  if (!input || typeof input !== 'object') return false;
  const obj = input as ChatBackup;
  return (
    obj.app === 'CodeAndPurrs' &&
    obj.version === 1 &&
    typeof obj.exportedAt === 'number' &&
    typeof obj.currentModel === 'string' &&
    Array.isArray(obj.sessions) &&
    obj.sessions.every(isValidSession)
  );
}

export function clearAll() {
  const store = safeStorage();
  if (!store) return;
  store.removeItem(SESSIONS_KEY);
  store.removeItem(MODEL_KEY);
}
