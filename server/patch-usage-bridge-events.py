#!/usr/bin/env python3
"""
neko-usage-bridge 事件式会话落库（usage_sessions / screen_events）

跟 /root/patch_usage_bridge.py 同一个套路：改 /opt/codeandpurrs/server/
usageBridgeServer.mjs，用系统自带 sqlite3 CLI（child_process），不新增
任何 npm 依赖。每一步单独判断是否已生效，可以安全重复运行。

改四处，各修各的毛病：

  1. schemaVersion 放宽成认 1 和 2
     现在是 `!== 1` 就 400。红米那只新 app 发的是 2，不改的话装上去
     【所有】上报被拒——连现在每两小时正常写进去的统计一起断。

  2. 事件落库，独立于 app_usage 那条链路
     现有的 dream_events 同步里有一句「apps is empty, skip」，日志里
     8/23 00:33 和 02:34 各命中一次。夜里没开 app 很正常，但那正是
     睡眠数据唯一有价值的时段。会话和亮屏事件不能跟着那条早退一起没。

  3. 日文件按会话合并，不整份覆盖
     writeUsagePayload 是 writeFile(`${date}.json`) 整份盖掉。以前
     快照式每次都是当天全量，盖掉没事；现在采集带了增量游标，每次只
     发最近一段——盖一次，星河沙滩时间线当天就只剩最后两小时。

  4. 补 spawnSync 的 import（老版本没有就加上）

跑法：
    python3 patch-usage-bridge-events.py --dry-run
    python3 patch-usage-bridge-events.py --apply
    python3 patch-usage-bridge-events.py --apply --server /path/to.mjs
"""

import argparse
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime

SERVER_PATH = "/opt/codeandpurrs/server/usageBridgeServer.mjs"
SERVICE_NAME = "codeandpurrs-usage-bridge.service"

# ── 第 0 处：请求体上限 ─────────────────────────────────────────────────
# 512KB 是按旧的快照格式定的（旧日文件才 39-70KB）。v2 首次上传要回溯 3 天、
# 会话下限又从 30s 降到 1s，实测一次 3339 段会话 ≈ 610KB，直接被挡。
# 注意 nginx 那层还有一个 client_max_body_size，两个都得放宽，见 README。
OLD_BODY_LIMIT = "const MAX_BODY_BYTES = 512 * 1024;"
NEW_BODY_LIMIT = "const MAX_BODY_BYTES = 8 * 1024 * 1024;"


# ── 第 1 处：schemaVersion ──────────────────────────────────────────────
OLD_SCHEMA = """  if (payload.schemaVersion !== 1) {
    return 'schemaVersion must be 1';
  }"""

NEW_SCHEMA = """  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    return 'schemaVersion must be 1 or 2';
  }"""

# ── 第 2 处：事件落库的那一坨 ───────────────────────────────────────────
EVENTS_JS = r"""
// ── 事件式会话落库 ───────────────────────────────────────────────────────
// 写 usage_sessions / screen_events 两张表（migrations/002 建的）。
// 刻意【不】走上面 dream_events 那条同步：那边 apps 为空就整段 skip，
// 而夜里没开 app 恰恰是常态，睡眠数据全在那时候。

const EV_DB_PATH = process.env.DREAM_EVENTS_DB_PATH ?? '/root/data/dream_events.db';

const EV_SCREEN_TYPES = new Set([
  'interactive', 'non_interactive', 'keyguard_shown', 'keyguard_hidden',
]);

function evSqlEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 砍掉小数秒，保留原始 +08:00 写法。
// UNIQUE(package, start_ts) 是文本比较：同一条会话第一次上报带毫秒、
// 第二次不带，字符串一差 UPSERT 就认不出是同一行，会插成两条。
// 用字符串手术而不是 new Date()，因为后者会把时区偏移弄丢。
function evNormTs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) return null;
  return trimmed.replace(/\.\d+(?=(Z|[+-]\d{2}:?\d{2})?$)/, '');
}

function evRunSql(sql) {
  const result = spawnSync('sqlite3', [EV_DB_PATH], { input: sql, encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${result.stderr}`);
  }
}

function syncUsageEventsToDb(payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const screen = Array.isArray(payload.screenEvents) ? payload.screenEvents : [];
  if (!sessions.length && !screen.length) return { sessions: 0, screenEvents: 0 };

  const now = new Date().toISOString();
  const stmts = [
    `CREATE TABLE IF NOT EXISTS usage_sessions (
       id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, label TEXT,
       start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, duration_ms INTEGER NOT NULL,
       open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0,1)), created_at TEXT NOT NULL,
       UNIQUE (package, start_ts));`,
    `CREATE TABLE IF NOT EXISTS screen_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
       ts TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (event_type, ts));`,
    'BEGIN;',
  ];

  let nSessions = 0;
  for (const s of sessions) {
    if (!s || typeof s.package !== 'string') continue;
    const start = evNormTs(s.startAt);
    const end = evNormTs(s.endAt);
    if (!start || !end) continue;
    const duration = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(duration) || duration < 0) continue;
    // open=1 的会话下次会带真实 end_ts 回来覆盖同一行；
    // 已经封口的（库里 open=0）不许再改——迟到的重复上报不该把一条
    // 正确的记录改坏。
    stmts.push(
      `INSERT INTO usage_sessions (package,label,start_ts,end_ts,duration_ms,open,created_at) ` +
      `VALUES (${evSqlEscape(s.package)},${evSqlEscape(s.label ?? null)},` +
      `${evSqlEscape(start)},${evSqlEscape(end)},${duration},${s.open ? 1 : 0},` +
      `${evSqlEscape(now)}) ` +
      `ON CONFLICT(package,start_ts) DO UPDATE SET end_ts=excluded.end_ts,` +
      `duration_ms=excluded.duration_ms,open=excluded.open,` +
      `label=COALESCE(excluded.label,usage_sessions.label) ` +
      `WHERE usage_sessions.open=1;`
    );
    nSessions += 1;
  }

  let nScreen = 0;
  for (const e of screen) {
    if (!e || !EV_SCREEN_TYPES.has(e.eventType)) continue;   // CHECK 约束外的先滤掉
    const ts = evNormTs(e.at);
    if (!ts) continue;
    stmts.push(
      `INSERT INTO screen_events (event_type,ts,created_at) VALUES (` +
      `${evSqlEscape(e.eventType)},${evSqlEscape(ts)},${evSqlEscape(now)}) ` +
      `ON CONFLICT(event_type,ts) DO NOTHING;`
    );
    nScreen += 1;
  }

  stmts.push('COMMIT;');
  evRunSql('.timeout 5000\n' + stmts.join('\n'));
  return { sessions: nSessions, screenEvents: nScreen };
}

// 日文件是整份覆盖写的，而采集现在带增量游标——每次只发最近一段。
// 直接覆盖的话，星河沙滩时间线读到的 sessions[] 当天只剩最后一次同步
// 那一小段。所以按 key 合并已有的和新来的。
function evMergeDayLists(previous, incoming, keyOf) {
  const merged = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    const key = keyOf(item);
    if (key) merged.set(key, item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = keyOf(item);
    if (!key) continue;
    const old = merged.get(key);
    // 已经封口的不让 open=true 的迟到上报盖回去（跟库里同一条规矩）
    if (old && old.open === false && item.open === true) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}
// ─────────────────────────────────────────────────────────────────────────
"""

# ── 第 3 处：日文件合并 ─────────────────────────────────────────────────
OLD_WRITE = """  const storedPayload = {
    ...payload,
    ingestedAt: new Date().toISOString(),
  };"""

NEW_WRITE = """  let previousDay = null;
  try {
    previousDay = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('neko-usage-bridge: 读旧日文件失败，按新建处理:', error);
    }
  }

  // 只保留 startAt 落在这一天的会话。增量窗口首次运行会回溯 3 天，
  // 不滤的话前几天的会话会全挤进今天的文件里；库里那份是全的。
  const dayOf = (value) => (typeof value === 'string' ? value.slice(0, 10) : '');
  const storedPayload = {
    ...payload,
    sessions: evMergeDayLists(
      previousDay?.sessions,
      (Array.isArray(payload.sessions) ? payload.sessions : [])
        .filter((s) => dayOf(s?.startAt) === payload.date),
      (s) => (s && s.package && s.startAt ? `${s.package}|${evNormTs(s.startAt)}` : ''),
    ).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt))),
    screenEvents: evMergeDayLists(
      previousDay?.screenEvents,
      (Array.isArray(payload.screenEvents) ? payload.screenEvents : [])
        .filter((e) => dayOf(e?.at) === payload.date),
      (e) => (e && e.eventType && e.at ? `${e.eventType}|${evNormTs(e.at)}` : ''),
    ).sort((a, b) => String(a.at).localeCompare(String(b.at))),
    ingestedAt: new Date().toISOString(),
  };"""

# ── 第 4 处：handler 里调用 ─────────────────────────────────────────────
OLD_CALL = "        const { owner, storedPayload } = await writeUsagePayload(dataDir, payload);"

NEW_CALL = """        // 独立于下面 dream_events 那条同步：那边 apps 为空就整段 skip，
        // 而夜里没开 app 是常态，睡眠数据全在那时候。
        try {
          const evResult = syncUsageEventsToDb(payload);
          if (evResult.sessions || evResult.screenEvents) {
            console.log(
              `neko-usage-bridge: wrote ${evResult.sessions} sessions, ` +
              `${evResult.screenEvents} screen_events to dream_events.db`,
            );
          }
        } catch (error) {
          // 事件落库失败不连累旧的快照上报
          console.error('neko-usage-bridge: failed to sync usage events:', error);
        }

""" + OLD_CALL

IMPORT_LINE = "import { spawnSync } from 'node:child_process';"


ANCHOR_HELPERS = "async function writeUsagePayload(dataDir, payload) {"


def apply_steps(text: str) -> tuple[str, list[str]]:
    """
    返回 (改完的文本, 每一步做了什么)。
    任何一步锚点数量不对就抛 SystemExit —— 整体中止，一个字不落盘。
    """
    log = []

    def once(t, old, new, name):
        n = t.count(old)
        if n != 1:
            raise SystemExit(f"× [{name}] 锚点匹配到 {n} 处（需要正好 1 处），已中止，文件未改动")
        log.append(name)
        return t.replace(old, new, 1)

    # 1. import
    if IMPORT_LINE in text:
        log.append("import 已在，跳过")
    else:
        lines = text.splitlines(keepends=True)
        last = 0
        for i, line in enumerate(lines):
            if line.startswith("import "):
                last = i + 1
        if last == 0:
            raise SystemExit("× 文件里一条 import 都没有，形状不对，已中止")
        lines.insert(last, IMPORT_LINE + "\n")
        text = "".join(lines)
        log.append("补上 spawnSync 的 import")

    # 2. 请求体上限
    if NEW_BODY_LIMIT in text:
        log.append("请求体上限已放宽，跳过")
    elif OLD_BODY_LIMIT in text:
        text = once(text, OLD_BODY_LIMIT, NEW_BODY_LIMIT, "请求体上限 512KB → 8MB")
    else:
        log.append("请求体上限不是预期的 512KB，没动它（自己确认够不够）")

    # 3. schemaVersion 放宽
    if NEW_SCHEMA in text:
        log.append("schemaVersion 已放宽，跳过")
    else:
        text = once(text, OLD_SCHEMA, NEW_SCHEMA, "schemaVersion 放宽成认 1 和 2")

    # 4. 事件落库那一坨
    if "function syncUsageEventsToDb" in text:
        log.append("事件落库函数已在，跳过")
    else:
        text = once(text, ANCHOR_HELPERS, EVENTS_JS + "\n" + ANCHOR_HELPERS,
                    "插入事件落库 + 日文件合并的辅助函数")

    # 5. 日文件按会话合并
    if "evMergeDayLists(" in text and "previousDay" in text:
        log.append("日文件合并已在，跳过")
    else:
        text = once(text, OLD_WRITE, NEW_WRITE, "日文件改成按会话合并，不再整份覆盖")

    # 6. handler 里调用
    # 不能用 "syncUsageEventsToDb(payload)" 当哨兵——函数定义那行也含这串，
    # 第 3 步插完就会误判成已生效，然后 handler 里其实一直没调。
    if "const evResult = syncUsageEventsToDb(payload)" in text:
        log.append("handler 调用已在，跳过")
    else:
        text = once(text, OLD_CALL, NEW_CALL, "在 ingest handler 里调用（独立于 apps-empty 早退）")

    return text, log


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=SERVER_PATH)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--no-check", action="store_true", help="跳过 node --check")
    args = ap.parse_args()

    target = pathlib.Path(args.server)
    if not target.exists():
        print(f"× 找不到 {target}", file=sys.stderr)
        return 1

    original = target.read_text()
    patched, log = apply_steps(original)

    print(f"目标: {target}")
    for item in log:
        print(f"  · {item}")

    if patched == original:
        print("\n全部已生效，没什么可改的。")
        return 0

    # 语法检查在临时文件上做，别拿生产文件冒险
    if not args.no_check:
        # 扩展名必须还是 .mjs —— node --check 靠它判断是不是 ESM
        tmp = target.with_name(target.name + ".patchcheck.mjs")
        tmp.write_text(patched)
        try:
            result = subprocess.run(["node", "--check", str(tmp)],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                print(f"\n× 改完语法不对，已中止，文件未改动：\n{result.stderr}", file=sys.stderr)
                return 1
            print("  ✓ node --check 通过")
        except FileNotFoundError:
            print("  ! 没找到 node，跳过语法检查")
        finally:
            tmp.unlink(missing_ok=True)

    if not args.apply:
        print(f"\n（--dry-run）会新增 {len(patched.splitlines()) - len(original.splitlines())} 行。"
              "\n确认没问题就加 --apply")
        return 0

    backup = target.with_suffix(".mjs.bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(target, backup)
    target.write_text(patched)
    print(f"\n  ✓ 备份: {backup}")
    print(f"  ✓ 已改: {target}")
    print(f"\n下一步：\n  systemctl restart {SERVICE_NAME}")
    print(f"  journalctl -u {SERVICE_NAME} -n 20 --no-pager")
    return 0


if __name__ == "__main__":
    sys.exit(main())
