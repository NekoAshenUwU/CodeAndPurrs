#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly STAGE="$(mktemp -d /tmp/codeandpurrs-ai-play-v3.XXXXXX)"
readonly BACKUP="/root/backups/codeandpurrs-ai-play-v3-${STAMP}"
readonly FILES=("server/proxy.mjs" "src/pages/PurrChannelPage.tsx" "src/services/spotify.ts" "src/styles/global.css")

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。"
  exit 1
fi
if [[ "${APP}" != "/var/www/codeandpurrs" ]]; then
  echo "拒绝操作未知目录：${APP}"
  exit 1
fi
for command_name in tar node npm pm2 curl python3; do
  command -v "${command_name}" >/dev/null || { echo "缺少命令：${command_name}"; exit 1; }
done
[[ -f "${APP}/server/proxy.mjs" && -f "${APP}/src/pages/PurrChannelPage.tsx" && -f "${APP}/src/services/spotify.ts" && -f "${APP}/src/styles/global.css" && -d "${APP}/dist" ]] || {
  echo "CodeAndPurrs 目录结构不符合预期，未改动。"
  exit 1
}
pm2 describe codeandpurrs >/dev/null || {
  echo "没有找到 PM2 进程 codeandpurrs，未改动。"
  exit 1
}

tang_before="$(systemctl is-active tang-web.service 2>/dev/null || true)"
(
  cd "${APP}"
  tar --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='server/data' -cf - .
) | (
  cd "${STAGE}"
  tar -xf -
)

# 以 VPS 当前源码为底，只注入 AI 点歌增量；任何锚点不唯一都会在临时目录中停止。
python3 - "${STAGE}" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])

def inject_before(relative, marker, block, sentinel):
    path = root / relative
    text = path.read_text(encoding="utf-8")
    if sentinel in text:
        return
    count = text.count(marker)
    if count != 1:
        raise SystemExit(f"补丁锚点异常：{relative}（命中 {count} 次），未改动线上。")
    path.write_text(text.replace(marker, block + marker, 1), encoding="utf-8")

def replace_once(relative, old, new, sentinel):
    path = root / relative
    text = path.read_text(encoding="utf-8")
    if sentinel in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"补丁锚点异常：{relative}（命中 {count} 次），未改动线上。")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")

def inject_before_last(relative, marker, block, sentinel):
    path = root / relative
    text = path.read_text(encoding="utf-8")
    if sentinel in text:
        return
    index = text.rfind(marker)
    if index < 0:
        raise SystemExit(f"补丁结构定位失败：{relative}，未改动线上。")
    path.write_text(text[:index] + block + text[index:], encoding="utf-8")

inject_before(
    "src/services/spotify.ts",
    "function loadSpotifySdk(): Promise<void> {",
    '''export type SpotifyAIPlayResult = {
  ok: true;
  device: { id: string; name: string; type: string };
  tracks: SpotifyTrack[];
};

// 呼噜频道所有模型共用这条服务端播放桥；token 和设备选择只留在后端。
export async function playSpotifyQueries(queries: string[]): Promise<SpotifyAIPlayResult> {
  return json<SpotifyAIPlayResult>(
    await fetch('/api/spotify/ai-play', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
    }),
  );
}

''',
    "export async function playSpotifyQueries(",
)

inject_before(
    "src/services/spotify.ts",
    "function loadSpotifySdk(): Promise<void> {",
    '''export type SpotifyPlayback = {
  active: boolean;
  isPlaying: boolean;
  progressMs: number;
  track: SpotifyTrack | null;
  device: { id: string; name: string; type: string } | null;
};

export async function getSpotifyPlayback(): Promise<SpotifyPlayback> {
  return json<SpotifyPlayback>(
    await fetch('/api/spotify/playback', { credentials: 'include', cache: 'no-store' }),
  );
}

export async function controlSpotifyPlayback(action: 'pause' | 'resume' | 'next'): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch('/api/spotify/control', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  );
}

''',
    "export async function getSpotifyPlayback(",
)

inject_before(
    "src/pages/PurrChannelPage.tsx",
    "const WINDOWS_KEY = 'purr-channel:windows';",
    "import { playSpotifyQueries } from '../services/spotify';\n\n",
    "from '../services/spotify';",
)

replace_once(
    "src/pages/PurrChannelPage.tsx",
    "import { playSpotifyQueries } from '../services/spotify';",
    '''import {
  controlSpotifyPlayback,
  getSpotifyPlayback,
  playSpotifyQueries,
  type SpotifyPlayback,
  type SpotifyTrack,
} from '../services/spotify';''',
    "getSpotifyPlayback,",
)

inject_before(
    "src/pages/PurrChannelPage.tsx",
    "// 思考链折叠卡片：流式思考时自动展开，思考结束自动收起。",
    '''const SPOTIFY_PLAYLIST_MARK = '[[SPOTIFY_PLAYLIST:';
const SPOTIFY_PLAYLIST_TAG = /\\[\\[SPOTIFY_PLAYLIST:(\\{[\\s\\S]*?\\})\\]\\]/g;

function stripSpotifyPlaylistTags(content: string): string {
  let text = content.replace(SPOTIFY_PLAYLIST_TAG, '');
  const open = text.lastIndexOf(SPOTIFY_PLAYLIST_MARK);
  if (open >= 0 && text.indexOf(']]', open) < 0) text = text.slice(0, open);
  const partial = text.lastIndexOf('[[');
  if (partial >= 0 && SPOTIFY_PLAYLIST_MARK.startsWith(text.slice(partial))) text = text.slice(0, partial);
  return text;
}

function extractSpotifyPlaylistQueries(content: string): string[] {
  const queries: string[] = [];
  for (const match of content.matchAll(/\\[\\[SPOTIFY_PLAYLIST:(\\{[\\s\\S]*?\\})\\]\\]/g)) {
    try {
      const payload = JSON.parse(match[1]) as { queries?: unknown };
      if (!Array.isArray(payload.queries)) continue;
      for (const item of payload.queries) {
        const query = String(item || '').trim().slice(0, 200);
        if (query.length >= 2 && !queries.includes(query)) queries.push(query);
        if (queries.length >= 15) return queries;
      }
    } catch {
      // 控制 JSON 写坏时忽略点歌，不影响聊天正文。
    }
  }
  return queries;
}

''',
    "const SPOTIFY_PLAYLIST_MARK = '[[SPOTIFY_PLAYLIST:';",
)

inject_before(
    "src/pages/PurrChannelPage.tsx",
    "};\n\nconst uid =",
    "  spotify?: { deviceName: string; tracks: SpotifyTrack[]; startedAt: number }; // AI 点歌成功后嵌在回复里的播放器卡\n",
    "spotify?: { deviceName: string; tracks: SpotifyTrack[]; startedAt: number };",
)

inject_before(
    "src/pages/PurrChannelPage.tsx",
    "// 思考链折叠卡片：流式思考时自动展开，思考结束自动收起。",
    '''function SpotifyMusicCard({
  attachment,
  onError,
}: {
  attachment: NonNullable<Turn['spotify']>;
  onError: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ playback: SpotifyPlayback; checkedAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const fallback = attachment.tracks[0];

  const refresh = async () => {
    try {
      const playback = await getSpotifyPlayback();
      setSnapshot({ playback, checkedAt: Date.now() });
    } catch {
      // 点歌结果仍可显示；短暂网络错误不把整张卡变成报错。
    }
  };

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5_000);
    const tick = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = snapshot?.playback;
  const liveUri = live?.track?.uri;
  const liveBelongsToCard = Boolean(
    liveUri && attachment.tracks.some((item) => item.uri === liveUri),
  );
  const track = liveBelongsToCard ? live?.track || fallback : fallback;
  const isPlaying = snapshot ? liveBelongsToCard && Boolean(live?.active && live.isPlaying) : true;
  const baseProgress = liveBelongsToCard ? Number(live?.progressMs || 0) : Math.max(0, snapshot ? 0 : clock - attachment.startedAt);
  const movingProgress = isPlaying && snapshot ? baseProgress + Math.max(0, clock - snapshot.checkedAt) : baseProgress;
  const duration = Math.max(1, track?.durationMs || 1);
  const progress = Math.min(duration, Math.max(0, movingProgress));
  const queued = attachment.tracks.length > 1 ? `队列 ${attachment.tracks.length} 首` : attachment.deviceName;

  const control = async (action: 'pause' | 'resume' | 'next') => {
    if (busy) return;
    setBusy(true);
    try {
      await controlSpotifyPlayback(action);
      await new Promise<void>((resolve) => window.setTimeout(resolve, action === 'next' ? 500 : 180));
      await refresh();
    } catch (err) {
      onError(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="spotify-chat-card" aria-label="Spotify 正在播放">
      {track?.image ? (
        <img className="spotify-chat-card__cover" src={track.image} alt="" />
      ) : (
        <span className="spotify-chat-card__cover spotify-chat-card__cover--empty" aria-hidden="true">♪</span>
      )}
      <div className="spotify-chat-card__body">
        <div className="spotify-chat-card__eyebrow"><span>Listening Together</span><span>{queued}</span></div>
        <strong className="spotify-chat-card__title">{track?.name || 'Spotify'}</strong>
        <span className="spotify-chat-card__artist">{track?.artist || '正在准备播放'}</span>
        <div className="spotify-chat-card__timeline" aria-label={`已播放 ${fmt(Math.floor(progress / 1000))}`}>
          <span style={{ width: `${(progress / duration) * 100}%` }} />
        </div>
        <div className="spotify-chat-card__time"><span>{fmt(Math.floor(progress / 1000))}</span><span>{fmt(Math.floor(duration / 1000))}</span></div>
      </div>
      <div className="spotify-chat-card__controls">
        <button type="button" disabled={busy || Boolean(snapshot && !liveBelongsToCard)} onClick={() => void control(isPlaying ? 'pause' : 'resume')} aria-label={isPlaying ? '暂停' : '继续播放'}>
          {busy ? '…' : isPlaying ? 'Ⅱ' : '▶'}
        </button>
        {attachment.tracks.length > 1 ? <button type="button" disabled={busy || Boolean(snapshot && !liveBelongsToCard)} onClick={() => void control('next')} aria-label="下一首">›|</button> : null}
      </div>
    </section>
  );
}

''',
    "function SpotifyMusicCard(",
)

inject_before(
    "src/pages/PurrChannelPage.tsx",
    "    const out: ChatMessage[] = [{ role: 'system', content: sys }];",
    '''    sys +=
      '\\n\\n【Spotify 点歌·隐藏控制】当她明确要求你点歌、选歌、播放某首歌或播放一组歌时，由你亲自决定真实存在的歌曲，' +
      '正常回复她以后，在回复最后单独加一行 `[[SPOTIFY_PLAYLIST:{"queries":["歌名 歌手"]}]]`。' +
      'queries 必须按播放顺序排列，每项写“准确歌名 歌手”；指定一首就放一项，自由配歌单时默认 10 首，最多 15 首，不能编造歌曲。' +
      '只有她明确想听或想播放时才使用；只是聊天里提到歌名时不要触发。不要解释或展示控制标记，系统会自动隐藏并播放。';

''',
    "【Spotify 点歌·隐藏控制】",
)

replace_once(
    "src/pages/PurrChannelPage.tsx",
    "    let streamFailed = false;\n",
    "    let streamFailed = false;\n    let rawAssistantContent = '';\n",
    "let rawAssistantContent = '';",
)

replace_once(
    "src/pages/PurrChannelPage.tsx",
    "          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: t.content + chunk } : t)));",
    "          rawAssistantContent += chunk;\n          const visibleContent = stripSpotifyPlaylistTags(rawAssistantContent);\n          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: visibleContent } : t)));",
    "const visibleContent = stripSpotifyPlaylistTags(rawAssistantContent);",
)

replace_once(
    "src/pages/PurrChannelPage.tsx",
    "          markThinkDone();\n          setTurns((prev) => {",
    '''          markThinkDone();
          const spotifyQueries = extractSpotifyPlaylistQueries(rawAssistantContent);
          if (spotifyQueries.length && !streamFailed) {
            queueMicrotask(() => {
              void playSpotifyQueries(spotifyQueries)
                .then((result) => {
                  const first = result.tracks[0];
                  const suffix = result.tracks.length > 1 ? ` 等 ${result.tracks.length} 首` : '';
                  setNotice(`正在 ${result.device.name} 播放 · ${first.name}${suffix}`);
                })
                .catch((err) => {
                  const message = String((err as Error)?.message || err);
                  setNotice(message.includes('尚未连接') ? '去「他的歌单」连接 Spotify 后就能点歌' : message);
                });
            });
          }
          setTurns((prev) => {''',
    "const spotifyQueries = extractSpotifyPlaylistQueries(rawAssistantContent);",
)

replace_once(
    "src/pages/PurrChannelPage.tsx",
    '''                .then((result) => {
                  const first = result.tracks[0];
                  const suffix = result.tracks.length > 1 ? ` 等 ${result.tracks.length} 首` : '';
                  setNotice(`正在 ${result.device.name} 播放 · ${first.name}${suffix}`);
''',
    '''                .then((result) => {
                  const first = result.tracks[0];
                  const suffix = result.tracks.length > 1 ? ` 等 ${result.tracks.length} 首` : '';
                  patchTurn(botId, {
                    spotify: { deviceName: result.device.name, tracks: result.tracks, startedAt: Date.now() },
                  });
                  setNotice(`正在 ${result.device.name} 播放 · ${first.name}${suffix}`);
''',
    "spotify: { deviceName: result.device.name, tracks: result.tracks, startedAt: Date.now() },",
)

inject_before_last(
    "src/pages/PurrChannelPage.tsx",
    "{turn.redPacket ? (",
    "{turn.spotify ? <SpotifyMusicCard attachment={turn.spotify} onError={setNotice} /> : null}\n                ",
    "{turn.spotify ? <SpotifyMusicCard attachment={turn.spotify} onError={setNotice} /> : null}",
)

inject_before(
    "server/proxy.mjs",
    "async function planSpotifyPick(prompt) {",
    '''async function spotifyAIDevices(accessToken) {
  const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Spotify 设备查询失败（${response.status}）`);
  return Array.isArray(data?.devices) ? data.devices : [];
}

async function spotifyAIPlayUris(accessToken, device, uris) {
  if (!device?.id) throw new Error('Spotify 没有可用的播放设备，请打开 Spotify App 后再点歌');
  if (!device.is_active) {
    const transfer = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [device.id], play: false }),
    });
    if (!transfer.ok && transfer.status !== 204) {
      const data = await transfer.json().catch(() => ({}));
      throw new Error(data?.error?.message || `Spotify 设备切换失败（${transfer.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris }),
  });
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Spotify 播放失败（${response.status}）`);
  }
}

''',
    "async function spotifyAIDevices(accessToken)",
)

server_route = '''    if (requestPath === '/api/spotify/ai-play' && req.method === 'POST') {
      try {
        const body = await readJSON(req);
        const rawQueries = Array.isArray(body?.queries) ? body.queries : [];
        const queries = [...new Set(rawQueries
          .map((query) => String(query || '').trim().slice(0, 200))
          .filter((query) => query.length >= 2))].slice(0, 15);
        if (!queries.length) throw new Error('AI 还没有选出歌曲');
        const session = await spotifyAccessFor(req);
        const tracks = [];
        const seenUris = new Set();
        for (const query of queries) {
          const matches = await searchSpotify(session.accessToken, query, 5);
          const track = matches.find((item) => item.uri && !seenUris.has(item.uri));
          if (!track) continue;
          seenUris.add(track.uri);
          tracks.push(track);
        }
        if (!tracks.length) throw new Error('Spotify 曲库里没有找到 AI 选的歌');
        const devices = await spotifyAIDevices(session.accessToken);
        const usable = devices.filter((device) => device?.id && !device?.is_restricted);
        const device = usable.find((item) => item.is_active) || usable[0];
        if (!device) throw new Error('Spotify 没有可用的播放设备，请打开 Spotify App 后再点歌');
        await spotifyAIPlayUris(session.accessToken, device, tracks.map((track) => track.uri));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          device: { id: device.id, name: String(device.name || 'Spotify'), type: String(device.type || '') },
          tracks,
        }));
      } catch (err) {
        const message = String(err?.message || err);
        const status = message.includes('尚未连接') || message.includes('登录已失效') ? 401 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

'''
inject_before(
    "server/proxy.mjs",
    "    res.writeHead(404, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ error: 'not found' }));\n    return;\n  }\n\n  // ----- 呼噜频道私密云存档",
    server_route,
    "requestPath === '/api/spotify/ai-play'",
)

spotify_card_routes = '''    if (requestPath === '/api/spotify/playback' && req.method === 'GET') {
      try {
        const session = await spotifyAccessFor(req);
        const response = await fetch('https://api.spotify.com/v1/me/player', {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (response.status === 204) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ active: false, isPlaying: false, progressMs: 0, track: null, device: null }));
          return;
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error?.message || `Spotify 播放状态查询失败（${response.status}）`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          active: Boolean(data?.item),
          isPlaying: Boolean(data?.is_playing),
          progressMs: Number(data?.progress_ms || 0),
          track: data?.item ? normalizeSpotifyTrack(data.item) : null,
          device: data?.device?.id ? {
            id: String(data.device.id),
            name: String(data.device.name || 'Spotify'),
            type: String(data.device.type || ''),
          } : null,
        }));
      } catch (err) {
        const message = String(err?.message || err);
        const status = message.includes('尚未连接') || message.includes('登录已失效') ? 401 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (requestPath === '/api/spotify/control' && req.method === 'POST') {
      try {
        const body = await readJSON(req);
        const action = String(body?.action || '');
        const command = {
          pause: { method: 'PUT', path: 'pause' },
          resume: { method: 'PUT', path: 'play' },
          next: { method: 'POST', path: 'next' },
        }[action];
        if (!command) throw new Error('不支持这个播放操作');
        const session = await spotifyAccessFor(req);
        const response = await fetch(`https://api.spotify.com/v1/me/player/${command.path}`, {
          method: command.method,
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (!response.ok && response.status !== 204) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.error?.message || `Spotify 播放控制失败（${response.status}）`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const message = String(err?.message || err);
        const status = message.includes('尚未连接') || message.includes('登录已失效') ? 401 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

'''
inject_before(
    "server/proxy.mjs",
    "    res.writeHead(404, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ error: 'not found' }));\n    return;\n  }\n\n  // ----- 呼噜频道私密云存档",
    spotify_card_routes,
    "requestPath === '/api/spotify/playback'",
)

inject_before(
    "src/styles/global.css",
    "/* ---------- 语音气泡（微信式）---------- */",
    '''/* AI 点歌成功后留在聊天记录里的 Spotify 控制卡。 */
.spotify-chat-card {
  position: relative;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  width: min(100%, 440px);
  padding: 11px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 18px;
  color: #5d4679;
  background: radial-gradient(circle at 12% 15%, rgba(187, 255, 246, 0.48), transparent 42%), linear-gradient(135deg, rgba(249, 240, 255, 0.88), rgba(222, 207, 255, 0.72));
  box-shadow: 0 10px 24px rgba(109, 81, 153, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(22px) saturate(1.25);
  backdrop-filter: blur(22px) saturate(1.25);
}
.spotify-chat-card__cover { width: 58px; height: 58px; object-fit: cover; border-radius: 14px; box-shadow: 0 5px 15px rgba(71, 50, 104, 0.2); }
.spotify-chat-card__cover--empty { display: grid; place-items: center; color: #7d5da4; font-size: 1.7rem; background: rgba(255, 255, 255, 0.54); }
.spotify-chat-card__body { min-width: 0; }
.spotify-chat-card__eyebrow, .spotify-chat-card__time { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: rgba(93, 70, 121, 0.62); font-size: 0.58rem; line-height: 1.2; }
.spotify-chat-card__title, .spotify-chat-card__artist { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.spotify-chat-card__title { margin-top: 4px; color: #50376f; font-size: 0.83rem; }
.spotify-chat-card__artist { margin-top: 1px; color: rgba(80, 55, 111, 0.72); font-size: 0.65rem; }
.spotify-chat-card__timeline { height: 3px; margin-top: 7px; overflow: hidden; border-radius: 999px; background: rgba(95, 67, 128, 0.16); }
.spotify-chat-card__timeline > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7adfd3, #9f71e9); transition: width 0.35s linear; }
.spotify-chat-card__time { margin-top: 3px; font-variant-numeric: tabular-nums; }
.spotify-chat-card__controls { display: flex; flex-direction: column; gap: 5px; }
.spotify-chat-card__controls button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid rgba(255, 255, 255, 0.72); border-radius: 50%; color: #67478e; background: rgba(255, 255, 255, 0.52); box-shadow: 0 4px 12px rgba(91, 65, 126, 0.12); cursor: pointer; }
.spotify-chat-card__controls button:disabled { cursor: wait; opacity: 0.62; }
@media (max-width: 420px) {
  .spotify-chat-card { grid-template-columns: 50px minmax(0, 1fr) auto; gap: 9px; padding: 9px; }
  .spotify-chat-card__cover { width: 50px; height: 50px; }
}

''',
    ".spotify-chat-card {",
)

print("临时源码增量注入完成。")
PY

if [[ -d "${APP}/node_modules" ]]; then
  ln -s "${APP}/node_modules" "${STAGE}/node_modules"
else
  (cd "${STAGE}" && npm ci)
fi

node --check "${STAGE}/server/proxy.mjs"
(cd "${STAGE}" && npm run build)
[[ -f "${STAGE}/dist/index.html" ]] || {
  echo "构建没有产生 dist/index.html，未改动线上。"
  exit 1
}

mkdir -p "${BACKUP}"
for file in "${FILES[@]}"; do
  mkdir -p "${BACKUP}/$(dirname "${file}")"
  cp -a "${APP}/${file}" "${BACKUP}/${file}"
done
cp -a "${APP}/dist" "${BACKUP}/live-dist"

next_dist="${APP}/.dist-ai-play-v3-${STAMP}"
cp -a "${STAGE}/dist" "${next_dist}"
for file in "${FILES[@]}"; do
  install -m 0644 "${STAGE}/${file}" "${APP}/${file}"
done
mv "${APP}/dist" "${BACKUP}/deployed-old-dist"
mv "${next_dist}" "${APP}/dist"

deployment_ok=1
pm2 restart codeandpurrs --update-env >/dev/null || deployment_ok=0
sleep 3
curl -fsS http://127.0.0.1:8787/api/spotify/status >/dev/null || deployment_ok=0

if [[ "${deployment_ok}" -ne 1 ]]; then
  echo "健康检查失败，正在恢复 CodeAndPurrs 备份。"
  for file in "${FILES[@]}"; do
    cp -a "${BACKUP}/${file}" "${APP}/${file}"
  done
  mv "${APP}/dist" "${BACKUP}/failed-new-dist"
  mv "${BACKUP}/deployed-old-dist" "${APP}/dist"
  pm2 restart codeandpurrs --update-env >/dev/null || true
  echo "已回滚。备份：${BACKUP}"
  exit 1
fi

tang_after="$(systemctl is-active tang-web.service 2>/dev/null || true)"
echo "完成：CodeAndPurrs AI 点歌与聊天内播放器已部署。"
echo "备份：${BACKUP}"
echo "Tang 状态：${tang_before} -> ${tang_after}（未操作）"
echo "现在打开 CodeAndPurrs 呼噜频道，让任一 AI 说‘给我点一首歌’即可测试。"
