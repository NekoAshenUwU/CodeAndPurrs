// 记忆罐头 Memory Jar —— 跨对话的长期记忆，存这台设备的 localStorage。
// AI 在聊天里用 [记忆:分类|内容] 记下重要的事，这里负责持久化；调频/聊天前会读进 system prompt。

import { loadLocal, saveLocal } from './storage';

export type Memory = {
  id: string;
  text: string;
  category: string;
  createdAt: number;
  updatedAt: number;
};

const KEY = 'memory-jar:items';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const loadMemories = (): Memory[] => loadLocal<Memory[]>(KEY, []);
const persist = (list: Memory[]) => saveLocal(KEY, list);

// 新增一条记忆（同分类同内容会去重，不重复存）。返回最终那条。
export function addMemory(category: string, text: string): Memory | null {
  const body = text.trim();
  if (!body) return null;
  const cat = (category || '其它').trim() || '其它';
  const list = loadMemories();
  const dup = list.find((m) => m.text === body && m.category === cat);
  if (dup) return dup;
  const now = Date.now();
  const m: Memory = { id: uid(), text: body, category: cat, createdAt: now, updatedAt: now };
  persist([m, ...list]);
  return m;
}

export function updateMemory(id: string, patch: Partial<Pick<Memory, 'text' | 'category'>>): void {
  persist(
    loadMemories().map((m) =>
      m.id === id
        ? { ...m, ...patch, category: (patch.category ?? m.category).trim() || '其它', updatedAt: Date.now() }
        : m,
    ),
  );
}

export function removeMemory(id: string): void {
  persist(loadMemories().filter((m) => m.id !== id));
}

// 所有出现过的分类（按记忆条数多到少）
export function listCategories(list: Memory[]): string[] {
  const count = new Map<string, number>();
  for (const m of list) count.set(m.category, (count.get(m.category) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
