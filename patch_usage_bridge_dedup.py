#!/usr/bin/env python3
"""
neko-usage-bridge -> dream_events.db 去重
只做:
  syncAppUsageToDreamEvents 里,写入每个 App 之前先按
  (type='app_usage_snapshot', source='Neko Usage Bridge', package, 当天日期)
  删除旧行,再插入新行 —— 同一批数据重复上传时是覆盖更新,不是追加。
不改其他逻辑,不碰 mcp.service。
"""
import shutil
import subprocess
import sys
import time

SERVER_PATH = "/opt/codeandpurrs/server/usageBridgeServer.mjs"
SERVICE_NAME = "codeandpurrs-usage-bridge.service"

OLD = '''    const meta = JSON.stringify({ ...app, minutes, duration, usage_bridge_writer: true });

    statements.push(
      `INSERT INTO dream_events (device_id, type, package, label, value, source, meta, created_at) VALUES ('', 'app_usage_snapshot', ${sqlEscape(pkg)}, ${sqlEscape(label)}, ${sqlEscape(value)}, 'Neko Usage Bridge', ${sqlEscape(meta)}, ${sqlEscape(createdAt)});`
    );
  }'''

NEW = '''    const meta = JSON.stringify({ ...app, minutes, duration, usage_bridge_writer: true });
    const day = createdAt.slice(0, 10);

    statements.push(
      `DELETE FROM dream_events WHERE type='app_usage_snapshot' AND source='Neko Usage Bridge' AND package=${sqlEscape(pkg)} AND substr(created_at,1,10)=${sqlEscape(day)};`
    );
    statements.push(
      `INSERT INTO dream_events (device_id, type, package, label, value, source, meta, created_at) VALUES ('', 'app_usage_snapshot', ${sqlEscape(pkg)}, ${sqlEscape(label)}, ${sqlEscape(value)}, 'Neko Usage Bridge', ${sqlEscape(meta)}, ${sqlEscape(createdAt)});`
    );
  }'''


def patch():
    with open(SERVER_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    if OLD not in src:
        if NEW in src:
            print("✅ 已经打过这个补丁了,跳过。")
            return False
        print("❌ 旧版文本没匹配到,结构跟预期不一样,中止,不动文件。")
        sys.exit(1)

    count = src.count(OLD)
    if count != 1:
        print(f"❌ 匹配到 {count} 处(预期1处),中止,不动文件。")
        sys.exit(1)

    backup = f"{SERVER_PATH}.bak.{int(time.time())}"
    shutil.copy(SERVER_PATH, backup)
    print(f"== 已备份 -> {backup} ==")

    src = src.replace(OLD, NEW)
    with open(SERVER_PATH, "w", encoding="utf-8") as f:
        f.write(src)
    print("✅ 已插入 DELETE-then-INSERT 去重逻辑")

    print("== 语法检查(node --check) ==")
    r = subprocess.run(["node", "--check", SERVER_PATH], capture_output=True, text=True)
    if r.returncode != 0:
        print("❌ 语法检查失败,回滚:")
        print(r.stderr)
        shutil.copy(backup, SERVER_PATH)
        sys.exit(1)
    print("✅ 语法检查通过")

    return True


def restart_and_show():
    print(f"== 重启 {SERVICE_NAME}(不碰 mcp.service)==")
    r = subprocess.run(["systemctl", "restart", SERVICE_NAME], capture_output=True, text=True)
    if r.returncode != 0:
        print("❌ 重启失败:", r.stderr)
        sys.exit(1)

    time.sleep(2)
    status = subprocess.run(["systemctl", "is-active", SERVICE_NAME], capture_output=True, text=True)
    print("服务状态:", status.stdout.strip())

    print("\n== 最近日志 ==")
    logs = subprocess.run(
        ["journalctl", "-u", SERVICE_NAME, "-n", "15", "--no-pager"],
        capture_output=True, text=True,
    )
    print(logs.stdout)


if __name__ == "__main__":
    changed = patch()
    if changed:
        restart_and_show()
