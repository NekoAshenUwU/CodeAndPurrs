#!/usr/bin/env python3
"""Neko Playlist remote MCP.

The service reuses the Spotify OAuth session created by CodeAndPurrs.  It is
bound to localhost; nginx/auth is configured separately before public use.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP


APP_DIR = Path(os.getenv("PLAYLIST_MCP_DIR", "/root/playlist-mcp"))
CODEANDPURRS_DIR = Path(os.getenv("CODEANDPURRS_DIR", "/var/www/codeandpurrs"))
ENV_FILE = Path(os.getenv("CODEANDPURRS_ENV", str(CODEANDPURRS_DIR / ".env")))
SESSION_FILE = Path(
    os.getenv(
        "SPOTIFY_SESSION_PATH",
        str(CODEANDPURRS_DIR / "server/data/spotify-sessions.json"),
    )
)
STATE_FILE = APP_DIR / "playlist-state.json"
TOKEN_LOCK = threading.Lock()

mcp = FastMCP(
    "Neko Playlist",
    instructions=(
        "This is Neko's private Spotify playlist controller. When the user asks "
        "Ashen to choose music, generate 1-15 distinct real song-and-artist search "
        "queries (default 10), call prepare_spotify_playlist, then pass the returned "
        "ordered URIs to play_spotify_playlist. Preserve the requested mood and flow."
    ),
)


def _load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _load_sessions() -> dict[str, dict]:
    if not SESSION_FILE.exists():
        raise RuntimeError("Spotify 尚未在『他的歌单』完成授权")
    try:
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Spotify 授权资料读取失败") from exc
    if not isinstance(data, dict) or not data:
        raise RuntimeError("Spotify 尚未在『他的歌单』完成授权")
    return data


def _latest_session(sessions: dict[str, dict]) -> tuple[str, dict]:
    candidates = [
        (sid, session)
        for sid, session in sessions.items()
        if isinstance(session, dict) and session.get("refreshToken")
    ]
    if not candidates:
        raise RuntimeError("Spotify 授权已失效，请在『他的歌单』重新连接")
    return max(candidates, key=lambda item: int(item[1].get("createdAt") or 0))


def _save_sessions(sessions: dict[str, dict]) -> None:
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="spotify-sessions-", dir=SESSION_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(sessions, handle, ensure_ascii=False, separators=(",", ":"))
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, SESSION_FILE)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _form_request(url: str, fields: dict[str, str], headers: dict[str, str]) -> dict:
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(fields).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(payload).get("error_description") or payload
        except json.JSONDecodeError:
            detail = payload
        raise RuntimeError(f"Spotify token 刷新失败：{detail}") from exc


def _access_token() -> str:
    with TOKEN_LOCK:
        sessions = _load_sessions()
        sid, session = _latest_session(sessions)
        if session.get("accessToken") and int(session.get("expiresAt") or 0) > int(time.time() * 1000) + 60_000:
            return str(session["accessToken"])

        env = _load_env()
        client_id = env.get("SPOTIFY_CLIENT_ID", "")
        client_secret = env.get("SPOTIFY_CLIENT_SECRET", "")
        if not client_id or not client_secret:
            raise RuntimeError("VPS 尚未配置 Spotify Client ID / Secret")

        import base64

        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        token = _form_request(
            "https://accounts.spotify.com/api/token",
            {
                "grant_type": "refresh_token",
                "refresh_token": str(session["refreshToken"]),
            },
            {
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        access_token = str(token.get("access_token") or "")
        if not access_token:
            raise RuntimeError("Spotify 没有返回 access token")
        session["accessToken"] = access_token
        session["refreshToken"] = token.get("refresh_token") or session["refreshToken"]
        session["expiresAt"] = int(time.time() * 1000) + int(token.get("expires_in") or 3600) * 1000
        sessions[sid] = session
        _save_sessions(sessions)
        return access_token


def _spotify_request(method: str, path: str, body: dict | None = None) -> dict | None:
    headers = {"Authorization": f"Bearer {_access_token()}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.spotify.com/v1{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload)
            detail = parsed.get("error", {}).get("message") or parsed
        except json.JSONDecodeError:
            detail = payload
        raise RuntimeError(f"Spotify 请求失败（{exc.code}）：{detail}") from exc


def _track(track: dict, query: str = "") -> dict:
    artists = "、".join(
        str(artist.get("name") or "") for artist in track.get("artists", []) if artist.get("name")
    )
    images = (track.get("album") or {}).get("images") or []
    return {
        "id": str(track.get("id") or ""),
        "uri": str(track.get("uri") or ""),
        "name": str(track.get("name") or ""),
        "artist": artists,
        "album": str((track.get("album") or {}).get("name") or ""),
        "image": images[0].get("url") if images else None,
        "durationMs": int(track.get("duration_ms") or 0),
        "query": query,
    }


def _devices() -> list[dict]:
    data = _spotify_request("GET", "/me/player/devices") or {}
    return [device for device in data.get("devices", []) if isinstance(device, dict)]


def _select_device(device_id: str = "") -> dict:
    devices = _devices()
    if device_id:
        match = next((device for device in devices if device.get("id") == device_id), None)
        if match:
            return match
    active = next((device for device in devices if device.get("is_active") and not device.get("is_restricted")), None)
    if active:
        return active
    available = next((device for device in devices if not device.get("is_restricted")), None)
    if available:
        return available
    raise RuntimeError("没有可用的 Spotify 播放设备，请打开 Spotify App 或『他的歌单』")


def _save_state(tracks: list[dict], device: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps(
            {"tracks": tracks, "device": device, "startedAt": int(time.time() * 1000)},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    STATE_FILE.chmod(0o600)


@mcp.tool
def prepare_spotify_playlist(queries: list[str], limit_per_query: int = 3) -> dict:
    """Search Spotify for an ordered playlist.

    Use this after converting the user's mood/context into distinct real
    ``song artist`` queries. Supply 1-15 queries (default workflow: 10). The
    result preserves query order and returns playable candidates and URIs.
    This tool only reads Spotify and does not start playback.
    """
    cleaned = [str(query).strip()[:160] for query in queries if str(query).strip()][:15]
    if not cleaned:
        raise ValueError("至少需要一首歌的搜索词")
    per_query = max(1, min(int(limit_per_query), 5))
    selected: list[dict] = []
    candidates: list[dict] = []
    seen: set[str] = set()

    for query in cleaned:
        params = urllib.parse.urlencode({"q": query, "type": "track", "limit": per_query})
        data = _spotify_request("GET", f"/search?{params}") or {}
        items = (data.get("tracks") or {}).get("items") or []
        normalized = [_track(item, query) for item in items if item and item.get("is_playable") is not False]
        candidates.extend(normalized)
        chosen = next((item for item in normalized if item["uri"] and item["uri"] not in seen), None)
        if chosen:
            selected.append(chosen)
            seen.add(chosen["uri"])

    if not selected:
        raise RuntimeError("Spotify 曲库没有找到可播放歌曲")
    return {
        "count": len(selected),
        "tracks": selected,
        "uris": [item["uri"] for item in selected],
        "candidates": candidates,
    }


@mcp.tool
def list_spotify_devices() -> dict:
    """List Spotify Connect devices before playback; this is read-only."""
    devices = _devices()
    return {
        "devices": [
            {
                "id": device.get("id"),
                "name": device.get("name"),
                "type": device.get("type"),
                "active": bool(device.get("is_active")),
                "restricted": bool(device.get("is_restricted")),
            }
            for device in devices
        ]
    }


@mcp.tool
def play_spotify_playlist(uris: list[str], device_id: str = "") -> dict:
    """Start an ordered Spotify playlist on Neko's active device.

    This is a write action. Pass 1-15 ``spotify:track:`` URIs returned by
    prepare_spotify_playlist. If device_id is omitted, the active Spotify
    device is preferred, otherwise the first available device is used.
    """
    ordered = [str(uri).strip() for uri in uris if str(uri).startswith("spotify:track:")][:15]
    if not ordered:
        raise ValueError("播放清单没有有效的 Spotify 曲目")
    device = _select_device(device_id)
    selected_id = str(device.get("id") or "")
    _spotify_request("PUT", "/me/player", {"device_ids": [selected_id], "play": False})
    time.sleep(0.45)
    _spotify_request(
        "PUT",
        f"/me/player/play?device_id={urllib.parse.quote(selected_id)}",
        {"uris": ordered},
    )
    state_tracks = [{"uri": uri} for uri in ordered]
    _save_state(state_tracks, {"id": selected_id, "name": device.get("name"), "type": device.get("type")})
    return {
        "ok": True,
        "count": len(ordered),
        "device": {"id": selected_id, "name": device.get("name"), "type": device.get("type")},
        "message": f"已在 {device.get('name') or 'Spotify'} 开始依序播放 {len(ordered)} 首歌",
    }


@mcp.tool
def get_spotify_playback() -> dict:
    """Read the current Spotify track, device, progress and queue state."""
    playback = _spotify_request("GET", "/me/player")
    if not playback:
        return {"active": False, "message": "Spotify 当前没有播放中的设备"}
    item = playback.get("item") or {}
    return {
        "active": True,
        "playing": bool(playback.get("is_playing")),
        "progressMs": int(playback.get("progress_ms") or 0),
        "track": _track(item) if item else None,
        "device": {
            "id": (playback.get("device") or {}).get("id"),
            "name": (playback.get("device") or {}).get("name"),
            "type": (playback.get("device") or {}).get("type"),
        },
    }


@mcp.tool
def control_spotify(action: Literal["pause", "resume", "next", "previous"]) -> dict:
    """Pause, resume, skip to next, or return to previous Spotify track."""
    routes = {
        "pause": ("PUT", "/me/player/pause"),
        "resume": ("PUT", "/me/player/play"),
        "next": ("POST", "/me/player/next"),
        "previous": ("POST", "/me/player/previous"),
    }
    method, path = routes[action]
    _spotify_request(method, path)
    return {"ok": True, "action": action}


if __name__ == "__main__":
    host = os.getenv("PLAYLIST_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("PLAYLIST_MCP_PORT", "8891"))
    mcp.run(transport="http", host=host, port=port)
