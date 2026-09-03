#!/usr/bin/env python3
"""Mount auto-wake tools into the existing authenticated CodeAndPurrs MCP."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


BASE_SERVER = Path(os.getenv("CODEANDPURRS_MCP_SERVER", "/root/codeandpurrs-mcp/server.py"))
TOOL_SERVER = Path(os.getenv("AUTOWAKE_MCP_SERVER", "/root/autowake-mcp/server.py"))
APP_DIR = Path(os.getenv("CODEANDPURRS_DIR", "/var/www/codeandpurrs"))
APP_ENV = APP_DIR / ".env"
BACKUP_ROOT = Path(os.getenv("CODEANDPURRS_BACKUP_DIR", "/root/backups"))
MCP_SERVICE = os.getenv("CODEANDPURRS_MCP_SERVICE", "codeandpurrs-mcp.service")
MCP_PORT = int(os.getenv("CODEANDPURRS_MCP_PORT", "8891"))
PM2_PROCESS = os.getenv("CODEANDPURRS_PM2_PROCESS", "codeandpurrs")
SOURCE_REF = os.getenv("CODEANDPURRS_AUTOWAKE_REF", "codex/frontend-ai-playlist-20260828")
TOOL_SOURCE = (
    "https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/"
    f"{SOURCE_REF}/deploy/autowake-mcp/server.py"
)
BEGIN_MARKER = "# BEGIN NEKO AUTOWAKE MCP TOOLS"
END_MARKER = "# END NEKO AUTOWAKE MCP TOOLS"

MOUNT_BLOCK = r'''

# BEGIN NEKO AUTOWAKE MCP TOOLS
# Mounted into the existing authenticated public MCP. The module itself only
# talks to CodeAndPurrs over a keyed localhost route.
import importlib.util as _autowake_importlib_util
from pathlib import Path as _AutoWakePath

_autowake_module_path = _AutoWakePath("/root/autowake-mcp/server.py")
_autowake_spec = _autowake_importlib_util.spec_from_file_location(
    "_neko_autowake_mcp_tools", _autowake_module_path
)
if _autowake_spec is None or _autowake_spec.loader is None:
    raise RuntimeError(f"无法载入自动唤醒 MCP：{_autowake_module_path}")
_autowake_module = _autowake_importlib_util.module_from_spec(_autowake_spec)
_autowake_spec.loader.exec_module(_autowake_module)
__MCP_INSTANCE__.mount(_autowake_module.mcp)
# END NEKO AUTOWAKE MCP TOOLS
'''


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(temp_path, mode & 0o777)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def command(args: list[str], check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=check)


def service_exists(name: str) -> bool:
    result = command(["systemctl", "show", name, "--property=LoadState", "--value"])
    return result.stdout.strip() not in {"", "not-found"}


def port_listener_pids(port: int) -> tuple[list[int], str]:
    result = command(["ss", "-H", "-ltnp", f"sport = :{port}"])
    if result.returncode != 0:
        raise RuntimeError(f"无法检查 MCP 端口 {port}：{result.stderr.strip()}")
    pids = sorted({int(pid) for pid in re.findall(r"pid=(\d+)", result.stdout)})
    return pids, result.stdout.strip()


def process_command(pid: int) -> str:
    try:
        return (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode(
            "utf-8", errors="replace"
        )
    except OSError:
        return ""


def wait_for_port_release(timeout: float) -> tuple[list[int], str]:
    deadline = time.monotonic() + timeout
    listeners: tuple[list[int], str] = ([], "")
    while time.monotonic() < deadline:
        listeners = port_listener_pids(MCP_PORT)
        if not listeners[0] and not listeners[1]:
            return listeners
        time.sleep(0.25)
    return port_listener_pids(MCP_PORT)


def stop_mcp_and_release_port() -> None:
    stopped = command(["systemctl", "stop", MCP_SERVICE])
    if stopped.returncode != 0:
        raise RuntimeError(f"无法停止 {MCP_SERVICE}：{stopped.stderr.strip()}")

    # KillMode=process may leave an old FastMCP/Uvicorn child behind. Asking
    # systemd to terminate the whole unit cgroup is safe and does not touch the
    # Tang/playlist services.
    command(["systemctl", "kill", "--kill-who=all", "--signal=SIGTERM", MCP_SERVICE])
    pids, details = wait_for_port_release(5)
    if not pids and not details:
        return

    expected = str(BASE_SERVER.resolve())
    stale: list[int] = []
    foreign: list[str] = []
    for pid in pids:
        cmdline = process_command(pid)
        if expected in cmdline or str(BASE_SERVER) in cmdline:
            stale.append(pid)
        else:
            foreign.append(f"pid={pid} {cmdline or '<unknown>'}")
    if foreign:
        raise RuntimeError(
            f"MCP 端口 {MCP_PORT} 被其他程序占用，未自动终止："
            + "; ".join(foreign)
            + (f"；ss={details}" if details else "")
        )

    for pid in stale:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    pids, details = wait_for_port_release(5)
    if pids or details:
        for pid in pids:
            cmdline = process_command(pid)
            if expected not in cmdline and str(BASE_SERVER) not in cmdline:
                raise RuntimeError(f"MCP 端口 {MCP_PORT} 仍被其他程序占用：{details}")
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        pids, details = wait_for_port_release(3)
    if pids or details:
        raise RuntimeError(f"旧 MCP 进程未释放端口 {MCP_PORT}：{details}")


def restart_mcp_service() -> None:
    stop_mcp_and_release_port()
    started = command(["systemctl", "start", MCP_SERVICE])
    if started.returncode != 0:
        raise RuntimeError(f"无法启动 {MCP_SERVICE}：{started.stderr.strip()}")
    time.sleep(3)
    active = command(["systemctl", "is-active", MCP_SERVICE])
    if active.stdout.strip() != "active":
        logs = command(["journalctl", "-u", MCP_SERVICE, "-n", "30", "--no-pager"])
        raise RuntimeError(f"MCP 重启失败：{logs.stdout.strip() or started.stderr.strip()}")


def find_mcp_instance(source: str) -> str:
    match = re.search(
        r"(?m)^\s*([A-Za-z_]\w*)(?:\s*:\s*[^=\n]+)?\s*=\s*(?:fastmcp\.)?FastMCP\s*\(",
        source,
    )
    if match:
        return match.group(1)
    decorator = re.search(r"(?m)^\s*@([A-Za-z_]\w*)\.tool(?:\s*\(|\s*$)", source)
    run = re.search(r"(?m)^.*\b([A-Za-z_]\w*)\.run\s*\(", source)
    inferred = decorator or run
    return inferred.group(1) if inferred else ""


def mount_tools(source: str, instance: str) -> str:
    block = MOUNT_BLOCK.replace("__MCP_INSTANCE__", instance)
    if BEGIN_MARKER in source:
        pattern = re.compile(
            rf"(?ms)^\s*{re.escape(BEGIN_MARKER)}\n.*?^\s*{re.escape(END_MARKER)}\s*\n?"
        )
        updated, count = pattern.subn(block.strip("\n") + "\n", source, count=1)
        if count != 1:
            raise RuntimeError("旧自动唤醒挂载区块无法安全替换")
        return updated
    guard = re.search(r"(?m)^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", source)
    if guard:
        index = guard.start()
    else:
        runs = list(re.finditer(rf"(?m)^.*\b{re.escape(instance)}\.run\s*\(", source))
        index = runs[-1].start() if runs else len(source)
    return source[:index] + block + "\n" + source[index:]


def ensure_internal_key() -> str:
    source = APP_ENV.read_text(encoding="utf-8") if APP_ENV.exists() else ""
    match = re.search(r"(?m)^AUTOWAKE_MCP_INTERNAL_KEY=(.+)$", source)
    if match and match.group(1).strip():
        return match.group(1).strip().strip("\"'")
    key = secrets.token_urlsafe(48)
    separator = "" if not source or source.endswith("\n") else "\n"
    updated = f"{source}{separator}\n# GPT/Claude 公网 MCP 到本机自动唤醒后端的共享密钥\nAUTOWAKE_MCP_INTERNAL_KEY={key}\n"
    mode = APP_ENV.stat().st_mode if APP_ENV.exists() else 0o600
    atomic_write(APP_ENV, updated, mode)
    return key


def internal_status(key: str) -> dict:
    request = urllib.request.Request(
        "http://127.0.0.1:8787/api/autowake/mcp/status",
        headers={"X-Autowake-MCP-Key": key, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def restore(backup: Path, env_existed: bool, tool_existed: bool) -> None:
    if (backup / "public-mcp-server.py").exists():
        shutil.copy2(backup / "public-mcp-server.py", BASE_SERVER)
    if env_existed and (backup / "codeandpurrs.env").exists():
        shutil.copy2(backup / "codeandpurrs.env", APP_ENV)
    elif not env_existed:
        APP_ENV.unlink(missing_ok=True)
    if tool_existed and (backup / "autowake-mcp-server.py").exists():
        shutil.copy2(backup / "autowake-mcp-server.py", TOOL_SERVER)
    elif not tool_existed:
        TOOL_SERVER.unlink(missing_ok=True)
    command(["pm2", "restart", PM2_PROCESS, "--update-env"])
    try:
        restart_mcp_service()
    except RuntimeError as exc:
        print(f"警告：文件已回滚，但 MCP 服务未能重启：{exc}", file=sys.stderr)


def main() -> int:
    if os.geteuid() != 0:
        print("停止：请在 VPS 的 root 登录状态下运行。", file=sys.stderr)
        return 2
    required = [BASE_SERVER, APP_DIR / "server/autowake.mjs", APP_DIR / "server/proxy.mjs"]
    if not all(path.is_file() for path in required):
        print("停止：现有 MCP 或 CodeAndPurrs 自动唤醒后端不完整。", file=sys.stderr)
        return 2
    if "'/api/autowake/mcp/status'" not in (APP_DIR / "server/autowake.mjs").read_text(encoding="utf-8"):
        print("停止：请先部署包含 MCP 内网控制口的 CodeAndPurrs 后端。", file=sys.stderr)
        return 2
    if not service_exists(MCP_SERVICE) or command(["pm2", "describe", PM2_PROCESS]).returncode != 0:
        print("停止：找不到现有 MCP service 或 CodeAndPurrs PM2 进程。", file=sys.stderr)
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = BACKUP_ROOT / f"codeandpurrs-before-autowake-mcp-{stamp}"
    backup.mkdir(parents=True, exist_ok=True)
    env_existed = APP_ENV.exists()
    tool_existed = TOOL_SERVER.exists()
    shutil.copy2(BASE_SERVER, backup / "public-mcp-server.py")
    if env_existed:
        shutil.copy2(APP_ENV, backup / "codeandpurrs.env")
    if tool_existed:
        shutil.copy2(TOOL_SERVER, backup / "autowake-mcp-server.py")
    print(f"[1/5] 已备份到 {backup}")

    try:
        with urllib.request.urlopen(TOOL_SOURCE, timeout=30) as response:
            tool_source = response.read().decode("utf-8")
        if "def get_autowake_status" not in tool_source or "def look_at_recent_screen" not in tool_source:
            raise RuntimeError("下载内容缺少自动唤醒工具")
        tool_mode = TOOL_SERVER.stat().st_mode if TOOL_SERVER.exists() else 0o600
        atomic_write(TOOL_SERVER, tool_source, tool_mode)
        print("[2/5] 自动唤醒 MCP 工具已同步")

        base_source = BASE_SERVER.read_text(encoding="utf-8")
        instance = find_mcp_instance(base_source)
        if not instance:
            raise RuntimeError("现有 server.py 的 MCP 结构不符合预期")
        atomic_write(BASE_SERVER, mount_tools(base_source, instance), BASE_SERVER.stat().st_mode)
        print(f"[3/5] 五个工具已挂载到现有 MCP（实例：{instance}）")

        compiled = command([sys.executable, "-m", "py_compile", str(BASE_SERVER), str(TOOL_SERVER)])
        if compiled.returncode != 0:
            raise RuntimeError(f"Python 语法检查失败：{compiled.stderr.strip()}")

        key = ensure_internal_key()
        restarted_app = command(["pm2", "restart", PM2_PROCESS, "--update-env"])
        if restarted_app.returncode != 0:
            raise RuntimeError(f"CodeAndPurrs 重启失败：{restarted_app.stderr.strip()}")
        status = None
        for _ in range(20):
            try:
                status = internal_status(key)
                break
            except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
                time.sleep(1)
        if not isinstance(status, dict) or "devices" not in status:
            raise RuntimeError("自动唤醒内网控制口健康检查失败")
        print(f"[4/5] 内网控制口正常，登记设备 {len(status['devices'])} 个")

        restart_mcp_service()
        print(f"[5/5] {MCP_SERVICE}：active")
    except Exception as exc:
        restore(backup, env_existed, tool_existed)
        print(f"失败：{exc}\n已经恢复安装前状态。", file=sys.stderr)
        return 1

    print("完成：https://mcp.nekopurrs.uk/mcp 现在同时给 GPT App 和 Claude App 提供自动唤醒工具。")
    print("在两个 App 里刷新/重新连接该 MCP 后，会看到五个 Neko Auto Wake 工具。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
