#!/usr/bin/env bash
set -Eeuo pipefail

readonly FILE="/var/www/codeandpurrs/src/pages/PurrChannelPage.tsx"
[[ -f "${FILE}" ]] || { echo "找不到 ${FILE}"; exit 1; }

python3 - "${FILE}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

checks = [
    ("A_SPOTIFY_IMPORT_ANY", "../services/spotify"),
    ("B_SPOTIFY_IMPORT_OLD", "import { playSpotifyQueries } from '../services/spotify';"),
    ("C_SPOTIFY_IMPORT_NEW", "getSpotifyPlayback,"),
    ("D_PLAYLIST_HELPER", "const SPOTIFY_PLAYLIST_MARK = '[[SPOTIFY_PLAYLIST:';"),
    ("E_TURN_END", "};\n\nconst uid ="),
    ("F_MUSIC_CARD", "function SpotifyMusicCard("),
    ("G_MESSAGE_ARRAY", "    const out: ChatMessage[] = [{ role: 'system', content: sys }];"),
    ("H_STREAM_FLAG", "    let streamFailed = false;\n"),
    ("I_CONTENT_APPEND", "          setTurns((prev) => prev.map((t) => (t.id === botId ? { ...t, content: t.content + chunk } : t)));"),
    ("J_DONE_ANCHOR", "          markThinkDone();\n          setTurns((prev) => {"),
    ("K_PLAY_REQUEST", "const spotifyQueries = extractSpotifyPlaylistQueries(rawAssistantContent);"),
    ("L_CARD_ATTACHMENT", "spotify: { deviceName: result.device.name, tracks: result.tracks, startedAt: Date.now() },"),
    ("M_RED_PACKET_RENDER", "{turn.redPacket ? ("),
    ("N_CARD_RENDER", "{turn.spotify ? <SpotifyMusicCard attachment={turn.spotify} onError={setNotice} /> : null}"),
]

print(f"文件：{path}")
print(f"大小：{len(text)} 字符")
for label, needle in checks:
    print(f"{label}={text.count(needle)}")

print("--- 结构行 ---")
tokens = ("services/spotify", "onContent:", "onDone:", "streamFailed", "const out:", "turn.redPacket")
for number, line in enumerate(text.splitlines(), 1):
    if any(token in line for token in tokens):
        print(f"{number}: {line.strip()[:220]}")
PY
