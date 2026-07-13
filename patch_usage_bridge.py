#!/usr/bin/env python3
"""
neko-usage-bridge 接收服务落库打通棠予酿
只做:
  收到 /api/usage/ingest 的 app_usage 数据后,额外同步写入
  /root/data/dream_events.db 的 dream_events 表(type='app_usage_snapshot',
  每个 App 一条,label/meta/source 跟 /root/server.py 的 phone-sync 落库逻辑一致)。
  apps 为空时只 console.log 一行,不写库。
用系统自带 sqlite3 CLI(child_process),不新增任何 npm 依赖。
不改 /root/data/dream_events.db 本身,只是多一个写入入口。
每一步都单独判断是否已生效,可以安全重复运行。
"""
import shutil
import subprocess
import sys
import time

SERVER_PATH = "/opt/codeandpurrs/server/usageBridgeServer.mjs"
SERVICE_NAME = "codeandpurrs-usage-bridge.service"

STRING_PATCHES = [
    (
        "import spawnSync",
        "import { join } from 'node:path';",
        "import { join } from 'node:path';\nimport { spawnSync } from 'node:child_process';",
    ),
    (
        "helper 函数(sqlEscape/runSqlite/syncAppUsageToDreamEvents)",
        "export function createUsageBridgeServer({",
        '''const DREAM_EVENTS_DB_PATH = process.env.DREAM_EVENTS_DB_PATH ?? '/root/data/dream_events.db';

function sqlEscape(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSqlite(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr}`);
  }

  return result.stdout;
}

async function syncAppUsageToDreamEvents(payload) {
  const apps = Array.isArray(payload.apps) ? payload.apps : [];

  if (apps.length === 0) {
    console.log('neko-usage-bridge: apps is empty, skip dream_events sync');
    return;
  }

  const createdAt = typeof payload.generatedAt === 'string' ? payload.generatedAt : new Date().toISOString();
  const statements = [
    `CREATE TABLE IF NOT EXISTS dream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      type TEXT,
      package TEXT,
      label TEXT,
      value TEXT,
      source TEXT,
      meta TEXT,
      created_at TEXT
    );`,
  ];

  for (const app of apps) {
    const pkg = String(app.package ?? '');
    const label = String(app.label ?? app.name ?? app.package ?? 'unknown');
    const minutes = isNonNegativeNumber(app.foregroundMs) ? Math.round(app.foregroundMs / 60000) : null;
    const duration = minutes !== null ? `${minutes}分钟` : '';
    const value = `今日常用平台快照：${label}`;
    const meta = JSON.stringify({ ...app, minutes, duration, usage_bridge_writer: true });

    statements.push(
      `INSERT INTO dream_events (device_id, type, package, label, value, source, meta, created_at) VALUES ('', 'app_usage_snapshot', ${sqlEscape(pkg)}, ${sqlEscape(label)}, ${sqlEscape(value)}, 'Neko Usage Bridge', ${sqlEscape(meta)}, ${sqlEscape(createdAt)});`
    );
  }

  try {
    runSqlite(DREAM_EVENTS_DB_PATH, statements.join('\\n'));
    console.log(`neko-usage-bridge: wrote ${apps.length} app_usage_snapshot rows to dream_events.db`);
  } catch (error) {
    console.error('neko-usage-bridge: failed to sync dream_events.db:', error);
  }
}

export function createUsageBridgeServer({''',
    ),
    (
        "ingest handler 里调用同步函数",
        "const { owner, storedPayload } = await writeUsagePayload(dataDir, payload);",
        "const { owner, storedPayload } = await writeUsagePayload(dataDir, payload);\n      await syncAppUsageToDreamEvents(payload);",
    ),
]


def apply_string_patch(src, label, old, new):
    if old not in src:
        if new in src:
            print(f"✅ [{label}] 已经是新版,跳过")
            return src, False
        print(f"❌ [{label}] 旧版和新版都没匹配到,结构跟预期不一样,中止,不动文件。")
        sys.exit(1)
    count = src.count(old)
    if count != 1:
        print(f"❌ [{label}] 旧版匹配到 {count} 处(预期1处),中止,不动文件。")
        sys.exit(1)
    src = src.replace(old, new)
    print(f"✅ [{label}] 匹配成功并替换")
    return src, True


def patch():
    with open(SERVER_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    any_changed = False
    for label, old, new in STRING_PATCHES:
        src, changed = apply_string_patch(src, label, old, new)
        any_changed = any_changed or changed

    if not any_changed:
        print("== 所有步骤都已经生效,本次无需改动、无需重启 ==")
        return False

    backup = f"{SERVER_PATH}.bak.{int(time.time())}"
    shutil.copy(SERVER_PATH, backup)
    print(f"== 已备份原文件 -> {backup} ==")

    with open(SERVER_PATH, "w", encoding="utf-8") as f:
        f.write(src)

    print("== 语法检查(node --check) ==")
    r = subprocess.run(["node", "--check", SERVER_PATH], capture_output=True, text=True)
    if r.returncode != 0:
        print("❌ 语法检查失败,回滚:")
        print(r.stderr)
        shutil.copy(backup, SERVER_PATH)
        sys.exit(1)
    print("✅ 语法检查通过")

    return True


def restart_and_show_logs():
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
        ["journalctl", "-u", SERVICE_NAME, "-n", "20", "--no-pager"],
        capture_output=True, text=True,
    )
    print(logs.stdout)

    print("== 现在请在手机上点一次「立即上传」,然后跑下面这条确认落库 ==")
    print("sqlite3 /root/data/dream_events.db "
          "\"SELECT id, type, package, label, source, created_at FROM dream_events "
          "WHERE type='app_usage_snapshot' ORDER BY id DESC LIMIT 10;\"")


if __name__ == "__main__":
    changed = patch()
    if changed:
        restart_and_show_logs()
