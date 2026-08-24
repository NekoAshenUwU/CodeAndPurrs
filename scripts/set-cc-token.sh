#!/usr/bin/env bash
# 把 Claude Code 长效 token 写进 /var/www/codeandpurrs/.env —— 先验证后写入。
#
# 用法(VPS 上)：
#   bash /var/www/codeandpurrs/scripts/set-cc-token.sh '你的token'
#
# 为什么要"先验证后写入"：2026-07-25 踩过——把浏览器授权拿到的 code
# (带 # 的那串，一次性用完作废)当成 token 写进 .env，聊天直接全线回 mock，
# 而且要等重启后看日志才发现。现在改成：先拿这串去真打一次 API，
# 通过了才动 .env；不通过原样退出，什么都不改。
#
# ⚠️ token 长这样：sk-ant-oat01-xxxxx(valid for 1 year，claude setup-token
# 成功时直接打在屏幕上，只显示一次)。不是 ~/.claude/.credentials.json 里
# 那个 accessToken(短效会轮换，写进去第二天就失效)。

set -u

ENV_FILE="${ENV_FILE:-/var/www/codeandpurrs/.env}"
TOKEN="${1:-}"

if [ -z "$TOKEN" ]; then
  echo "用法: bash $0 '你的token'"
  echo "  token 是 claude setup-token 成功后屏幕上 sk-ant-oat01- 开头那串"
  exit 1
fi

# 把常见的手滑清掉：包裹的尖括号/引号、首尾空白、行内换行残留
TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^[<"'"'"']*//' -e 's/[>"'"'"']*$//')"

echo "== 1/3 先验证这串能不能真的调通 Claude Code =="
case "$TOKEN" in
  sk-ant-oat*) : ;;
  *) echo "⚠️  注意：这串不是 sk-ant-oat 开头，多半不是长效 token(可能是授权 code)。仍然照测，通过就算数。" ;;
esac

OUT="$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude --print --model claude-opus-5 "数到三" 2>&1)"
RC=$?
echo "$OUT"

if [ $RC -ne 0 ] || printf '%s' "$OUT" | grep -qiE '401|revoked|not logged in|failed to authenticate|invalid'; then
  echo
  echo "❌ 验证不通过——【没有】改动 $ENV_FILE，现在的聊天不受影响。"
  echo "   如果上面报的是 401/revoked：这串不是有效 token，重跑 claude setup-token，"
  echo "   把成功后屏幕上 sk-ant-oat01- 那串(只显示一次)复制下来再跑本脚本。"
  exit 1
fi

echo
echo "== 2/3 验证通过，写入 $ENV_FILE(先备份) =="
cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)" || { echo "❌ 备份失败，中止"; exit 1; }
sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "$ENV_FILE"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"

echo "== 3/3 重启 pm2 并检查日志 =="
pm2 restart codeandpurrs --update-env >/dev/null 2>&1
sleep 3
pm2 logs codeandpurrs --lines 15 --nostream | tail -15

echo
if pm2 logs codeandpurrs --lines 30 --nostream 2>/dev/null | grep -q 'claudecode:已配置'; then
  echo "✅ 全部完成：token 已生效，日志看到 claudecode:已配置。"
else
  echo "⚠️  token 验证是通过的，但日志里暂时没看到 claudecode:已配置——"
  echo "   再等几秒跑一次： pm2 logs codeandpurrs --lines 20 --nostream"
fi
