#!/usr/bin/env python3
"""
让 usageBridgeServer.mjs 把 payload.notifications 落库。

跟 patch-usage-bridge-events.py 同一套路：改同目录那个 .mjs，用系统自带
sqlite3 CLI，不新增任何 npm 依赖，每一步单独判断是否已生效，可重复运行。

【不新造第二条写库的路】——直接扩已有的 syncUsageEventsToDb。那是现在
唯一往 dream_events.db 写东西的地方，多开一条迟早两边不一致。

通知只有三个字段：包名、app 名、时间。App 那边压根不采集标题和正文
（见 NotificationLogger.kt），所以这里也没有内容可存。

    python3 patch-usage-notifications.py --dry-run
    python3 patch-usage-notifications.py --apply
"""

import argparse
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime

DEFAULT_SERVER = "/opt/codeandpurrs/server/usageBridgeServer.mjs"

# 每一步：(名字, 找什么, 换成什么, 已装的判断串)
STEPS = [
    (
        "1/4 空判断带上 notifications",
        "  if (!sessions.length && !screen.length) return { sessions: 0, screenEvents: 0 };",
        """  const notifs = Array.isArray(payload.notifications) ? payload.notifications : [];
  if (!sessions.length && !screen.length && !notifs.length) {
    return { sessions: 0, screenEvents: 0, notifications: 0 };
  }""",
        "const notifs = Array.isArray(payload.notifications)",
    ),
    (
        "2/4 建 notifications 表",
        """    `CREATE TABLE IF NOT EXISTS screen_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
       ts TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (event_type, ts));`,""",
        """    `CREATE TABLE IF NOT EXISTS screen_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
       ts TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (event_type, ts));`,
    // 只有「哪个 app、什么时候」。标题和正文 App 那边就没采集，这里无内容可存。
    // UNIQUE(package, ts)：重复上报直接忽略，同一秒同一个 app 的两条也当一条——
    // 那本来就分不出是两件事还是同一件事重发。
    `CREATE TABLE IF NOT EXISTS notifications (
       id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, label TEXT,
       ts TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (package, ts));`,""",
        "CREATE TABLE IF NOT EXISTS notifications",
    ),
    (
        "3/4 插入通知",
        """  stmts.push('COMMIT;');
  evRunSql('.timeout 5000\\n' + stmts.join('\\n'));
  return { sessions: nSessions, screenEvents: nScreen };""",
        """  let nNotif = 0;
  for (const n of notifs) {
    if (!n || typeof n.package !== 'string') continue;
    const ts = evNormTs(n.at);
    if (!ts) continue;
    stmts.push(
      `INSERT INTO notifications (package,label,ts,created_at) VALUES (` +
      `${evSqlEscape(n.package)},${evSqlEscape(n.label ?? null)},` +
      `${evSqlEscape(ts)},${evSqlEscape(now)}) ` +
      `ON CONFLICT(package,ts) DO NOTHING;`
    );
    nNotif += 1;
  }

  stmts.push('COMMIT;');
  evRunSql('.timeout 5000\\n' + stmts.join('\\n'));
  return { sessions: nSessions, screenEvents: nScreen, notifications: nNotif };""",
        "INSERT INTO notifications (package,label,ts,created_at)",
    ),
    (
        "4/4 schemaVersion 放行 3",
        "payload.schemaVersion !== 1 && payload.schemaVersion !== 2",
        "payload.schemaVersion !== 1 && payload.schemaVersion !== 2 && payload.schemaVersion !== 3",
        "payload.schemaVersion !== 3",
    ),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    p = pathlib.Path(a.server)
    if not p.is_file():
        print(f"× 找不到 {p}", file=sys.stderr)
        return 1
    text = p.read_text()

    if "function syncUsageEventsToDb" not in text:
        print("× 这个文件还没装事件落库补丁（找不到 syncUsageEventsToDb）。", file=sys.stderr)
        print("  先跑 patch-usage-bridge-events.py，通知是长在它上面的。", file=sys.stderr)
        return 1

    todo, out = [], text
    for name, old, new, marker in STEPS:
        if marker in out:
            print(f"  · {name}：已生效，跳过")
            continue
        n = out.count(old)
        if n != 1:
            print(f"× {name}：锚点匹配到 {n} 处（要正好 1 处），已中止，文件未改动",
                  file=sys.stderr)
            return 1
        out = out.replace(old, new, 1)
        todo.append(name)
        print(f"  ✓ {name}")

    if not todo:
        print("\n都装好了，没什么要改的。")
        return 0
    if not a.apply:
        print(f"\n（没落盘）会改 {len(todo)} 处。确认就加 --apply。")
        return 0

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = p.with_suffix(f".mjs.bak-{stamp}")
    shutil.copy2(p, bak)
    p.write_text(out)

    # 后缀必须留 .mjs，node --check 认扩展名
    check = p.with_name(f".patchcheck-{stamp}.mjs")
    check.write_text(out)
    r = subprocess.run(["node", "--check", str(check)], capture_output=True, text=True)
    check.unlink(missing_ok=True)
    if r.returncode != 0:
        shutil.copy2(bak, p)
        print("× node --check 没过，已还原，文件跟动手前一样。", file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        return 1

    print(f"\n  ✓ 改好了，node --check 过。备份：{bak}")
    print("\n要重启才生效：")
    print("  systemctl restart codeandpurrs-usage-bridge.service")
    print("  journalctl -u codeandpurrs-usage-bridge.service -n 20 --no-pager")
    return 0


if __name__ == "__main__":
    sys.exit(main())
