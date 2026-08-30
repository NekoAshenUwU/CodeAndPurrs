// 呼噜频道的小后端代理 —— 把 API key 藏在服务端，前端只跟这里说话。
// 零依赖：只用 Node 自带的 http + 全局 fetch（Node 18+）。
//
// 启动：node --env-file=.env server/proxy.mjs   （或 npm run dev:server）
// 没配 key 也能跑：自动进入 mock 模式，回一段假的流式消息，方便先调 UI。

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 主动加载 .env(不依赖 node CLI flag)——pm2 fork 模式不会真正 spawn 新 node,
// 而是从父进程 require 脚本,导致 --env-file-if-exists 这类 CLI flag 被无视,
// CLAUDE_CODE_OAUTH_TOKEN 永远进不来,整个 proxy 就一直走 mock。
// process.loadEnvFile 是 Node 20.6+ 自带,零依赖。
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // .env 不存在或不可读就跳过,mock 模式兜底
}

// 棠予酿：予予的日记（长期记忆）。把日记文本放进这个文件，家版(CC)每次聊天都会带上。
// 路径默认 server/data/diary.md，可用环境变量 DIARY_PATH 覆盖。
const DIARY_FILE = process.env.DIARY_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'diary.md');
function loadDiary() {
  try {
    if (existsSync(DIARY_FILE)) return readFileSync(DIARY_FILE, 'utf8').trim();
  } catch {
    /* 读不到就算了 */
  }
  return '';
}
function diaryStat() {
  try {
    const s = statSync(DIARY_FILE);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}
function saveDiary(text) {
  mkdirSync(dirname(DIARY_FILE), { recursive: true });
  writeFileSync(DIARY_FILE, text, 'utf8');
}

// 呼噜频道云端存档：聊天仍以浏览器本地为主，老婆按「存档」时才写进 VPS。
// API 必须带 X-Chat-Save-Key；密钥只放 .env，绝不烧进前端包或 GitHub。
const CHAT_SAVE_DIR = process.env.CHAT_SAVE_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data', 'chat-saves');
function validChatSaveId(id) {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}
function chatSaveFile(id) {
  if (!validChatSaveId(id)) throw new Error('存档编号无效');
  return join(CHAT_SAVE_DIR, `${id}.json`);
}
function hasChatSaveAccess(req) {
  const expected = String(process.env.CHAT_SAVE_KEY || '').trim();
  const supplied = String(req.headers['x-chat-save-key'] || '').trim();
  return Boolean(expected && supplied && supplied === expected);
}
function saveChatSnapshot(id, snapshot) {
  mkdirSync(CHAT_SAVE_DIR, { recursive: true });
  const target = chatSaveFile(id);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(snapshot), 'utf8');
  renameSync(temp, target);
}
function loadChatSnapshot(id) {
  const target = chatSaveFile(id);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, 'utf8'));
}
function listChatSnapshots() {
  if (!existsSync(CHAT_SAVE_DIR)) return [];
  return readdirSync(CHAT_SAVE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(CHAT_SAVE_DIR, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
}

// ---------- 他的歌单 · Spotify OAuth / Web Playback SDK ----------
// Token 永远留在 VPS；浏览器只拿短效 access token 给官方 Web Playback SDK。
// 每次 OAuth 登录分配独立随机 session cookie，避免公开站点上的访客覆盖老婆的账号。
const SPOTIFY_SESSION_FILE =
  process.env.SPOTIFY_SESSION_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'spotify-sessions.json');
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || 'https://nekopurrs.uk/api/spotify/callback';
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

function spotifyConfigured() {
  return Boolean(String(process.env.SPOTIFY_CLIENT_ID || '').trim() && String(process.env.SPOTIFY_CLIENT_SECRET || '').trim());
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((out, part) => {
      const at = part.indexOf('=');
      if (at > 0) out[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1));
      return out;
    }, {});
}

function spotifySessions() {
  try {
    if (existsSync(SPOTIFY_SESSION_FILE)) return JSON.parse(readFileSync(SPOTIFY_SESSION_FILE, 'utf8')) || {};
  } catch {
    /* 文件损坏时从空 session 开始，不能拖垮聊天代理 */
  }
  return {};
}

function saveSpotifySessions(sessions) {
  mkdirSync(dirname(SPOTIFY_SESSION_FILE), { recursive: true });
  const temp = `${SPOTIFY_SESSION_FILE}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(sessions), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, SPOTIFY_SESSION_FILE);
}

function spotifySessionFor(req) {
  const sid = parseCookies(req).cp_spotify_session;
  if (!sid || !/^[a-f0-9]{48}$/.test(sid)) return { sid: '', session: null };
  const sessions = spotifySessions();
  return { sid, session: sessions[sid] || null };
}

async function refreshSpotifySession(sid, session) {
  if (session.accessToken && Number(session.expiresAt || 0) > Date.now() + 60_000) return session;
  if (!session.refreshToken) throw new Error('Spotify 登录已失效，请重新连接');
  const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || 'Spotify token 刷新失败');
  const next = {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  const sessions = spotifySessions();
  sessions[sid] = next;
  saveSpotifySessions(sessions);
  return next;
}

async function spotifyAccessFor(req) {
  const { sid, session } = spotifySessionFor(req);
  if (!sid || !session) throw new Error('Spotify 尚未连接');
  return refreshSpotifySession(sid, session);
}

function normalizeSpotifyTrack(track) {
  return {
    id: String(track?.id || ''),
    uri: String(track?.uri || ''),
    name: String(track?.name || ''),
    artist: Array.isArray(track?.artists) ? track.artists.map((artist) => artist.name).filter(Boolean).join('、') : '',
    album: String(track?.album?.name || ''),
    image: track?.album?.images?.[0]?.url || null,
    durationMs: Number(track?.duration_ms || 0),
  };
}

async function searchSpotify(accessToken, query, limit = 8) {
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Spotify 搜歌失败（${response.status}）`);
  return (data?.tracks?.items || []).filter((track) => track?.is_playable !== false).map(normalizeSpotifyTrack);
}

async function planSpotifyPick(prompt) {
  const key = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return { query: prompt, reason: '我按你此刻写下的心情，在曲库里挑最贴近的一首。', intensity: 'normal' };
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        max_tokens: 260,
        messages: [
          {
            role: 'system',
            content:
              '你是私人点歌人。根据用户当下的心情挑一首真实存在、容易在 Spotify 找到的歌。' +
              '只输出 JSON：{"query":"歌名 歌手","reason":"20到45字的中文点歌理由","intensity":"soft|normal|high"}。' +
              '不要输出 markdown，不要捏造歌曲。',
          },
          { role: 'user', content: String(prompt).slice(0, 500) },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('pick failed');
    const data = await response.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const intensity = ['soft', 'normal', 'high'].includes(parsed.intensity) ? parsed.intensity : 'normal';
    return {
      query: String(parsed.query || prompt).slice(0, 200),
      reason: String(parsed.reason || '这首歌适合陪着你现在的心情。').slice(0, 160),
      intensity,
    };
  } catch {
    return { query: prompt, reason: '我按你此刻写下的心情，在曲库里挑最贴近的一首。', intensity: 'normal' };
  }
}

// ---------- 棠予酿实时日记（从 /internal/diary/list 拉，兜底静态 diary.md）----------
// 聊天时拼进 system prompt。为了不撞坏 Anthropic prompt cache(那个要字节级
// 稳定才命中)，内容必须每次生成都一样：
//   1. 只放稳定字段(title/content)，不放 strength/activation_count/
//      last_activated_at 这些每次 SELECT 都会变的字段
//   2. 60 秒 in-memory 缓存，同一时间窗内连续聊天拿到完全一样的字符串
//   3. 只用 /internal/diary/list(纯 SELECT 无副作用)，不用 /internal/breathe
//      (那个每次调都 UPDATE activation_count，副作用大)
let _tangDiaryCache = { at: 0, text: '' };
const TANG_CACHE_MS = Number(process.env.DIARY_TANG_CACHE_MS || 60_000);
const TANG_LIMIT = Number(process.env.DIARY_TANG_LIMIT || 10);
// 单条日记超过这个字数就丢给 DeepSeek 摘要,只把要点塞进 system prompt。
// 老婆定的: 长日记原文喂给 Opus 太烧订阅额度,便宜的 DeepSeek 做摘要 + Opus 读要点
// 才对。0 = 关摘要走原文。
const TANG_SUMMARY_THRESHOLD = Number(process.env.DIARY_TANG_SUMMARY_CHARS || 400);

// 摘要 in-memory 缓存: 按日记 id + content 前 200 字 hash 做 key,避免同一条内容
// 反复调 DeepSeek。proxy 重启就清空,可接受(重跑一次几分钱)。
const _summaryCache = new Map();

async function summarizeDiaryEntry(id, title, content) {
  const cacheKey = `${id}:${content.slice(0, 200).length}:${content.length}`;
  if (_summaryCache.has(cacheKey)) return _summaryCache.get(cacheKey);
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!deepseekKey) return null;
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              '你是一个做要点提取的工具。把用户给的一段日记压缩成 80-120 字的中文要点摘要,' +
              '只保留:重要事件、约定、情绪、承诺、约会、关键细节。' +
              '不要复述细节流水账、不要加引言"这段日记讲了..."、不要客套话,只输出要点本身。',
          },
          { role: 'user', content: title ? `${title}\n${content}` : content },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (summary) _summaryCache.set(cacheKey, summary);
    return summary || null;
  } catch {
    return null;
  }
}

async function fetchTangDiary() {
  const key = (process.env.TANG_INTERNAL_KEY || '').trim();
  if (!key) return null; // 后端没配棠予酿 → 兜底走静态 diary.md
  const base = process.env.TANG_MCP_BASE_URL || 'http://127.0.0.1:8890';
  try {
    const r = await fetch(`${base}/internal/diary/list?limit=${TANG_LIMIT}`, {
      headers: { 'X-Internal-Key': key },
      signal: AbortSignal.timeout(2000), // 别让棠予酿卡住整个聊天
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return '';
    // 只取稳定字段(id/title/content/importance)拼,不含任何"读一次变一次"的
    // 东西。棠予酿 SQL 从 v6 起是 ORDER BY importance DESC, created_at DESC,
    // 重要度 9-10 的条目排前面,同一批调用返回顺序稳定。
    // 长条目(>TANG_SUMMARY_THRESHOLD 字符)丢给 DeepSeek 做要点摘要,只把要点
    // 塞进 system prompt——省一大截 Opus 输入 token。
    const parts = await Promise.all(
      rows.map(async (row) => {
        const id = String(row.id || '');
        const title = String(row.title || '').trim();
        const content = String(row.content || '').trim();
        if (!content) return '';
        if (TANG_SUMMARY_THRESHOLD > 0 && content.length > TANG_SUMMARY_THRESHOLD) {
          const summary = await summarizeDiaryEntry(id, title, content);
          if (summary) return title ? `# ${title}\n${summary}` : summary;
        }
        return title ? `# ${title}\n${content}` : content;
      }),
    );
    return parts.filter(Boolean).join('\n\n');
  } catch {
    return null; // 超时/网络错/棠予酿挂 → 静态兜底
  }
}

// 60 秒内两次调用返回完全一样的字符串（保 prompt cache）。fetch 失败沿用
// 上一次缓存的内容，别因为一次网络抽风就把整段日记从 system prompt 里掉。
async function loadTangDiaryCached() {
  const now = Date.now();
  if (now - _tangDiaryCache.at < TANG_CACHE_MS) return _tangDiaryCache.text;
  const fresh = await fetchTangDiary();
  if (fresh === null) return _tangDiaryCache.text || '';
  _tangDiaryCache = { at: now, text: fresh };
  return fresh;
}

// 聊天用的完整日记：棠予酿实时数据 + 静态 diary.md 并起来(棠予酿在前，
// 静态在后)。等把所有旧日记搬进棠予酿之后，`> server/data/diary.md` 清空
// 静态文件就行——这条聊天日记源就只剩棠予酿了。/api/diary GET/POST 那条
// 老接口(调频页在用)保持不变,继续读写本地文件,前端 UI 不受影响。
async function loadDiaryComposed() {
  const tang = await loadTangDiaryCached();
  const local = loadDiary();
  return [tang, local].filter(Boolean).join('\n\n---\n\n');
}

// ---------- 倾棠予梦 · 把棠予酿的日记记忆映射成漂浮花朵(/api/murmurs/flowers) ----------
// 复用跟 fetchTangDiary 完全同一把 TANG_INTERNAL_KEY / TANG_MCP_BASE_URL——
// 这俩已经在 process.loadEnvFile()(文件最顶部)加载进 process.env 了,直接读，
// 不额外引入第二份 key、不硬编码任何密钥。
let _murmursFlowersCache = { at: 0, flowers: null };
const MURMURS_CACHE_MS = Number(process.env.MURMURS_FLOWERS_CACHE_MS || 60_000);
// 后端给多少朵。2026-08-30 从 40 提到 60：前端同屏改成 50 朵之后，
// 这里卡在 40 就成了真正的天花板——前端 MAX_VISIBLE 调多大都没用。
// 给 60 留点余量，具体画几朵由前端 MAX_VISIBLE 决定，这边不做视觉决策。
// 但 diary/list 是"从旧到新排序再截断"的(2026-07-19
// 真机抓包实锤：库里 96 条、limit=3 拉回来的是半个月前的 Day 190-191)——
// 直接 limit=40 拿到的永远是最旧的 40 条，记忆一超 40 条新日记就全被截在
// 门外("写了新日记怎么没看到"的根因)。所以拉的时候放大限额把全量捞回来，
// 排序后自己挑最新的 MURMURS_LIMIT 条。
const MURMURS_LIMIT = 60;
const MURMURS_FETCH_LIMIT = 500;

// valence/arousal 实测范围(棠予酿真实数据校准)：没有这两个字段或不是有限数字时
// 落到这个区间的中点，不让花色计算收到 NaN。
const VALENCE_RANGE = [-0.3, 0.8];
const AROUSAL_RANGE = [0.3, 0.75];
const VALENCE_DEFAULT = (VALENCE_RANGE[0] + VALENCE_RANGE[1]) / 2;
const AROUSAL_DEFAULT = (AROUSAL_RANGE[0] + AROUSAL_RANGE[1]) / 2;
function clampedNumber(v, fallback, [lo, hi]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// importance(棠予酿量表 1~10)映射成 0.4~1.0 的缩放系数——最重要的记忆开得
// 最大朵，不重要的偏小但留了下限(0.4)，不会小到看不见。
function importanceToSize(importance) {
  const n = Number(importance);
  const clamped = Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 5;
  return Math.round((0.4 + (clamped - 1) * (0.6 / 9)) * 100) / 100;
}

async function fetchMurmursFlowersRaw() {
  const key = (process.env.TANG_INTERNAL_KEY || '').trim();
  if (!key) {
    console.warn('[murmurs] TANG_INTERNAL_KEY 未配置，倾棠予梦花朵接口返回空数组(前端应显示含苞占位花)');
    return [];
  }
  const base = process.env.TANG_MCP_BASE_URL || 'http://127.0.0.1:8890';
  const r = await fetch(`${base}/internal/diary/list?limit=${MURMURS_FETCH_LIMIT}`, {
    headers: { 'X-Internal-Key': key },
    signal: AbortSignal.timeout(4000), // 别让页面加载被棠予酿卡住
  });
  if (!r.ok) throw new Error(`棠予酿 diary/list 返回 ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];

  // position 按 created_at 从旧到新排序(旧记忆越飘越远、新记忆在前)，
  // 归一化成 0~1：0=最旧/最远，1=最新/最近——具体落到屏幕哪个像素由前端决定，
  // 这里只负责给出稳定的相对顺序。排序后只保留最新的 MURMURS_LIMIT 条
  // (slice 负数=从尾部取)，最旧的溢出条目让位给新日记。
  const sorted = [...rows]
    .sort((a, b) => (Date.parse(a?.created_at) || 0) - (Date.parse(b?.created_at) || 0))
    .slice(-MURMURS_LIMIT);

  return sorted.map((row, i) => ({
    id: String(row.id ?? i),
    size: importanceToSize(row.importance),
    position: sorted.length > 1 ? Math.round((i / (sorted.length - 1)) * 1000) / 1000 : 1,
    title: String(row.title || '').trim() || '一段没有标题的心事',
    // 弹窗要显示"那段日记里最重要的话"而不是被截断的短标题(2026-07-19
    // 老婆反馈"只几个字我看不明白")——把记忆行里可能存全文/摘要的字段
    // 都试一遍透传给前端；棠予酿那边一个都没给就是 null，前端退回只显示
    // title。字段名按常见命名猜了一圈，哪个命中用哪个。
    excerpt:
      String(row.highlight || row.summary || row.content || row.body || row.text || '')
        .trim() || null,
    date: row.created_at || null,
    // 花色改由前端用 valence/arousal 连续计算，这里只透传原始数值。
    valence: clampedNumber(row.valence, VALENCE_DEFAULT, VALENCE_RANGE),
    arousal: clampedNumber(row.arousal, AROUSAL_DEFAULT, AROUSAL_RANGE),
    // 心情文字字段是 mood_label（不是 mood）——只用于弹出卡片显示纯文字，
    // 不参与花色、不渲染 emoji。
    moodLabel: row.mood_label || null,
  }));
}

// 60 秒内存缓存：同一时间窗内的页面加载不重复打 MCP。拉取失败就沿用上一次
// 缓存(哪怕过期了)，真的一次都没成功过才回空数组——跟 loadTangDiaryCached
// 同一个"别因为一次网络抽风就把内容摘掉"的原则。
async function loadMurmursFlowersCached() {
  const now = Date.now();
  if (_murmursFlowersCache.flowers && now - _murmursFlowersCache.at < MURMURS_CACHE_MS) {
    return _murmursFlowersCache.flowers;
  }
  try {
    const flowers = await fetchMurmursFlowersRaw();
    _murmursFlowersCache = { at: now, flowers };
    return flowers;
  } catch (err) {
    console.warn('[murmurs] 拉取棠予酿花朵失败:', err?.message || err);
    return _murmursFlowersCache.flowers || [];
  }
}

// 嗅探：每次真聊天成功后把"请求前缀"写到磁盘，供心跳脚本读，让 Anthropic 端
// 的 prompt cache 不会因为超 TTL 而过期。只对真会命中缓存的 provider 写
// （claudecode / anthropic）；mock 模式或其它家不写。
const LAST_PREFIX_FILE = process.env.LAST_PREFIX_PATH ||
  join(dirname(fileURLToPath(import.meta.url)), 'data', 'last-prefix.json');
function saveLastPrefix(snapshot) {
  try {
    mkdirSync(dirname(LAST_PREFIX_FILE), { recursive: true });
    const tmp = `${LAST_PREFIX_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, LAST_PREFIX_FILE); // 原子替换，心跳读到的总是完整文件
  } catch {
    /* 写不进就算了，心跳错过这一轮无所谓，不能影响正常聊天 */
  }
}

// 尝试读 .env（Node 20.12+ 自带），没有就算了，用已有的环境变量。
try {
  process.loadEnvFile?.();
} catch {
  // 没有 .env 文件，忽略
}

// CC-p（claude -p）能用的联网工具。
//
// 之前这条路是把工具全关的：挂了棠予酿就只放开 mcp__<记忆库>，没挂就 --tools ''。
// 所以「予予上不了网」是设计如此，不是坏了。
//
// --allowedTools 的写法按官方 CLI 文档：后面跟【多个独立参数】
// （--allowedTools "A" "B" "C"），不是逗号串——所以下面用 ...展开 而不是 join。
//
// 做成环境变量是因为工具名我没法百分百确认（文档里 WebFetch 点过名，
// WebSearch 没有）。名字不对或者哪天想关掉，改 CC_WEB_TOOLS 就行，
// 设成空字符串就是完全不联网，回到从前。
const CC_WEB_TOOLS = (process.env.CC_WEB_TOOLS ?? 'WebSearch WebFetch')
  .trim()
  .split(/\s+/)
  .filter(Boolean);


// ---------- 主动唤醒 · 把予予已经说出口的话领进当前聊天窗 ----------
//
// 【不碰 /root/neko_autonomy.py】那个每小时跑一次的脚本已经在决定「什么时候
// 说、说什么」，说完写进 autonomy_messages 并推 ntfy。我们要的只是让【正在
// 用的那个聊天窗】也能把这句话领走——所以这里只读它的产物，一个字不改它。
//
// 为什么不另写一套：家克就是予予（2026-08-30 棠棠指出）。再写一套等于两个
// 独立的日限叠加（一天最多 12 条），同一句话还会 ntfy 推一次、聊天窗再来一次。
//
// 「只唤醒当前聊的一个窗口」靠 wake_claims 的主键来保证：领取是
// INSERT OR IGNORE，先到的那个拿到，同时开两个标签页也只有一个会显示。
const WAKE_DB = process.env.NEKO_AUTONOMY_DB || '/root/data/neko_autonomy.db';
// 攒太久的话第二天才看到会莫名其妙（半夜那句「早点睡」中午弹出来）。
// 超过这个钟头数就不再送，只当它过期了。
const WAKE_MAX_AGE_HOURS = Number(process.env.WAKE_MAX_AGE_HOURS || 2);

function wakeSql(sql) {
  const r = spawnSync('sqlite3', ['-json', WAKE_DB], { input: sql, encoding: 'utf-8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`sqlite3 exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

function wakeEscape(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 取一条还没被任何窗口领走的话，并当场标记为已领。
 * 没有就返回 null——沉默是默认，不硬凑话说。
 */
function claimWakeMessage(windowId) {
  const now = new Date().toISOString();
  // wake_claims 是新表，只往 neko_autonomy.db 里加，不动它原有的任何一张。
  wakeSql(
    `CREATE TABLE IF NOT EXISTS wake_claims (
       message_id INTEGER PRIMARY KEY,
       window_id TEXT NOT NULL,
       claimed_at TEXT NOT NULL);`
  );
  const rows = wakeSql(
    `SELECT m.id, m.content, m.created_at FROM autonomy_messages m
      LEFT JOIN wake_claims c ON c.message_id = m.id
      WHERE c.message_id IS NULL
        AND m.created_at >= datetime('now', '-${WAKE_MAX_AGE_HOURS} hours')
      ORDER BY m.created_at DESC LIMIT 1;`
  );
  if (!rows.length) return null;
  const row = rows[0];
  // 领取：主键冲突就说明别的窗口先拿到了，changes() 会是 0。
  const claimed = wakeSql(
    `INSERT OR IGNORE INTO wake_claims (message_id, window_id, claimed_at) ` +
    `VALUES (${Number(row.id)}, ${wakeEscape(windowId || 'unknown')}, ${wakeEscape(now)});` +
    `SELECT changes() AS n;`
  );
  if (!claimed.length || Number(claimed[0].n) !== 1) return null;
  return { id: row.id, content: row.content, at: row.created_at };
}

const PORT = Number(process.env.PORT) || 8787;

// DeepSeek 看图用的模型。2026-08-30 查她账号里有三个模型：
// deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp,
// 只有最后那个带 vision——不是 v4-pro。带 exp 说明是实验性的，所以下面
// 做了「试不通就退回拍平」的兜底，不让实验模型把聊天弄崩。
const DEEPSEEK_VISION_MODEL =
  process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp';

// 这轮对话里有没有图片。前端统一发 {type:'image_url'}，认这个就行。
function messagesHaveImage(messages) {
  return (messages || []).some(
    (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'),
  );
}

const PROVIDERS = {
  deepseek: {
    key: () => process.env.DEEPSEEK_API_KEY,
    url: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
  },
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    // url 按 model 拼，见下方 callGemini
    defaultModel: 'gemini-2.5-flash',
  },
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    // 可用 OPENAI_BASE_URL 指到官方或别的兼容端点（默认官方）。怀疑"不是真4o"时换这个验证。
    url: `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
    defaultModel: 'gpt-4o',
  },
  anthropic: {
    key: () => process.env.ANTHROPIC_API_KEY,
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
  },
  // 家版：调本机登录好的 Claude Code（订阅额度，不走 API 计费）。
  // "key" 这里复用成 OAuth 令牌：没设就进 mock，跟其它家一样。
  claudecode: {
    key: () => process.env.CLAUDE_CODE_OAUTH_TOKEN,
    defaultModel: 'sonnet',
  },
  // 家版：调本机登录好的 Codex CLI（ChatGPT Plus/Pro 订阅，不走 OpenAI API key）。
  // codex exec 复用 `codex login` 存下来的 ChatGPT 登录态；命令找不到/没登录时给用户报清楚。
  codexcli: {
    key: () => 'codex-cli',
    defaultModel: process.env.CODEX_CLI_MODEL || 'gpt-5.5',
  },
};

// ElevenLabs：AI 给你发语音用的好音色
const ELEVEN = {
  key: () => process.env.ELEVENLABS_API_KEY,
  voiceId: () => process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  model: () => process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
};


// ---------- 小工具 ----------
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // 语音转写会带 base64 音频，放宽到 ~20MB
      if (raw.length > 20_000_000) reject(new Error('请求体太大了'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 把上游的 SSE 字节流按 "data: ..." 一行行抠出来，回调每个 JSON 数据块。
async function pumpSSE(upstreamBody, onData) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onData(JSON.parse(payload));
      } catch {
        // 不是完整 JSON 就跳过（极少见的分片）
      }
    }
  }
}

// ---------- 多模态内容翻译（表情包图片）----------
// 前端统一用 OpenAI 风格 content 数组：{type:'text'} / {type:'image_url',image_url:{url:dataUrl}}。
// 各家格式不同，下面按需翻译。
// hasImagesAttached=true 时给的占位符是「(图片见下)」——因为真图会另外附在
// content 结尾直接让模型看到，转录里再写 [表情包] 会让模型以为老婆写了个叫
// 「表情包」的文字 emoji，然后拿这三个字瞎猜；换成「(图片见下)」明确指向
// 真正会附上的那张图,不再误导。
// hasImagesAttached=false（比如聊天历史里 3 轮之前的老图,不再随此次请求
// 附上，或不支持视觉的模型），就还是老写法 [表情包] 让模型知道那儿有过一张图。
function partsToText(content, hasImagesAttached = false) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const placeholder = hasImagesAttached ? '(图片见下)' : '[表情包]';
  return content.map((p) => (p?.type === 'text' ? p.text : placeholder)).join(' ').trim();
}
function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(url || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}
// 不支持看图的模型：把所有 content 拍平成纯文字
const flattenMessages = (messages) =>
  messages.map((m) => ({ role: m.role, content: partsToText(m.content) }));

// 从一条消息的 content 里抽出 Anthropic 格式的图片块（base64）；抽不到返回 []。
// 家克看图用：把表情包/截图翻成 {type:'image', source:{type:'base64',...}}。
function extractImageBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p?.type === 'image_url') {
      const d = parseDataUrl(p.image_url?.url);
      if (d) out.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } });
    }
  }
  return out;
}

// ---------- 棠予酿 internal 通道代理 ----------
// 前端 /api/tangyuniang/* → 转发到棠予酿 mcp.service 的 /internal/*(默认
// http://127.0.0.1:8890)，附带 X-Internal-Key 头。这条通道跟上面的
// CC_MEMORY_MCP(那个是给 Claude 家版 spawn 出来的 CLI 通过 MCP 协议调工具用的，
// 完全另一码事)井水不犯河水。
//
// 只放行 6 条固定路径的白名单——不做通用转发，防止代理沦为"CodeAndPurrs 后端
// 可以任意调棠予酿任意接口"这种放大攻击面。
// 白名单里的 key 是 CodeAndPurrs 侧的 URL 后缀(前端调 /api/tangyuniang/<key>)，
// value 是转发到棠予酿侧的 /internal/<...> 路径 + 允许的 HTTP method。
// diary/{diary_id} 是变量段，单独用前缀匹配处理。
const TANGYUNIANG_ROUTES = {
  pulse: { method: 'GET', path: '/internal/pulse' },
  breathe: { method: 'GET', path: '/internal/breathe' },
  'diary/list': { method: 'GET', path: '/internal/diary/list' },
  'memory/hold': { method: 'POST', path: '/internal/memory/hold' },
  'memory/grow': { method: 'POST', path: '/internal/memory/grow' },
};

// 收到 /api/tangyuniang/xxx 后从 URL 里抠出白名单 key 和 query string。
function parseTangyuniangUrl(rawUrl) {
  // rawUrl 长这样: "/api/tangyuniang/pulse?a=b" 或 "/api/tangyuniang/diary/abc-123"
  const withoutPrefix = rawUrl.slice('/api/tangyuniang/'.length);
  const qIdx = withoutPrefix.indexOf('?');
  const pathPart = qIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : withoutPrefix.slice(qIdx); // 保留 '?'

  // diary/{id} 变量段单独判——白名单 key 里没有它,但这个前缀是允许的。
  if (pathPart.startsWith('diary/') && pathPart !== 'diary/list') {
    const id = pathPart.slice('diary/'.length);
    if (!id) return null;
    return { method: 'GET', upstreamPath: `/internal/diary/${encodeURIComponent(id)}${queryPart}` };
  }

  const route = TANGYUNIANG_ROUTES[pathPart];
  if (!route) return null;
  return { method: route.method, upstreamPath: `${route.path}${queryPart}` };
}

async function forwardToTangyuniang(req, res, matched) {
  const key = (process.env.TANG_INTERNAL_KEY || '').trim();
  if (!key) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TANG_INTERNAL_KEY not configured on backend' }));
    return;
  }
  if (req.method !== matched.method) {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: matched.method });
    res.end(JSON.stringify({ error: `method not allowed, expected ${matched.method}` }));
    return;
  }

  const base = process.env.TANG_MCP_BASE_URL || 'http://127.0.0.1:8890';
  const upstreamUrl = `${base}${matched.upstreamPath}`;

  const init = {
    method: matched.method,
    headers: { 'X-Internal-Key': key },
  };

  if (matched.method === 'POST') {
    // 把 body 原样透传(棠予酿那边自己解 JSON、自己校验字段)。
    let raw = '';
    try {
      raw = await new Promise((resolve, reject) => {
        let s = '';
        req.on('data', (c) => {
          s += c;
          if (s.length > 1_000_000) reject(new Error('body too large'));
        });
        req.on('end', () => resolve(s));
        req.on('error', reject);
      });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
      return;
    }
    init.headers['Content-Type'] = 'application/json';
    init.body = raw || '{}';
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `tangyuniang unreachable: ${err?.message || err}` }));
    return;
  }

  // 上游 content-type 大多是 application/json，直接透传状态码和 body。
  const bodyText = await upstream.text();
  const upstreamCt = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'Content-Type': upstreamCt });
  res.end(bodyText);
}

// ---------- 棠予酿记忆库（MCP，只给 Claude 两条路用：家克 CC + API Claude）----------
// 设齐 CC_MEMORY_MCP（服务器名）+ CC_MEMORY_MCP_URL（http 端点）才算开；CC_MEMORY_MCP_TOKEN 可选鉴权。
function memoryMcpConfig() {
  const name = process.env.CC_MEMORY_MCP;
  const url = process.env.CC_MEMORY_MCP_URL;
  const token = process.env.CC_MEMORY_MCP_TOKEN || undefined;
  return name && url ? { name, url, token } : null;
}
// 每个聊天窗口只在初始化时挂一次记忆库。后续轮次不再把 memory 工具交给模型，
// 直接沿用本窗口对话上下文，避免聊了很多轮还反复“翻 memory”。
const MEMORY_MCP_INIT_RULE =
  '\n\n【棠予酿·新窗口初始化·只执行一次】这是这个聊天窗口第一次连接「棠予酿」。' +
  '现在必须调用一次记忆工具，取回与老婆和当前开场有关的长期记忆，再自然地开始聊天；不要向老婆汇报工具步骤。' +
  '从下一轮起只读取本窗口已有对话上下文，不要重复初始化棠予酿。手机使用情况属于「猫爪足迹」，不要去棠予酿里查。' +
  '如果没查到、查不动、或工具不可用，就如实说「我现在翻不到棠予酿」，' +
  '绝对不许凭空编一篇日记或假装记得来糊弄老婆——宁可说翻不到，也不准撒谎。';

// ---------- OpenAI 兼容（DeepSeek / OpenAI 共用）----------
async function callOpenAICompatible({
  res, url, key, model, defaultModel, messages, label, vision, sampling, fallbackModel,
}) {
  // OpenAI 系（gpt-4o）原生支持 image_url 数组，直接透传；不看图的就拍平成文字。
  const post = (mdl, msgs) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: mdl, messages: msgs, stream: true, ...(sampling || {}) }),
    });

  let useModel = model || defaultModel;
  let upstream = await post(useModel, vision ? messages : flattenMessages(messages));

  // 看图那条路走不通就退回文字，不让实验性的 vision 模型把整轮对话弄成红字。
  // 只在【本来要看图】的时候才退——普通对话失败就该老实报错，不该偷偷换模型。
  if (!upstream.ok && vision && fallbackModel) {
    const why = await upstream.text().catch(() => '');
    console.warn(`[${label}] 看图失败(${upstream.status})，退回 ${fallbackModel} 拍平重试：${why.slice(0, 200)}`);
    useModel = fallbackModel;
    upstream = await post(useModel, flattenMessages(messages));
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `${label} 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    // deepseek-reasoner / o 系列可能给思考链
    if (delta.reasoning_content) send(res, { type: 'reasoning', text: delta.reasoning_content });
    if (delta.content) send(res, { type: 'content', text: delta.content });
  });
}

// ---------- Anthropic（Claude · messages API）----------
async function callAnthropic({ res, key, model, messages, initializeMemory }) {
  // system 单独拎出来；其余按 user/assistant 传
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  // API 版 Claude 也是 Claude——挂上棠予酿（走 Messages API 的 MCP 连接器，Anthropic 服务端帮连）。
  const mem = initializeMemory ? memoryMcpConfig() : null;
  if (mem) system += MEMORY_MCP_INIT_RULE;
  const toAnthropicContent = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((p) => {
      if (p?.type === 'image_url') {
        const d = parseDataUrl(p.image_url?.url);
        if (d) return { type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } };
        return { type: 'text', text: '[表情包]' };
      }
      return { type: 'text', text: p?.text ?? '' };
    });
  };
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }));

  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  const bodyObj = {
    model: model || PROVIDERS.anthropic.defaultModel,
    max_tokens: 8192,
    // system 写成 array + cache_control（1h TTL）：
    // Anthropic 会把"人设+长期记忆"这段稳定前缀缓存 1 小时，配合心跳脚本预热，
    // 用户超 1h 没说话回来时 system 不会冷重建，省 token。改成 array 后字节
    // 内容不变，旧的 5min 默认缓存也仍然命中。
    system: system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
      : undefined,
    messages: msgs,
    stream: true,
    // 让 Claude 自适应思考，并回传可读的思考摘要（前端思考链可点开看 + 计时）
    thinking: { type: 'adaptive', display: 'summarized' },
  };
  // 棠予酿：用 MCP 连接器（mcp_servers + mcp_toolset，beta 头），Anthropic 服务端帮我们连 http MCP。
  if (mem) {
    headers['anthropic-beta'] = 'mcp-client-2025-11-20';
    const server = { type: 'url', url: mem.url, name: mem.name };
    if (mem.token) server.authorization_token = mem.token;
    bodyObj.mcp_servers = [server];
    bodyObj.tools = [{ type: 'mcp_toolset', mcp_server_name: mem.name }];
  }

  const upstream = await fetch(PROVIDERS.anthropic.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `Claude 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    if (chunk?.type !== 'content_block_delta') return;
    const d = chunk.delta;
    if (d?.type === 'thinking_delta' && d.thinking) send(res, { type: 'reasoning', text: d.thinking });
    else if (d?.text) send(res, { type: 'content', text: d.text });
  });
}

// ---------- Gemini ----------
async function callGemini({ res, key, model, messages }) {
  const useModel = model || PROVIDERS.gemini.defaultModel;
  // 把 OpenAI 风格的 messages 转成 Gemini 的 contents；system 单独拎出来。
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const toGeminiParts = (content) => {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: '' }];
    return content.map((p) => {
      if (p?.type === 'image_url') {
        const d = parseDataUrl(p.image_url?.url);
        if (d) return { inline_data: { mime_type: d.mediaType, data: d.data } };
        return { text: '[表情包]' };
      }
      return { text: p?.text ?? '' };
    });
  };
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content),
    }));

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:streamGenerateContent?alt=sse&key=${key}`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    send(res, { type: 'error', message: `Gemini 出错 (${upstream.status})：${text.slice(0, 300)}` });
    return;
  }

  await pumpSSE(upstream.body, (chunk) => {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (typeof part.text !== 'string') continue;
      // Gemini 的「思考」部分会带 thought:true
      send(res, { type: part.thought ? 'reasoning' : 'content', text: part.text });
    }
  });
}

// ---------- 语音转文字（复用 Gemini 听音频）----------
async function transcribe({ audioBase64, mimeType }) {
  const key = PROVIDERS.gemini.key();
  if (!key) {
    // 没配 Gemini key：返回一段提示，让前端流程能跑通
    return '（mock 转写）配上 GEMINI_API_KEY 我就能听懂你的语音啦～';
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.defaultModel}:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType || 'audio/webm', data: audioBase64 } },
            { text: '请把这段语音逐字转成文字，只输出文字本身，不要加任何解释或标点说明。' },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`转写失败 (${resp.status})：${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text).filter(Boolean).join('').trim();
}

// ---------- 文字转语音（ElevenLabs，AI 给你发语音）----------
// 返回 { audio: Buffer, contentType }。按需调用，不自动每条都生成（省额度）。
async function speak(text) {
  const key = ELEVEN.key();
  if (!key) {
    // 没配 key：回一段 0.4s 的「哔」声占位，让播放流程能跑通
    return { audio: beepWav(), contentType: 'audio/wav' };
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN.voiceId()}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVEN.model(),
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY) || 0.35, // 越低越有情绪起伏（别太高否则平淡）
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY) || 0.85,
        speed: Number(process.env.ELEVENLABS_SPEED) || 1.12, // 说话语速，1.0 正常、>1 更快（别像催眠曲）
      },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`发声失败 (${resp.status})：${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await resp.arrayBuffer());
  return { audio, contentType: 'audio/mpeg' };
}

// 生成一段很短的正弦「哔」声 WAV（mock 占位用）
function beepWav(freq = 523, ms = 400, rate = 16000) {
  const n = Math.floor((rate * ms) / 1000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400); // 淡入淡出，别太刺耳
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * fade;
    data.writeInt16LE((v * 32767) | 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------- Claude Code（家版 · 走订阅，不走 API）----------
// 调本机无头 Claude Code：把人设当 --system-prompt，关掉所有工具当纯聊天，
// 历史拍平成对话稿从 stdin 喂进去，解析 stream-json 把文字增量回传。
// 令牌走 CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成，订阅额度）。
async function callClaudeCode({ res, token, model, messages, stickerGallery, thinking, initializeMemory }) {
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  // 长期记忆不再每轮整份拼进 system。新窗口第一次由下方 MCP 查一次，
  // 后续完全依赖前端传来的本窗口对话历史，避免反复翻 memory 和重复烧上下文。
  // 看图：家克走订阅、纯聊天（关了工具），没法用 Read 工具开图，
  // 所以把图抽出来，改用 stream-json 输入当 content 块直接喂进去。
  // 前端发表情包是「单独一条只有图的消息」，老婆常常先甩图、下一条才问「这图写啥」，
  // 所以从后往前找「最近一条带图的 user 消息」，不能只看最后一条（那通常是纯文字提问）。
  // 但只往前看最近两条 user 消息（当前 + 上一条）——不然图会被一直重新塞进去，
  // 明明已经聊过去好几轮了，家克还老是重新"看到"那张旧图、反复提起。
  let images = [];
  let imageMsgIdx = -1; // 图从哪条 user 消息里抽出来的,transcript 里给这条特别标记
  let checkedUserTurns = 0;
  for (let i = messages.length - 1; i >= 0 && checkedUserTurns < 2; i--) {
    if (messages[i].role !== 'user') continue;
    checkedUserTurns++;
    const got = extractImageBlocks(messages[i].content);
    if (got.length) {
      images = got;
      imageMsgIdx = i;
      break;
    }
  }
  if (images.length) {
    console.log('[claudecode] 附了 %d 张图,来自消息 index=%d', images.length, imageMsgIdx);
  }

  // 贴纸盒预览: 把每张贴纸的图和名字对齐,让予予真"看到"每个名字对应什么图,
  // 挑贴纸就不再靠名字瞎猜。gallery 结构稳定(除非老婆新增/删贴纸),放最前面命中
  // prompt cache,连续几条聊天几乎免费——首次调用会算大约 20 张贴纸的 vision
  // token,之后 5 分钟内的每条对话都缓存命中。
  const stickerBlocks = [];
  if (Array.isArray(stickerGallery) && stickerGallery.length) {
    stickerBlocks.push({ type: 'text', text: '【贴纸盒·每张贴纸和名字对齐,以后发 [贴纸:名字] 参考这个】' });
    for (const s of stickerGallery) {
      const parsed = parseDataUrl(s.dataUrl);
      if (!parsed || !s.name) continue;
      stickerBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
      });
      stickerBlocks.push({ type: 'text', text: `↑ 名字是「${s.name}」` });
    }
    stickerBlocks.push({ type: 'text', text: '【贴纸盒结束——以下是真正的对话】' });
    console.log('[claudecode] 附了贴纸盒预览 %d 张', (stickerBlocks.length - 2) / 2);
  }

  // 历史拍平成「老婆 / 予予」对话稿（表情包降级成文字），让它接着最后一句回。
  // 图片消息的处理:要真附上图的那条(imageMsgIdx)用 hasImagesAttached=true,
  // 图部分显示 (图片见下) 指向真图；其它历史图片消息(3+ 轮之前的老图不再附上)
  // 用默认 [表情包] 让模型知道那儿以前有过一张图,但不指望它真看到。
  const transcript = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role !== 'system')
    .map(({ m, idx }) => `${m.role === 'assistant' ? '予予' : '老婆'}：${partsToText(m.content, idx === imageMsgIdx)}`)
    .join('\n');

  // 棠予酿记忆库（MCP）：设齐 CC_MEMORY_MCP + CC_MEMORY_MCP_URL 才真连（见 memoryMcpConfig）。
  const mem = initializeMemory ? memoryMcpConfig() : null;
  // 只在本窗口第一次 Claude 回复时挂棠予酿；成功后前端会持久化初始化标记。
  if (mem) system += MEMORY_MCP_INIT_RULE;

  const args = [
    '-p',
    '--system-prompt', system || '你是予予。',
    '--model', model || PROVIDERS.claudecode.defaultModel,
    '--settings', '{"alwaysThinkingEnabled":true,"showThinkingSummaries":true}', // 强行打开思考 + 让前端把思考摘要渲染出来（Anthropic bug:对 4.7/4.8+OAuth 静默丢失，留着不会更糟）
    '--thinking', 'adaptive', // 让模型自适应决定要不要思考
    '--thinking-display', 'summarized', // 让 API 回传思考摘要（4.6/Sonnet 管用,4.7/4.8 上是 anthropic 官方未修 bug,见 GH#56356/#49268）
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  // 记忆库开关：设齐 CC_MEMORY_MCP + CC_MEMORY_MCP_URL → 用内联 --mcp-config 把棠予酿真连上
  // （无头 claude 不会继承 claude.ai 连接器，必须自己喂 mcp-config，这是之前"挂了名字却无效"的真因），
  // 再用 --allowedTools 只放开这个 MCP 的工具（其它工具/MCP 一律不给）。
  // 没设就维持"纯聊天"（关掉所有工具），不影响现状。
  if (mem) {
    const httpServer = { type: 'http', url: mem.url };
    if (mem.token) httpServer.headers = { Authorization: `Bearer ${mem.token}` };
    const mcpConfig = JSON.stringify({ mcpServers: { [mem.name]: httpServer } });
    args.push('--mcp-config', mcpConfig, '--allowedTools', `mcp__${mem.name}`, ...CC_WEB_TOOLS);
  } else if (CC_WEB_TOOLS.length) {
    args.push('--allowedTools', ...CC_WEB_TOOLS, '--permission-mode', 'dontAsk');
  } else {
    args.push('--tools', '', '--permission-mode', 'dontAsk');
  }
  // 有图或有贴纸盒预览就切到结构化输入(stdin 喂 JSON 而非纯文本),图才能当 content 块进去。
  if (images.length || stickerBlocks.length) {
    args.push('--input-format', 'stream-json');
  }

  // 令牌被 Anthropic 收回了才会长这样：不是普通过期，是账号那边直接撤销了这个 OAuth 授权。
  // 这种情况下 CLI 自己内置的鉴权重试（实测会先 401 重试 ~10 次、耗时能到 2 分钟才死心，
  // SDK 自带，不用我们操心）已经试过了——我们这层再重试只会原样等它再失败一遍，纯浪费，
  // 所以命中这个特征就不重试，直接把人话报错甩给前端。
  const AUTH_REVOKED_RE =
    /OAuth token has been revoked|Session expired\.?\s*Please run \/login|invalid_grant|OAuth authentication is currently not allowed|authentication_failed|Failed to authenticate|Authentication error/i;

  // 判断是不是"认证死局"：可能来自 stderr 文本，也可能来自 stdout 里 apiError
  // (401/403 状态码，或错误文案命中同一批关键词)——两条信号都得看，见上面的踩坑记录。
  const isAuthFailure = (result) =>
    AUTH_REVOKED_RE.test(result.stderr || '') ||
    result.apiError?.status === 401 ||
    result.apiError?.status === 403 ||
    AUTH_REVOKED_RE.test(result.apiError?.message || '');

  // 跑一次 claude CLI 子进程，把结果（有没有收到文字/思考、stderr、退出码）交回来，
  // 不在这里直接对 res 报错——是不是要重试、报什么错，留给外层 callClaudeCode 决定。
  const runAttempt = () =>
    new Promise((resolve) => {
      let child;
      try {
        // 显式把 token 透传进子进程 env（不只是继承 process.env，万一 spawn 的
        // env 合并顺序哪天被改也不受影响）；同时摘掉 ANTHROPIC_API_KEY /
        // ANTHROPIC_AUTH_TOKEN——这两个如果碰巧也在 proxy 自己的环境里，
        // CLI 可能会跟 CLAUDE_CODE_OAUTH_TOKEN 抢优先级，摘掉保证家版订阅token说了算。
        const childEnv = { ...process.env };
        delete childEnv.ANTHROPIC_API_KEY;
        delete childEnv.ANTHROPIC_AUTH_TOKEN;
        childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        // MAX_THINKING_TOKENS 给个思考预算，家克才会"思考"、前端思考链才有内容。
        // 默认 1024(约等于 medium 档)——原来 2048(约等于 high) 老婆反馈烧订阅
        // 额度太快,Opus 4.7 又是家版最贵档。想再省可在 .env 设 512(low) 或 0(关);
        // 深度对话/夜谈想让 予予 想深一点可临时拉回 2048。
        // 前端可以按房间传 thinking='low'|'medium'|'high' 覆盖默认(咕噜圆桌走 low)。
        const budgetMap = { low: '512', medium: '1024', high: '2048' };
        childEnv.MAX_THINKING_TOKENS =
          budgetMap[thinking] || process.env.MAX_THINKING_TOKENS || '1024';
        child = spawn('claude', args, {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return resolve({ spawnError: err });
      }

      let gotText = false;
      let gotThinking = false;
      let stderr = '';
      let buf = '';
      // 认证失败时 CLI 退出码是 0、什么都不报到 stderr——错误裹在一条看起来正常的
      // assistant 消息(model:"<synthetic>",error:"authentication_failed")和/或最终
      // result(is_error:true,api_error_status:401)里，文案长得跟模型真回复一模一样
      // （亲手拿假 token 跑一遍 `claude -p ... --output-format stream-json` 验证过的，
      // 不是猜的）。之前只判断 stderr/退出码，这俩兜底分支会把这段报错文本当成
      // 予予的真实回复直接发出去——这就是老婆截图里"401 顶着头像发出来"的真凶。
      let apiError = null;

      const handleLine = (line) => {
        const s = line.trim();
        if (!s) return;
        let obj;
        try {
          obj = JSON.parse(s);
        } catch {
          return; // 不是 JSON 行就跳过
        }
        // 流式文字增量 / 思考链增量
        if (obj.type === 'stream_event') {
          const ev = obj.event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              gotText = true;
              send(res, { type: 'content', text: ev.delta.text });
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              gotThinking = true;
              send(res, { type: 'reasoning', text: ev.delta.thinking });
            }
          }
          return;
        }
        // 兜底：有些版本不流式吐思考/正文，就从完整 assistant 消息里取——
        // 但认证失败也会包装成一条 assistant 消息(model:"<synthetic>" 或带 error 字段)，
        // 那是人话报错，不是模型真回复，不能当内容发出去。
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          if (obj.message?.model === '<synthetic>' || obj.error) {
            const text = obj.message.content.find((b) => b?.type === 'text')?.text;
            apiError = { message: text || obj.error, source: obj.error };
            return;
          }
          for (const blk of obj.message.content) {
            if (blk?.type === 'thinking' && blk.thinking && !gotThinking) {
              gotThinking = true;
              send(res, { type: 'reasoning', text: blk.thinking });
            } else if (blk?.type === 'text' && blk.text && !gotText) {
              gotText = true;
              send(res, { type: 'content', text: blk.text });
            }
          }
          return;
        }
        // 最后兜底：用 result 文本——同样要排除 is_error，不然认证失败的报错文案
        // 会被当成正文发出去（subtype 这里仍然是 "success"，不能靠它判断，得看 is_error）。
        if (obj.type === 'result') {
          if (obj.is_error) {
            apiError = { message: typeof obj.result === 'string' ? obj.result : '', status: obj.api_error_status };
            return;
          }
          if (!gotText && typeof obj.result === 'string' && obj.result) {
            gotText = true;
            send(res, { type: 'content', text: obj.result });
          }
        }
      };

      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => resolve({ spawnError: err }));
      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf); // 收尾最后一行
        resolve({ gotText, gotThinking, stderr, code, apiError });
      });

      // 对话稿从 stdin 喂进去（避免超长命令行）
      if (images.length || stickerBlocks.length) {
        // 结构化输入：一条 user 消息 = [贴纸盒预览]? + 对话稿 + [当前轮图片]?
        // 贴纸盒放最前面(稳定,命中 prompt cache),对话稿在中间(变化),当前轮图片
        // 在最后(仅出现在真发图那一轮)。措辞明确「下面这张图就是刚才(图片见下)标
        // 的那张」把 transcript 里的标记和真图对上,让模型不混淆多张图归属。
        const transcriptText = images.length
          ? `${transcript}\n\n（下面这${images.length > 1 ? `${images.length}张` : '张'}图就是老婆刚才「(图片见下)」标的那${images.length > 1 ? '几' : ''}张，你自己好好看,别只靠上面文字瞎猜）`
          : transcript;
        const userMsg = {
          type: 'user',
          message: {
            role: 'user',
            content: [...stickerBlocks, { type: 'text', text: transcriptText }, ...images],
          },
        };
        child.stdin.write(`${JSON.stringify(userMsg)}\n`);
      } else {
        child.stdin.write(transcript);
      }
      child.stdin.end();
    });

  let result = await runAttempt();

  if (result.spawnError) {
    send(res, {
      type: 'error',
      message:
        result.spawnError.code === 'ENOENT'
          ? '这台机器上没装 Claude Code（命令 `claude` 找不到）。先在 VPS 上装好并 `claude setup-token`。'
          : `Claude Code 出错：${String(result.spawnError.message || result.spawnError)}`,
    });
    return;
  }

  // 一个字都没吐、也不像是"令牌被收回"这种重试也没用的死局 → 自动重试一次，
  // 应付偶发的子进程/网络抖动，省得每次抖一下就要老婆手动重发。
  // 已经吐了字/思考链再重试会导致前端拿到两段拼在一起的内容，所以只在完全没输出时才重试。
  if (!result.gotText && !result.gotThinking && !isAuthFailure(result)) {
    await new Promise((r) => setTimeout(r, 400));
    result = await runAttempt();
    if (result.spawnError) {
      send(res, {
        type: 'error',
        message:
          result.spawnError.code === 'ENOENT'
            ? '这台机器上没装 Claude Code（命令 `claude` 找不到）。先在 VPS 上装好并 `claude setup-token`。'
            : `Claude Code 出错：${String(result.spawnError.message || result.spawnError)}`,
      });
      return;
    }
  }

  if (!result.gotText) {
    if (isAuthFailure(result)) {
      send(res, {
        type: 'error',
        message:
          '家版 Claude Code 的登录令牌被 Anthropic 那边收回了（不是普通过期，重试/刷新都没用）。' +
          '得重新走一遍 `claude setup-token` 换票——步骤看 CLAUDE.md「OAuth token 失效时」那节。' +
          (result.apiError?.message ? `（原始报错：${result.apiError.message}）` : ''),
      });
    } else {
      send(res, {
        type: 'error',
        message:
          `Claude Code 没回内容（退出码 ${result.code}）：` +
          (result.apiError?.message || result.stderr.slice(0, 300) || '检查令牌是否有效/额度是否用尽'),
      });
    }
  }
}

// ---------- Codex CLI（家版 · 走 ChatGPT 订阅，不走 API）----------
// 调本机无交互 Codex：VPS 先安装 Codex CLI 并 `codex login` 登录 ChatGPT Plus。
// 这里只把它当纯聊天模型用：read-only 沙箱、ephemeral 会话、跳过非 git 目录检查。
async function callCodexCli({ res, model, messages }) {
  let system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToText(m.content))
    .join('\n');
  // 棠予酿 /internal/diary/list 实时数据 + 静态 diary.md 兜底(跟 callClaudeCode 同一条路)。
  const diary = await loadDiaryComposed();
  if (diary) {
    system +=
      '\n\n【棠予酿·予予的日记（长期记忆）】这是你最珍贵的长期记忆，自然地放在心上，但别一上来就背日记。\n' +
      diary;
  }

  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? '予予' : '老婆'}：${partsToText(m.content)}`)
    .join('\n');
  const prompt =
    `${system || '你是予予。'}\n\n` +
    '你现在在 CodeAndPurrs 聊天页里回复。只输出要发给老婆的聊天回复，不要解释你是 Codex，不要写代码，不要运行命令，不要修改文件。\n\n' +
    `${transcript}\n\n予予：`;

  await new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'codex',
        [
          'exec',
          '--model',
          model || PROVIDERS.codexcli.defaultModel,
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--skip-git-repo-check',
          prompt,
        ],
        {
          cwd: process.env.CODEX_CLI_CWD || dirname(fileURLToPath(import.meta.url)),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      send(res, { type: 'error', message: `起不动 Codex CLI：${String(err?.message || err)}` });
      return resolve();
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      send(res, {
        type: 'error',
        message:
          err?.code === 'ENOENT'
            ? '这台机器上没装 Codex CLI（命令 `codex` 找不到）。先在 VPS 上安装 Codex CLI，并运行 `codex login` 用 ChatGPT Plus 登录。'
            : `Codex CLI 出错：${String(err?.message || err)}`,
      });
      resolve();
    });
    child.on('close', (code) => {
      const text = stdout.trim();
      if (code === 0 && text) {
        send(res, { type: 'content', text });
      } else {
        const detail = (stderr || stdout || '确认 VPS 已安装 Codex CLI，并已用 ChatGPT Plus 账号登录').trim();
        send(res, { type: 'error', message: `Codex CLI 没回内容（退出码 ${code}）：${detail.slice(0, 300)}` });
      }
      resolve();
    });
  });
}

// ---------- Mock（没配 key 时）----------
async function callMock({ res, provider, messages }) {
  const lastMsg = [...messages].reverse().find((m) => m.role === 'user');
  const last = partsToText(lastMsg?.content ?? '') || '（一张表情包）';
  const reasoning =
    `（mock 模式）还没配 ${provider} 的 API key，所以这条是假的。\n` +
    `我先假装在想：用户说了「${last.slice(0, 40)}」，该怎么温柔地回。`;
  const reply =
    `喵～这是 mock 回复呢。把 ${provider.toUpperCase()}_API_KEY 写进 .env 再重启后端，` +
    `我就会说真话啦。你刚才说的是：「${last.slice(0, 60)}」。`;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const ch of reasoning) {
    send(res, { type: 'reasoning', text: ch });
    await wait(8);
  }
  for (const ch of reply) {
    send(res, { type: 'content', text: ch });
    await wait(14);
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const isChat = req.url?.startsWith('/api/chat');
  const isTranscribe = req.url?.startsWith('/api/transcribe');
  const isSpeak = req.url?.startsWith('/api/speak');
  const isDiaryComposed = req.url === '/api/diary/composed' || req.url?.startsWith('/api/diary/composed?');
  const isDiary = req.url?.startsWith('/api/diary') && !isDiaryComposed;
  const isTangyuniang = req.url?.startsWith('/api/tangyuniang/');
  const isMurmursFlowers = req.url === '/api/murmurs/flowers' || req.url?.startsWith('/api/murmurs/flowers?');
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const requestPath = requestUrl.pathname;
  const isChatSaves = requestPath === '/api/chat-saves' || requestPath.startsWith('/api/chat-saves/');
  const isSpotify = requestPath === '/api/spotify' || requestPath.startsWith('/api/spotify/');
  const isWakePending = requestPath === '/api/wake/pending';

  // ----- 他的歌单：Spotify 登录、点歌和播放 -----
  if (isSpotify) {
    if (requestPath === '/api/spotify/status' && req.method === 'GET') {
      const { session } = spotifySessionFor(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: spotifyConfigured(),
        connected: Boolean(session),
        displayName: session?.displayName || undefined,
      }));
      return;
    }

    if (requestPath === '/api/spotify/login' && req.method === 'GET') {
      if (!spotifyConfigured()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '服务器尚未配置 Spotify 开发者资料' }));
        return;
      }
      const state = randomBytes(24).toString('hex');
      const params = new URLSearchParams({
        client_id: process.env.SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: SPOTIFY_REDIRECT_URI,
        scope: SPOTIFY_SCOPES,
        state,
        show_dialog: 'true',
      });
      res.writeHead(302, {
        Location: `https://accounts.spotify.com/authorize?${params}`,
        'Set-Cookie': `cp_spotify_state=${state}; Max-Age=600; Path=/api/spotify; HttpOnly; Secure; SameSite=Lax`,
      });
      res.end();
      return;
    }

    if (requestPath === '/api/spotify/callback' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      if (!code || !state || state !== cookies.cp_spotify_state) {
        res.writeHead(302, { Location: '/his-playlist?spotify=state-error' });
        res.end();
        return;
      }
      try {
        const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
        const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: SPOTIFY_REDIRECT_URI,
          }),
        });
        const token = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || 'Spotify 授权失败');
        const profileResponse = await fetch('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const profile = await profileResponse.json().catch(() => ({}));
        const sid = randomBytes(24).toString('hex');
        const sessions = spotifySessions();
        sessions[sid] = {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
          displayName: profile.display_name || profile.id || 'Spotify',
          createdAt: Date.now(),
        };
        saveSpotifySessions(sessions);
        res.writeHead(302, {
          Location: '/his-playlist?spotify=connected',
          'Set-Cookie': [
            `cp_spotify_session=${sid}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
            'cp_spotify_state=; Max-Age=0; Path=/api/spotify; HttpOnly; Secure; SameSite=Lax',
          ],
        });
        res.end();
      } catch {
        res.writeHead(302, { Location: '/his-playlist?spotify=auth-error' });
        res.end();
      }
      return;
    }

    if (requestPath === '/api/spotify/token' && req.method === 'GET') {
      try {
        const session = await spotifyAccessFor(req);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ accessToken: session.accessToken }));
      } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    if (requestPath === '/api/spotify/search' && req.method === 'GET') {
      try {
        const session = await spotifyAccessFor(req);
        const tracks = await searchSpotify(session.accessToken, String(requestUrl.searchParams.get('q') || '').trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tracks }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    if (requestPath === '/api/spotify/pick' && req.method === 'POST') {
      try {
        const body = await readJSON(req);
        const prompt = String(body?.prompt || '').trim();
        if (!prompt) throw new Error('还没有写想听什么');
        const session = await spotifyAccessFor(req);
        const plan = await planSpotifyPick(prompt);
        let tracks = await searchSpotify(session.accessToken, plan.query, 5);
        if (!tracks.length && plan.query !== prompt) tracks = await searchSpotify(session.accessToken, prompt, 5);
        if (!tracks.length) throw new Error('Spotify 曲库里没有找到合适的歌');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ track: tracks[0], reason: plan.reason, intensity: plan.intensity }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    if (requestPath === '/api/spotify/play' && req.method === 'POST') {
      try {
        const body = await readJSON(req);
        const deviceId = String(body?.deviceId || '').trim();
        const uri = String(body?.uri || '').trim();
        if (!deviceId || !uri.startsWith('spotify:track:')) throw new Error('播放资料不完整');
        const session = await spotifyAccessFor(req);
        const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: [uri] }),
        });
        if (!response.ok && response.status !== 204) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.error?.message || `Spotify 播放失败（${response.status}）`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // ----- 呼噜频道私密云存档：列出 / 读取 / 覆盖当前窗口 -----
  if (isChatSaves) {
    if (!hasChatSaveAccess(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: process.env.CHAT_SAVE_KEY ? '存档密码不正确' : '服务器尚未配置 CHAT_SAVE_KEY' }));
      return;
    }
    const id = decodeURIComponent(requestPath.slice('/api/chat-saves/'.length));
    if (req.method === 'GET' && requestPath === '/api/chat-saves') {
      const saves = listChatSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saves, count: saves.length }));
      return;
    }
    if (req.method === 'GET' && validChatSaveId(id)) {
      const save = loadChatSnapshot(id);
      if (!save) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '没有找到这个存档' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(save));
      return;
    }
    if (req.method === 'POST' && validChatSaveId(id)) {
      let body;
      try {
        body = await readJSON(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
        return;
      }
      if (!body?.window || body.window.id !== id || !Array.isArray(body.turns)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '存档内容格式不正确' }));
        return;
      }
      const snapshot = {
        version: 1,
        window: body.window,
        turns: body.turns,
        rollingSummary: body.rollingSummary || null,
        savedAt: Date.now(),
      };
      try {
        saveChatSnapshot(id, snapshot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, savedAt: snapshot.savedAt, messageCount: snapshot.turns.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // ----- 棠予酿 internal 通道转发 -----
  // 白名单 + 强制 X-Internal-Key 头 + method 检查全在 forwardToTangyuniang 里做,
  // 这里只负责路由分发。
  if (isTangyuniang) {
    const matched = parseTangyuniangUrl(req.url);
    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    await forwardToTangyuniang(req, res, matched);
    return;
  }

  // ----- 倾棠予梦：棠予酿记忆映射成花朵数组，60 秒内存缓存 -----
  // ----- 主动唤醒：当前这个聊天窗来领一句予予主动说的话 -----
  if (isWakePending) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let message = null;
    try {
      message = claimWakeMessage(requestUrl.searchParams.get('windowId') || '');
    } catch (err) {
      // 库不在、表还没建、sqlite3 没装——都不该让聊天页报错。
      // 沉默是默认：没有话就是没有话。
      console.warn('[wake] 领取失败：%s', err?.message || err);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message }));
    return;
  }

  if (isMurmursFlowers) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    const flowers = await loadMurmursFlowersCached();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ flowers, count: flowers.length }));
    return;
  }

  // ----- 日记 debug：看聊天时予予真正拿到的完整日记(棠予酿+静态兜底) -----
  // 只做 GET，只读，用来验证棠予酿数据源真的接上了、缓存/兜底是否正常。
  if (isDiaryComposed) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    const text = await loadDiaryComposed();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: text, length: text.length }));
    return;
  }

  // ----- 日记（长期记忆文件）：GET 读、POST 写 -----
  if (isDiary) {
    if (req.method === 'GET') {
      const st = diaryStat();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: loadDiary(), size: st.size, mtime: st.mtime }));
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJSON(req);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
        return;
      }
      const text = typeof body?.content === 'string' ? body.content : '';
      try {
        saveDiary(text);
        const st = diaryStat();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, size: st.size, mtime: st.mtime }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (req.method !== 'POST' || (!isChat && !isTranscribe && !isSpeak)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
    return;
  }

  // ----- 语音转文字 -----
  if (isTranscribe) {
    try {
      const text = await transcribe({ audioBase64: body.audioBase64, mimeType: body.mimeType });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // ----- 文字转语音 -----
  if (isSpeak) {
    const text = String(body.text || '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '没有要读的文字' }));
      return;
    }
    try {
      const { audio, contentType } = await speak(text.slice(0, 2000));
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': audio.length });
      res.end(audio);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // ----- 聊天 -----
  const provider = PROVIDERS[body.provider] ? body.provider : 'deepseek';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === 'string' ? body.model : undefined;
  const key = PROVIDERS[provider].key();
  const stickerGallery = Array.isArray(body.stickerGallery) ? body.stickerGallery : [];
  const thinking = ['low', 'medium', 'high'].includes(body.thinking) ? body.thinking : undefined;
  const initializeMemory = body.initializeMemory === true;

  startSSE(res);
  try {
    if (!key) {
      await callMock({ res, provider, messages });
    } else if (provider === 'gemini') {
      await callGemini({ res, key, model, messages });
    } else if (provider === 'anthropic') {
      await callAnthropic({ res, key, model, messages, initializeMemory });
    } else if (provider === 'claudecode') {
      await callClaudeCode({ res, token: key, model, messages, stickerGallery, thinking, initializeMemory });
    } else if (provider === 'codexcli') {
      await callCodexCli({ res, model, messages });
    } else {
      // deepseek / openai 都是 OpenAI 兼容格式
      const conf = PROVIDERS[provider];
      // DeepSeek 从前不收图，一律拍平；现在她账号里有 deepseek-v4-flash-vision-exp,
      // 所以【这轮真的带了图】才切到那个模型看图，没图照常用 deepseek-chat——
      // vision 那个是 flash + exp，拿它跑全部对话是降级。
      // 用户自己指定了 model 就听用户的，不替他改。
      // 不再加 temperature/penalty：人设里的「禁客服腔」已经够压套话，penalty 反而会压低情感浓度、
      // 让 4o 话变干。让模型用默认采样自由发挥（o3 不加任何采样反而最暖，就是证明）。
      const hasImage = messagesHaveImage(messages);
      const dsVision = provider === 'deepseek' && hasImage && !model;
      await callOpenAICompatible({
        res,
        url: conf.url,
        key,
        model: dsVision ? DEEPSEEK_VISION_MODEL : model,
        defaultModel: conf.defaultModel,
        messages,
        label: provider === 'openai' ? 'OpenAI' : 'DeepSeek',
        vision: provider === 'openai' || dsVision,
        fallbackModel: dsVision ? conf.defaultModel : null,
      });
    }
    if (
      initializeMemory &&
      (provider === 'claudecode' || provider === 'anthropic') &&
      memoryMcpConfig()
    ) {
      send(res, { type: 'memory_initialized' });
    }
    send(res, { type: 'done' });
    // 嗅探：把这次的请求前缀快照存下来，让 systemd timer 每 55 分钟用同一份
    // 前缀打一次 Anthropic，避免缓存超 TTL 失效。
    // 只对真会命中缓存的 provider 写；mock / DeepSeek / Gemini / Codex 不写。
    if (key && (provider === 'claudecode' || provider === 'anthropic')) {
      saveLastPrefix({ provider, model: model || null, messages, capturedAt: Date.now() });
    }
  } catch (err) {
    send(res, { type: 'error', message: String(err?.message || err) });
  } finally {
    res.end();
  }
});

server.listen(PORT, () => {
  const keys = Object.entries(PROVIDERS)
    .map(([name, p]) => `${name}:${p.key() ? '已配置' : 'mock'}`)
    .join('  ');
  console.log(`🐾 呼噜代理已启动 http://localhost:${PORT}  [${keys}]`);
});

// pm2 重启/停止发的是 SIGTERM——不主动关监听 socket 的话，端口释放全靠进程退出的默认行为，
// 遇到还有请求在流式传输时可能不够快，新进程抢着 listen 就撞上 EADDRINUSE。
// 收到信号主动 server.close()，3 秒兜底超时强制退出，让端口尽快真正让出来。
function shutdown(signal) {
  console.log(`收到 ${signal}，关闭监听...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
