#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly STAGE="$(mktemp -d /tmp/codeandpurrs-ai-play-v2.XXXXXX)"
readonly BACKUP="/root/backups/codeandpurrs-ai-play-v2-${STAMP}"
readonly FILES=("server/proxy.mjs" "src/pages/PurrChannelPage.tsx" "src/services/spotify.ts")

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
[[ -f "${APP}/server/proxy.mjs" && -f "${APP}/src/pages/PurrChannelPage.tsx" && -f "${APP}/src/services/spotify.ts" && -d "${APP}/dist" ]] || {
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
    "src/pages/PurrChannelPage.tsx",
    "const WINDOWS_KEY = 'purr-channel:windows';",
    "import { playSpotifyQueries } from '../services/spotify';\n\n",
    "import { playSpotifyQueries } from '../services/spotify';",
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

next_dist="${APP}/.dist-ai-play-v2-${STAMP}"
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
echo "完成：CodeAndPurrs AI 点歌已部署。"
echo "备份：${BACKUP}"
echo "Tang 状态：${tang_before} -> ${tang_after}（未操作）"
echo "现在打开 CodeAndPurrs 呼噜频道，让任一 AI 说‘给我点一首歌’即可测试。"
