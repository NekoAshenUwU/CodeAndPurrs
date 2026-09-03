#!/usr/bin/env python3
"""Mount auto-wake tools into the live FastMCP behind the OAuth gateway."""

from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


TOOL_SERVER = Path(os.getenv("AUTOWAKE_MCP_SERVER", "/root/autowake-mcp/server.py"))
APP_DIR = Path(os.getenv("CODEANDPURRS_DIR", "/var/www/codeandpurrs"))
APP_ENV = APP_DIR / ".env"
BACKUP_ROOT = Path(os.getenv("CODEANDPURRS_BACKUP_DIR", "/root/backups"))
BACKEND_PORT = int(os.getenv("CODEANDPURRS_MCP_BACKEND_PORT", "8890"))
SERVER_OVERRIDE = os.getenv("CODEANDPURRS_MCP_SERVER", "").strip()
SERVICE_OVERRIDE = os.getenv("CODEANDPURRS_MCP_SERVICE", "").strip()
PM2_PROCESS = os.getenv("CODEANDPURRS_PM2_PROCESS", "codeandpurrs")
SOURCE_REF = os.getenv(
    "CODEANDPURRS_AUTOWAKE_REF", "codex/frontend-ai-playlist-20260828"
)
TOOL_SOURCE = (
    "https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/"
    f"{SOURCE_REF}/deploy/autowake-mcp/server.py"
)
BEGIN_MARKER = "# BEGIN NEKO AUTOWAKE MCP TOOLS"
END_MARKER = "# END NEKO AUTOWAKE MCP TOOLS"

MOUNT_BLOCK = r'''

# BEGIN NEKO AUTOWAKE MCP TOOLS
# Mounted into the real FastMCP backend behind the existing tang-web OAuth
# gateway. The module only calls a keyed localhost CodeAndPurrs route.
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
    return result.returncode == 0 and result.stdout.strip() not in {"", "not-found"}


def port_listener_pids(port: int) -> tuple[list[int], str]:
    result = command(["ss", "-H", "-ltnp", f"sport = :{port}"])
    if result.returncode != 0:
        raise RuntimeError(f"无法检查端口 {port}：{result.stderr.strip()}")
    pids = sorted({int(pid) for pid in re.findall(r"pid=(\d+)", result.stdout)})
    return pids, result.stdout.strip()


def process_args(pid: int) -> list[str]:
    try:
        raw = (Path("/proc") / str(pid) / "cmdline").read_bytes()
    except OSError:
        return []
    return [
        part.decode("utf-8", errors="replace")
        for part in raw.split(b"\0")
        if part
    ]


def process_service(pid: int) -> str:
    if SERVICE_OVERRIDE:
        return SERVICE_OVERRIDE
    try:
        cgroup = (Path("/proc") / str(pid) / "cgroup").read_text(
            encoding="utf-8", errors="replace"
        )
    except OSError:
        return ""
    match = re.search(r"/system\.slice/([^/\n]+\.service)(?:/|$)", cgroup)
    return match.group(1) if match else ""


def python_source_from_args(pid: int, args: list[str]) -> Path | None:
    if SERVER_OVERRIDE:
        return Path(SERVER_OVERRIDE).resolve()
    try:
        cwd = (Path("/proc") / str(pid) / "cwd").resolve()
    except OSError:
        cwd = Path("/")
    for arg in args[1:]:
        if not arg.endswith(".py"):
            continue
        candidate = Path(arg)
        if not candidate.is_absolute():
            candidate = cwd / candidate
        try:
            return candidate.resolve()
        except OSError:
            return candidate
    return None


def discover_live_backend() -> tuple[Path, str, int, str]:
    pids, listener = port_listener_pids(BACKEND_PORT)
    if not pids:
        raise RuntimeError(
            f"端口 {BACKEND_PORT} 没有可识别的监听进程；ss={listener or '<empty>'}"
        )

    found: dict[tuple[Path, str], list[int]] = {}
    diagnostics: list[str] = []
    for pid in pids:
        args = process_args(pid)
        service = process_service(pid)
        source = python_source_from_args(pid, args)
        diagnostics.append(
            f"pid={pid} service={service or '<unknown>'} "
            f"source={source or '<unknown>'} cmd={shlex.join(args) if args else '<unknown>'}"
        )
        if source and source.is_file() and service and service_exists(service):
            found.setdefault((source, service), []).append(pid)

    if len(found) != 1:
        raise RuntimeError(
            f"无法唯一识别端口 {BACKEND_PORT} 背后的 FastMCP 源码与 systemd 服务；"
            + " | ".join(diagnostics)
            + "。安装尚未修改任何文件。"
        )

    (source, service), matched_pids = next(iter(found.items()))
    source_text = source.read_text(encoding="utf-8")
    if "FastMCP" not in source_text:
        raise RuntimeError(
            f"识别到 {source}，但源码中没有 FastMCP；安装尚未修改任何文件。"
        )
    return source, service, matched_pids[0], listener


def find_mcp_instance(source: str) -> str:
    match = re.search(
        r"(?m)^\s*([A-Za-z_]\w*)(?:\s*:\s*[^=\n]+)?\s*=\s*"
        r"(?:fastmcp\.)?FastMCP\s*\(",
        source,
    )
    if match:
        return match.group(1)
    decorator = re.search(r"(?m)^\s*@([A-Za-z_]\w*)\.tool(?:\s*\(|\s*$)", source)
    run = re.search(r"(?m)^.*\b([A-Za-z_]\w*)\.run\s*\(", source)
    inferred = decorator or run
    return inferred.group(1) if inferred else ""


def mount_tools(source: str, instance: str) -> str:
    block = MOUNT_BLOCK.replace("__MCP_INSTANCE__", instance).strip("\n")
    if BEGIN_MARKER in source:
        pattern = re.compile(
            rf"(?ms)^[ \t]*{re.escape(BEGIN_MARKER)}\n.*?"
            rf"^[ \t]*{re.escape(END_MARKER)}[ \t]*\n?"
        )
        updated, count = pattern.subn(block + "\n", source, count=1)
        if count != 1:
            raise RuntimeError("旧自动唤醒挂载区块无法安全替换")
        return updated
    guard = re.search(r"(?m)^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", source)
    if guard:
        index = guard.start()
    else:
        runs = list(re.finditer(rf"(?m)^.*\b{re.escape(instance)}\.run\s*\(", source))
        index = runs[-1].start() if runs else len(source)
    prefix = source[:index].rstrip("\n")
    suffix = source[index:].lstrip("\n")
    return prefix + "\n\n" + block + "\n\n" + suffix


def download_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "CodeAndPurrs installer"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"无法下载 {url}：{exc}") from exc


def ensure_internal_key() -> str:
    if not APP_ENV.is_file():
        raise RuntimeError(f"找不到 CodeAndPurrs 环境文件：{APP_ENV}")
    source = APP_ENV.read_text(encoding="utf-8")
    match = re.search(r"(?m)^AUTOWAKE_MCP_INTERNAL_KEY=(.*)$", source)
    current = match.group(1).strip().strip("'\"") if match else ""
    if current:
        return current
    key = secrets.token_urlsafe(48)
    line = f"AUTOWAKE_MCP_INTERNAL_KEY={key}"
    if match:
        source = source[: match.start()] + line + source[match.end() :]
    else:
        source = source.rstrip("\n") + "\n" + line + "\n"
    mode = APP_ENV.stat().st_mode
    atomic_write(APP_ENV, source, mode)
    return key


def internal_status(key: str) -> dict[str, object]:
    request = urllib.request.Request(
        "http://127.0.0.1:8787/api/autowake/mcp/status",
        headers={"X-Autowake-MCP-Key": key},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"CodeAndPurrs 自动唤醒内部接口不可用：{exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("CodeAndPurrs 自动唤醒内部接口返回了非对象数据")
    return payload


def restart_pm2() -> None:
    restarted = command(["pm2", "restart", PM2_PROCESS, "--update-env"])
    if restarted.returncode != 0:
        raise RuntimeError(f"CodeAndPurrs 重启失败：{restarted.stderr.strip()}")
    time.sleep(2)


def restart_backend(service: str) -> None:
    restarted = command(["systemctl", "restart", service])
    if restarted.returncode != 0:
        raise RuntimeError(f"无法重启 {service}：{restarted.stderr.strip()}")
    time.sleep(3)
    active = command(["systemctl", "is-active", service])
    if active.stdout.strip() != "active":
        logs = command(["journalctl", "-u", service, "-n", "40", "--no-pager"])
        raise RuntimeError(
            f"{service} 重启失败：{logs.stdout.strip() or restarted.stderr.strip()}"
        )
    pids, listener = port_listener_pids(BACKEND_PORT)
    if not pids:
        logs = command(["journalctl", "-u", service, "-n", "40", "--no-pager"])
        raise RuntimeError(
            f"{service} 已启动，但端口 {BACKEND_PORT} 没有监听："
            f"{listener or logs.stdout.strip()}"
        )


def snapshot(path: Path, backup_dir: Path) -> tuple[Path, Path, bool]:
    destination = backup_dir / path.as_posix().lstrip("/")
    existed = path.exists()
    if existed:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    return path, destination, existed


def restore(snapshots: list[tuple[Path, Path, bool]], service: str) -> None:
    for original, saved, existed in reversed(snapshots):
        try:
            if existed and saved.exists():
                original.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, original)
            elif not existed:
                original.unlink(missing_ok=True)
        except OSError as exc:
            print(f"回滚警告：无法恢复 {original}：{exc}", file=sys.stderr)
    command(["pm2", "restart", PM2_PROCESS, "--update-env"])
    if service:
        command(["systemctl", "restart", service])


def main() -> int:
    if os.geteuid() != 0:
        print("请用 root 运行此安装器。", file=sys.stderr)
        return 1
    required = [
        APP_DIR / "server" / "autowake.mjs",
        APP_DIR / "server" / "proxy.mjs",
        APP_ENV,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        print("线上 CodeAndPurrs 缺少自动唤醒后端：" + "、".join(missing), file=sys.stderr)
        return 1

    service = ""
    snapshots: list[tuple[Path, Path, bool]] = []
    try:
        backend_source, service, pid, _listener = discover_live_backend()
        print(
            f"[0/5] 已识别真实 MCP：端口={BACKEND_PORT} pid={pid} "
            f"service={service} source={backend_source}"
        )

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup_dir = BACKUP_ROOT / f"codeandpurrs-before-autowake-mcp-{timestamp}"
        backup_dir.mkdir(parents=True, exist_ok=False)
        snapshots = [
            snapshot(backend_source, backup_dir),
            snapshot(APP_ENV, backup_dir),
            snapshot(TOOL_SERVER, backup_dir),
        ]
        print(f"[1/5] 已备份到 {backup_dir}")

        tool_source = download_text(TOOL_SOURCE)
        required_tools = {
            "get_autowake_status",
            "set_codeandpurrs_autowake",
            "send_codeandpurrs_wake_now",
            "list_autowake_deliveries",
            "look_at_recent_screen",
        }
        missing_tools = sorted(
            name for name in required_tools if f"def {name}(" not in tool_source
        )
        if missing_tools:
            raise RuntimeError("下载的工具模块不完整：" + "、".join(missing_tools))
        atomic_write(TOOL_SERVER, tool_source, 0o600)
        print("[2/5] 已同步五个自动唤醒工具")

        source = backend_source.read_text(encoding="utf-8")
        instance = find_mcp_instance(source)
        if not instance:
            raise RuntimeError(f"无法在 {backend_source} 中识别 FastMCP 实例")
        updated = mount_tools(source, instance)
        mode = backend_source.stat().st_mode
        atomic_write(backend_source, updated, mode)
        compiled = command(
            [sys.executable, "-m", "py_compile", str(backend_source), str(TOOL_SERVER)]
        )
        if compiled.returncode != 0:
            raise RuntimeError(f"Python 语法检查失败：{compiled.stderr.strip()}")
        print(f"[3/5] 已挂载到 {instance}，没有新增或迁移端口")

        key = ensure_internal_key()
        restart_pm2()
        status = internal_status(key)
        print(
            "[4/5] CodeAndPurrs 内部接口正常："
            f"enabled={status.get('enabled')} unread={status.get('unreadCount')}"
        )

        restart_backend(service)
        print(f"[5/5] {service}: active；端口 {BACKEND_PORT}: listening")
        print("完成：https://mcp.nekopurrs.uk/mcp 公网地址、Nginx 与 OAuth 均未改动。")
        return 0
    except Exception as exc:
        if snapshots:
            restore(snapshots, service)
            print("安装失败，已恢复本轮修改。", file=sys.stderr)
        print(f"失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
