#!/usr/bin/env bash
# deploy-export-pod.sh
#
# 上 VPS 把 CodeAndPurrs 切到导出舱分支，装依赖，重启 vite。
# 需要在项目根目录跑（有 package.json 的那层）。
#
# 用法：
#   bash deploy-export-pod.sh                  # 默认 dev 模式，端口 5173
#   MODE=preview bash deploy-export-pod.sh     # 生产构建 + vite preview
#   PORT=8080 bash deploy-export-pod.sh        # 换端口
#   BRANCH=main bash deploy-export-pod.sh      # 换分支（默认导出舱分支）
#   USE_PM2=1 bash deploy-export-pod.sh        # 用 pm2 管进程
#   HARD_RESET=1 bash deploy-export-pod.sh     # 有本地脏改动时强行覆盖
#   SKIP_INSTALL=1 bash deploy-export-pod.sh   # 跳过 npm install

set -euo pipefail

BRANCH="${BRANCH:-claude/export-cabin-feature-qn2ktq}"
MODE="${MODE:-dev}"
PORT="${PORT:-5173}"
USE_PM2="${USE_PM2:-0}"
HARD_RESET="${HARD_RESET:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
PM2_NAME="${PM2_NAME:-codeandpurrs}"

c_log='\033[1;35m'
c_warn='\033[1;33m'
c_err='\033[1;31m'
c_ok='\033[1;32m'
c_off='\033[0m'
log()  { printf "${c_log}[export-pod]${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}[export-pod]${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}[export-pod]${c_off} %s\n" "$*" >&2; }
die()  { printf "${c_err}[export-pod]${c_off} %s\n" "$*" >&2; exit 1; }

[[ -f package.json ]] || die "找不到 package.json，先 cd 到 CodeAndPurrs 项目根目录再跑。"
grep -q '"codeandpurrs"' package.json \
  || warn "package.json 里没找到 name=codeandpurrs，继续跑但请确认目录对。"

command -v git  >/dev/null || die "没找到 git。"
command -v node >/dev/null || die "没找到 node。"
command -v npm  >/dev/null || die "没找到 npm。"

# 有本地脏改动的话，看 HARD_RESET 决定丢弃还是 stash 保命
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [[ "$HARD_RESET" == "1" ]]; then
    warn "本地有改动，HARD_RESET=1 直接丢弃。"
    git reset --hard
    git clean -fd
  else
    stash_name="export-pod-deploy-$(date +%Y%m%d-%H%M%S)"
    warn "工作区有未提交的改动，先 stash 保命：$stash_name"
    git stash push -u -m "$stash_name" || warn "stash 失败（可能没东西可存），继续。"
  fi
fi

log "拉取 origin/$BRANCH"
git fetch origin "$BRANCH"

log "切到 $BRANCH（跟着 origin 走）"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  git checkout -B "$BRANCH" "origin/$BRANCH"
fi
log "当前 commit：$(git log --oneline -1)"

if [[ "$SKIP_INSTALL" == "1" ]]; then
  warn "SKIP_INSTALL=1，跳过 npm install。"
else
  log "npm install（没变化会秒过）"
  npm install --no-audit --no-fund
fi

if [[ "$MODE" == "preview" ]]; then
  log "npm run build"
  npm run build
  RUN_CMD="npm run preview -- --host 0.0.0.0 --port ${PORT}"
elif [[ "$MODE" == "dev" ]]; then
  RUN_CMD="npm run dev -- --host 0.0.0.0 --port ${PORT}"
else
  die "MODE 只能是 dev 或 preview，收到：$MODE"
fi

# 停旧进程
if [[ "$USE_PM2" == "1" ]]; then
  command -v pm2 >/dev/null || die "USE_PM2=1 但没装 pm2。npm i -g pm2 或去掉 USE_PM2。"
  log "pm2 停旧的 ${PM2_NAME}"
  pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
else
  log "停旧的 vite 进程（没找到就跳过）"
  pkill -f "vite" 2>/dev/null || true
  sleep 1
fi

# 启新进程
if [[ "$USE_PM2" == "1" ]]; then
  log "pm2 起：${RUN_CMD}"
  pm2 start bash --name "$PM2_NAME" --time -- -lc "$RUN_CMD"
  pm2 save >/dev/null 2>&1 || true
else
  log "后台起（日志：vite.log）：${RUN_CMD}"
  nohup bash -lc "$RUN_CMD" > vite.log 2>&1 &
  disown 2>/dev/null || true
  sleep 2
fi

# 端口自检
listen_ok=0
if command -v ss >/dev/null; then
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${PORT}\$" && listen_ok=1
elif command -v netstat >/dev/null; then
  netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${PORT}\$" && listen_ok=1
fi

if [[ "$listen_ok" == "1" ]]; then
  ok "端口 ${PORT} 已监听 ✅"
else
  warn "端口 ${PORT} 还没听上，看下 vite.log 或 pm2 logs ${PM2_NAME} 排查。"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "${IP:-}" ]] && IP="127.0.0.1"
ok "全部完成。访问：http://${IP}:${PORT}/"
log "打开首页 → 点【导出舱】卡片 → 右上角切【🪄 跟系统 / ☀️ 白天 / 🌙 夜晚】"
