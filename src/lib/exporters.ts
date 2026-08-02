import type { ChatBackup, ChatMessage, ChatSession } from './chatStorage';

export function makeBackup(sessions: ChatSession[], currentModel: string): ChatBackup {
  return {
    app: 'CodeAndPurrs',
    version: 1,
    exportedAt: Date.now(),
    currentModel,
    sessions,
  };
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function renderMessageMarkdown(m: ChatMessage): string {
  const label = m.role === 'user' ? '**You**' : '**AI**';
  return `${label}  \n_${fmtTime(m.createdAt)}_\n\n${m.content}`;
}

export function sessionToMarkdown(session: ChatSession): string {
  const header = [
    `# ${session.title || 'Untitled Session'}`,
    '',
    `- Model: ${session.model}`,
    `- Created: ${fmtTime(session.createdAt)}`,
    `- Updated: ${fmtTime(session.updatedAt)}`,
    '',
    '---',
    '',
  ].join('\n');
  const body = session.messages.map(renderMessageMarkdown).join('\n\n');
  return `${header}${body}\n`;
}

function renderMessageText(m: ChatMessage): string {
  const label = m.role === 'user' ? 'You' : 'AI';
  return `[${fmtTime(m.createdAt)}] ${label}:\n${m.content}`;
}

export function sessionToText(session: ChatSession): string {
  const header = [
    session.title || 'Untitled Session',
    `Model: ${session.model}`,
    `Created: ${fmtTime(session.createdAt)}`,
    `Updated: ${fmtTime(session.updatedAt)}`,
    '----',
    '',
  ].join('\n');
  const body = session.messages.map(renderMessageText).join('\n\n');
  return `${header}${body}\n`;
}

export function downloadBlob(name: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(input: string, fallback: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\w一-龥-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
