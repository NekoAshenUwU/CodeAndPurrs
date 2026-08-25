#!/usr/bin/env python3
"""Mount the Playlist MCP tools into the existing authenticated MCP server."""

from __future__ import annotations

import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


BASE_SERVER = Path(os.getenv("CODEANDPURRS_MCP_SERVER", "/root/codeandpurrs-mcp/server.py"))
PLAYLIST_SERVER = Path(os.getenv("PLAYLIST_MCP_SERVER", "/root/playlist-mcp/server.py"))
BACKUP_DIR = Path(os.getenv("CODEANDPURRS_BACKUP_DIR", "/root/backups"))
SERVICE = os.getenv("CODEANDPURRS_MCP_SERVICE", "codeandpurrs-mcp.service")
MCP_PORT = int(os.getenv("CODEANDPURRS_MCP_PORT", "8891"))
PLAYLIST_SOURCE = (
    "https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/"
    "8eb29bf674bafc0176f16bfe546958de6f3bf992/deploy/playlist-mcp/server.py"
)
BEGIN_MARKER = "# BEGIN NEKO PLAYLIST MCP TOOLS"
END_MARKER = "# END NEKO PLAYLIST MCP TOOLS"

MOUNT_BLOCK = r'''

# BEGIN NEKO PLAYLIST MCP TOOLS
# Loaded into the existing authenticated MCP so the original public URL and
# OAuth/DCR flow expose the Spotify tools too.
import importlib.util as _playlist_importlib_util
from pathlib import Path as _PlaylistPath

_playlist_module_path = _PlaylistPath("/root/playlist-mcp/server.py")
_playlist_spec = _playlist_importlib_util.spec_from_file_location(
    "_neko_playlist_mcp_tools", _playlist_module_path
)
if _playlist_spec is None or _playlist_spec.loader is None:
    raise RuntimeError(f"无法载入点歌 MCP：{_playlist_module_path}")
_playlist_module = _playlist_importlib_util.module_from_spec(_playlist_spec)
_playlist_spec.loader.exec_module(_playlist_module)
__MCP_INSTANCE__.mount(_playlist_module.mcp)
# END NEKO PLAYLIST MCP TOOLS
'''


def atomic_write(path: Path, content: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def command(args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=check)


def service_exists() -> bool:
    result = command(["systemctl", "show", SERVICE, "--property=LoadState", "--value"], check=False)
    return result.stdout.strip() not in {"", "not-found"}


def listener_pids(port: int) -> list[int]:
    if not shutil.which("ss"):
        return []
    result = command(["ss", "-lntp"], check=False)
    pids: set[int] = set()
    for line in result.stdout.splitlines():
        if re.search(rf":{port}\b", line):
            pids.update(int(value) for value in re.findall(r"pid=(\d+)", line))
    return sorted(pids)


def clear_stale_listener(port: int) -> bool:
    pids = listener_pids(port)
    if not pids:
        return True
    for pid in pids:
        try:
            command_line = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", errors="replace"
            ).strip()
        except OSError:
            command_line = "unknown"
        print(f"清理占用 {port} 的旧进程 PID {pid}：{command_line[:180]}")
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(20):
        if not listener_pids(port):
            return True
        time.sleep(0.25)
    for pid in listener_pids(port):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(0.5)
    return not listener_pids(port)


def start_clean() -> subprocess.CompletedProcess[str]:
    command(["systemctl", "stop", SERVICE], check=False)
    time.sleep(1)
    if not clear_stale_listener(MCP_PORT):
        return subprocess.CompletedProcess([], 1, "", f"端口 {MCP_PORT} 仍被占用")
    return command(["systemctl", "start", SERVICE], check=False)


def restore(backup: Path) -> None:
    shutil.copy2(backup, BASE_SERVER)
    start_clean()


def main() -> int:
    if os.geteuid() != 0:
        print("停止：请在 VPS 的 root 登录状态下运行。", file=sys.stderr)
        return 2
    if not BASE_SERVER.is_file():
        print(f"停止：找不到现有 MCP：{BASE_SERVER}", file=sys.stderr)
        return 2
    if not shutil.which("systemctl") or not service_exists():
        print(f"停止：VPS 上找不到 {SERVICE}", file=sys.stderr)
        return 2

    print("[1/4] 同步点歌工具代码")
    PLAYLIST_SERVER.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(PLAYLIST_SOURCE, timeout=30) as response:
            playlist_content = response.read().decode("utf-8")
        if "def prepare_spotify_playlist" not in playlist_content:
            raise RuntimeError("下载内容缺少点歌工具")
        existing_mode = PLAYLIST_SERVER.stat().st_mode if PLAYLIST_SERVER.exists() else 0o600
        atomic_write(PLAYLIST_SERVER, playlist_content, existing_mode)
    except Exception as exc:
        if not PLAYLIST_SERVER.is_file():
            print(f"停止：点歌代码下载失败：{exc}", file=sys.stderr)
            return 2
        print(f"提示：GitHub 下载失败，沿用 VPS 现有点歌代码（{exc}）")

    source = BASE_SERVER.read_text(encoding="utf-8")
    instance_match = re.search(
        r"(?m)^\s*([A-Za-z_]\w*)(?:\s*:\s*[^=\n]+)?\s*=\s*(?:fastmcp\.)?FastMCP\s*\(",
        source,
    )
    if instance_match is not None:
        instance_name = instance_match.group(1)
    else:
        decorator_match = re.search(
            r"(?m)^\s*@([A-Za-z_]\w*)\.tool(?:\s*\(|\s*$)", source
        )
        run_match = re.search(r"(?m)^.*\b([A-Za-z_]\w*)\.run\s*\(", source)
        inferred_match = decorator_match or run_match
        instance_name = inferred_match.group(1) if inferred_match is not None else ""
    if not instance_name:
        print("停止：现有 server.py 的 MCP 结构不符合预期，未修改。", file=sys.stderr)
        return 2

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = BACKUP_DIR / f"codeandpurrs-mcp-before-playlist-{stamp}.py"
    shutil.copy2(BASE_SERVER, backup)
    print(f"[2/4] 已备份 {backup}")

    mount_block = MOUNT_BLOCK.replace("__MCP_INSTANCE__", instance_name)
    if BEGIN_MARKER in source:
        marker_pattern = re.compile(
            rf"(?ms)^\s*{re.escape(BEGIN_MARKER)}\n.*?^\s*{re.escape(END_MARKER)}\s*\n?"
        )
        updated, replacements = marker_pattern.subn(
            mount_block.strip("\n") + "\n", source, count=1
        )
        if replacements != 1:
            print("停止：旧点歌挂载区块无法安全替换，未修改。", file=sys.stderr)
            return 2
        atomic_write(BASE_SERVER, updated, BASE_SERVER.stat().st_mode)
        print(f"[3/4] 点歌工具已改用官方 mount 挂载（实例：{instance_name}）")
    else:
        guard_match = re.search(
            r"(?m)^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", source
        )
        if guard_match is not None:
            index = guard_match.start()
        else:
            run_matches = list(
                re.finditer(rf"(?m)^.*\b{re.escape(instance_name)}\.run\s*\(", source)
            )
            index = run_matches[-1].start() if run_matches else len(source)
        updated = source[:index] + mount_block + "\n" + source[index:]
        atomic_write(BASE_SERVER, updated, BASE_SERVER.stat().st_mode)
        print(f"[3/4] 五个 Spotify 工具已挂载（实例：{instance_name}）")

    compiled = command(
        [sys.executable, "-m", "py_compile", str(BASE_SERVER), str(PLAYLIST_SERVER)],
        check=False,
    )
    if compiled.returncode != 0:
        restore(backup)
        print("失败：语法检查未通过，已经恢复原 MCP。", file=sys.stderr)
        print(compiled.stderr.strip(), file=sys.stderr)
        return 1

    restarted = start_clean()
    time.sleep(3)
    active = command(["systemctl", "is-active", SERVICE], check=False)
    if restarted.returncode != 0 or active.stdout.strip() != "active":
        logs = command(
            ["journalctl", "-u", SERVICE, "-n", "30", "--no-pager"], check=False
        )
        restore(backup)
        print("失败：新 MCP 未能启动，已经自动恢复并重启原服务。", file=sys.stderr)
        if restarted.stderr.strip():
            print(restarted.stderr.strip(), file=sys.stderr)
        if logs.stdout.strip():
            print(logs.stdout.strip(), file=sys.stderr)
        return 1

    print(f"[4/4] {SERVICE}：active")
    print("完成：原 MCP 链接现在包含五个点歌工具。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
