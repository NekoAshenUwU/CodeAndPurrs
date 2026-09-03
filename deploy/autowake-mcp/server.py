#!/usr/bin/env python3
"""Private CodeAndPurrs auto-wake tools mounted into the authenticated MCP."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastmcp import FastMCP
from mcp.types import ImageContent, TextContent


CODEANDPURRS_DIR = Path(os.getenv("CODEANDPURRS_DIR", "/var/www/codeandpurrs"))
ENV_FILE = Path(os.getenv("CODEANDPURRS_ENV", str(CODEANDPURRS_DIR / ".env")))
AUTOWAKE_API = os.getenv("AUTOWAKE_API", "http://127.0.0.1:8787/api/autowake/mcp").rstrip("/")

mcp = FastMCP(
    "Neko Auto Wake",
    instructions=(
        "These private tools inspect and control the existing CodeAndPurrs background "
        "auto-wake service. A manual wake sends a Web Push notification to the registered "
        "CodeAndPurrs device; it does not create a message inside the current MCP client "
        "conversation. Use read tools freely. Ask for confirmation before disabling "
        "auto-wake or sending an immediate wake unless the user explicitly requested it. "
        "Recent screen images exist only while the Android screen-sharing bridge is active."
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


def _internal_key() -> str:
    key = os.getenv("AUTOWAKE_MCP_INTERNAL_KEY", "").strip()
    if not key:
        key = _load_env().get("AUTOWAKE_MCP_INTERNAL_KEY", "").strip()
    if not key:
        raise RuntimeError("VPS 尚未配置 AUTOWAKE_MCP_INTERNAL_KEY")
    return key


def _request(path: str, method: str = "GET", body: dict | None = None) -> dict:
    headers = {
        "Accept": "application/json",
        "X-Autowake-MCP-Key": _internal_key(),
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{AUTOWAKE_API}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=190) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(payload).get("error") or payload
        except json.JSONDecodeError:
            detail = payload
        raise RuntimeError(f"自动唤醒后端返回 {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"连接不到 CodeAndPurrs 自动唤醒后端：{exc.reason}") from exc


def _device_query(device: str) -> str:
    value = str(device or "").strip()
    return f"?device={urllib.parse.quote(value)}" if value else ""


@mcp.tool
def get_autowake_status(device: str = "") -> dict:
    """Read schedule, limits, registered CodeAndPurrs devices, and unread counts.

    ``device`` is optional. Use the short device identifier returned by this tool only
    when more than one device is registered. This tool does not expose chat history,
    room names, personas, model/provider identities, error text, system prompts, push
    endpoints, cookies, or secret keys.
    """

    return _request(f"/status{_device_query(device)}")


@mcp.tool
def set_codeandpurrs_autowake(enabled: bool, device: str = "") -> dict:
    """Enable or disable CodeAndPurrs background auto-wake for one registered device.

    This is a write action. If ``device`` is omitted, the most recently updated device
    is selected. A device must first subscribe from the CodeAndPurrs page before it can
    be enabled here.
    """

    return _request("/enabled", method="POST", body={"enabled": bool(enabled), "device": device})


@mcp.tool
def send_codeandpurrs_wake_now(device: str = "", dry_run: bool = False) -> dict:
    """Generate and send one immediate CodeAndPurrs wake to the registered phone.

    This is a write action and bypasses the normal time and cooldown checks because it
    is an explicit user request. It still uses the saved room persona/context and the
    recent short-lived screen story when available. Set ``dry_run`` to true to verify
    the target without generating a model response or sending Web Push.
    """

    return _request(
        "/run",
        method="POST",
        body={"device": device, "dryRun": bool(dry_run)},
    )


@mcp.tool
def list_autowake_deliveries(
    device: str = "", limit: int = 10, unread_only: bool = False
) -> dict:
    """Read recent CodeAndPurrs wake deliveries without acknowledging or deleting them."""

    params = {
        "limit": str(max(1, min(int(limit), 50))),
        "unread": "1" if unread_only else "0",
    }
    if str(device).strip():
        params["device"] = str(device).strip()
    return _request(f"/deliveries?{urllib.parse.urlencode(params)}")


@mcp.tool
def look_at_recent_screen(seconds: int = 60, max_frames: int = 4) -> list:
    """Look at up to four distinct Android screen scenes from the recent short-lived queue.

    The phone must already be actively sharing its screen. The server does not open apps,
    capture historical screens, or return frames older than two minutes. Private payment,
    password, login, and verification-code details visible in a frame must be ignored.
    """

    params = urllib.parse.urlencode(
        {
            "seconds": max(10, min(int(seconds), 120)),
            "maxFrames": max(1, min(int(max_frames), 4)),
        }
    )
    result = _request(f"/screen?{params}")
    frames = result.get("frames") or []
    blocks: list = [
        TextContent(
            type="text",
            text=(
                f"最近屏幕轨迹：{len(frames)} 个不同画面。"
                if frames
                else "最近没有可看的共享画面；手机可能未在共享，或画面已经过期。"
            ),
        )
    ]
    for index, frame in enumerate(frames, start=1):
        data_url = str(frame.get("dataUrl") or "")
        if not data_url.startswith("data:") or ";base64," not in data_url:
            continue
        header, encoded = data_url.split(",", 1)
        mime_type = header[5:].split(";", 1)[0]
        try:
            base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            continue
        blocks.append(
            TextContent(
                type="text",
                text=(
                    f"屏幕轨迹 {index}/{len(frames)}；"
                    f"capturedAt={int(frame.get('capturedAt') or 0)}；"
                    f"sceneVersion={int(frame.get('sceneVersion') or 0)}"
                ),
            )
        )
        blocks.append(ImageContent(type="image", data=encoded, mimeType=mime_type))
    return blocks


if __name__ == "__main__":
    host = os.getenv("AUTOWAKE_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("AUTOWAKE_MCP_PORT", "8893"))
    mcp.run(transport="http", host=host, port=port)
