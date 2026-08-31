#!/usr/bin/env bash
set -u

readonly BASE="/root/codeandpurrs-mcp"
readonly AUTONOMY="${BASE}/neko_autonomy.py"
readonly PROMPT="${BASE}/prompts/ashen-rowe-autonomy-prompt.md"
readonly AUTO_DB="${BASE}/data/neko_autonomy.db"
readonly DREAM_DB="/root/data/dream_events.db"

redact() {
  sed -E \
    -e 's/(sk-ant-[A-Za-z0-9_-]+)/[REDACTED_TOKEN]/g' \
    -e 's/((TOKEN|SECRET|PASSWORD|API_KEY)[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's#(https://)[^/@[:space:]]+@#\1[REDACTED]@#g'
}

section() { printf '\n=== %s ===\n' "$1"; }

section "CLOCK"
date --iso-8601=seconds

section "UNITS"
for unit in codeandpurrs-autonomy.timer codeandpurrs-autonomy.service neko-autonomy.timer neko-autonomy.service; do
  printf '%-36s active=%-12s enabled=%s\n' \
    "${unit}" \
    "$(systemctl is-active "${unit}" 2>/dev/null || true)" \
    "$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
done
systemctl show codeandpurrs-autonomy.timer \
  -p ActiveState -p UnitFileState -p LastTriggerUSec -p NextElapseUSecRealtime 2>/dev/null | redact
systemctl show codeandpurrs-autonomy.service \
  -p ActiveState -p Result -p ExecMainStatus -p FragmentPath 2>/dev/null | redact

section "TIMER LIST"
systemctl list-timers --all --no-pager 2>/dev/null | grep -E 'codeandpurrs-autonomy|neko-autonomy|NEXT|^$' || true

section "UNIT FILES"
systemctl cat codeandpurrs-autonomy.timer codeandpurrs-autonomy.service 2>/dev/null | redact || true

section "RECENT LOG"
journalctl -u codeandpurrs-autonomy.service -n 60 --no-pager -o short-iso 2>/dev/null | redact || true

section "FILES"
for path in "${AUTONOMY}" "${PROMPT}" "${AUTO_DB}" "${DREAM_DB}"; do
  if [[ -e "${path}" ]]; then
    stat -c '%n | bytes=%s | modified=%y' "${path}"
  else
    echo "MISSING ${path}"
  fi
done

section "AUTONOMY SOURCE SHAPE"
python3 - "${AUTONOMY}" <<'PY'
import ast
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
if not path.is_file():
    print("missing autonomy source")
    raise SystemExit(0)

source = path.read_text(encoding="utf-8")
try:
    tree = ast.parse(source)
except SyntaxError as exc:
    print(f"SYNTAX_ERROR line={exc.lineno}: {exc.msg}")
    raise SystemExit(0)

print("syntax=ok")
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        print(f"{node.__class__.__name__} line={node.lineno} name={node.name}")
    elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        name = node.targets[0].id
        if re.search(r"TOKEN|SECRET|PASSWORD|KEY|AUTH", name, re.I):
            continue
        if re.search(r"QUIET|COOLDOWN|INTERVAL|LIMIT|THRESHOLD|DB|PROMPT|TOPIC|HOUR|MINUTE", name, re.I):
            try:
                value = ast.literal_eval(node.value)
            except Exception:
                value = "<dynamic>"
            print(f"config line={node.lineno} {name}={value!r}")
PY

section "DATABASE FRESHNESS"
python3 - "${AUTO_DB}" "${DREAM_DB}" <<'PY'
from pathlib import Path
import json
import sqlite3
import sys

for raw in sys.argv[1:]:
    path = Path(raw)
    print(f"DB {path}")
    if not path.is_file():
        print("  missing")
        continue
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        tables = [r[0] for r in db.execute("select name from sqlite_master where type='table' order by name")]
        for table in tables:
            if table.startswith("sqlite_"):
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            count = db.execute(f"select count(*) from {quoted}").fetchone()[0]
            print(f"  table={table} rows={count}")
            rows = db.execute(f"select * from {quoted} order by rowid desc limit 3").fetchall()
            for row in rows:
                safe = {}
                for key in row.keys():
                    if any(word in key.lower() for word in ("token", "secret", "password", "key", "auth")):
                        continue
                    value = row[key]
                    if isinstance(value, str) and len(value) > 180:
                        value = value[:177] + "..."
                    safe[key] = value
                print("   ", json.dumps(safe, ensure_ascii=False, default=str))
        db.close()
    except Exception as exc:
        print(f"  ERROR {type(exc).__name__}: {exc}")
PY

section "GIT"
if git -C "${BASE}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "${BASE}" status --short
  git -C "${BASE}" log -5 --oneline --decorate
  git -C "${BASE}" remote -v | redact
else
  echo "${BASE} is not a git worktree"
fi

section "END"
echo "只读诊断完成；没有修改或重启任何服务。"
