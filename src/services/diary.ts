// 长期记忆·日记本：后端 /api/diary 的小客户端。
// 内容写在 VPS 的 server/data/diary.md，家版(CC)聊天时自动注入到 system prompt。

export type DiaryInfo = {
  content: string;
  size: number;
  mtime: number;
};

export async function loadDiary(): Promise<DiaryInfo> {
  const res = await fetch('/api/diary');
  if (!res.ok) throw new Error(`读日记失败 HTTP ${res.status}`);
  return res.json();
}

export async function saveDiary(content: string): Promise<{ size: number; mtime: number }> {
  const res = await fetch('/api/diary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`写日记失败 HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}
