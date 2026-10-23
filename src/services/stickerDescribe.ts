// 贴纸自动描述：新贴纸只让 CC 看一次图，写一句描述存进贴纸盒。
// 之后每轮聊天只发「名字（描述）」文字，不再把整盒图重新塞进上下文。

import { getMemeDataUrl, setMemeDescriptions, type MemeItem } from './memes';
import { streamChat } from './chat';

// 一次最多描述这么多张，贴纸多时分几轮慢慢补，单次请求别太大。
const BATCH = 12;
// 描述这种小活儿用订阅里最便宜的档。
const DESCRIBE_MODEL = 'haiku';
const DESC_MAX = 24;

let running: Promise<number> | null = null;
// 本次打开页面里已经试过的贴纸：失败了也不反复重试，下次打开页面再说。
const attempted = new Set<string>();

export function memesNeedingDesc(memes: MemeItem[]): MemeItem[] {
  return memes.filter((m) => m.name?.trim() && !m.desc?.trim());
}

// 从模型回复里抠出 {"名字":"描述"}；容忍前后多说的话和 ```json 包裹。
export function parseDescriptions(raw: string, batch: MemeItem[]): Record<string, string> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const byName = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const m of batch) {
    const value = byName[m.name.trim()];
    if (typeof value !== 'string') continue;
    const desc = value.replace(/\s+/g, ' ').trim().slice(0, DESC_MAX);
    if (desc) out[m.id] = desc;
  }
  return out;
}

async function describeBatch(batch: MemeItem[]): Promise<number> {
  const gallery: { name: string; dataUrl: string }[] = [];
  for (const m of batch) {
    const dataUrl = await getMemeDataUrl(m.id, 384);
    if (dataUrl) gallery.push({ name: m.name.trim(), dataUrl });
  }
  if (!gallery.length) return 0;
  let raw = '';
  let failed = false;
  await streamChat(
    {
      provider: 'claudecode',
      model: DESCRIBE_MODEL,
      memoryTools: false,
      stickerGallery: gallery,
      messages: [
        {
          role: 'system',
          content:
            `你在帮忙整理表情包。给贴纸盒里每张贴纸写一句不超过 ${DESC_MAX} 个字的中文描述：` +
            '画面里是谁/什么、什么表情或动作、适合什么情绪。只输出一个 JSON 对象，键是贴纸名字（一字不改），值是描述，不要别的话。',
        },
        { role: 'user', content: `贴纸名字：${gallery.map((g) => g.name).join('、')}` },
      ],
    },
    {
      onContent: (chunk) => {
        raw += chunk;
      },
      onError: () => {
        failed = true;
      },
    },
  );
  if (failed) return 0;
  const descs = parseDescriptions(raw, batch);
  await setMemeDescriptions(descs);
  return Object.keys(descs).length;
}

// 给还没描述的贴纸补描述，返回这次补了几张。同一时间只跑一个。
export function describeNewStickers(memes: MemeItem[]): Promise<number> {
  if (running) return running;
  const todo = memesNeedingDesc(memes).filter((m) => !attempted.has(m.id)).slice(0, BATCH);
  if (!todo.length) return Promise.resolve(0);
  for (const m of todo) attempted.add(m.id);
  running = describeBatch(todo)
    .catch(() => 0)
    .finally(() => {
      running = null;
    });
  return running;
}
