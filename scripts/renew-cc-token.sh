#!/usr/bin/env bash
# 一条命令换掉 Claude Code 长效 token —— 全程不用人肉抄 token。
#
# 用法(VPS 上)：
#   bash /var/www/codeandpurrs/scripts/renew-cc-token.sh
#
# 它做的事：
#   1. 用 script(伪终端)跑 claude setup-token，把屏幕输出同时录到临时文件
#      ——你照常在终端里粘授权 code、回车，跟平时一模一样；
#   2. 成功后从录到的输出里【自动抓】sk-ant-oat01- 那串长效 token
#      (valid for 1 year)，不用你看着截图一个字母一个字母念给 AI 抄；
#   3. 拿它真打一次 API 验证，通过才备份 .env、写入、pm2 重启；
#   4. 无论成败都把临时文件擦掉(里面有 token 明文)。
#
# 名词别再搞混(2026-07-25 踩过两轮)：
#   · 授权 code = 浏览器页面上"Paste this into Claude Code"那串(带 #)，
#     一次性，用途是粘回终端提示符，【不是】token、不能写进 .env；
#   · 长效 token = 粘完 code 后终端打出来的 sk-ant-oat01-...，一年有效，
#     这个才是 .env 里 CLAUDE_CODE_OAUTH_TOKEN 要的东西；
#   · ~/.claude/.credentials.json 里的 accessToken = 短效会轮换的，
#     写进 .env 第二天就失效，"每天都要重弄"的元凶，别碰。

set -u

ENV_FILE="${ENV_FILE:-/var/www/codeandpurrs/.env}"
LOG="$(mktemp /tmp/cc-token.XXXXXX.log)"
cleanup() { rm -f "$LOG" 2>/dev/null || true; }
trap cleanup EXIT

if ! command -v script >/dev/null 2>&1; then
  echo "❌ 缺 script 命令(util-linux)，先跑： apt-get install -y bsdutils util-linux"
  exit 1
fi

echo "=================================================="
echo " 1/4  跑 claude setup-token"
echo " 待会儿它会打印一个 https://claude.com/... 的网址："
echo "   · 复制到浏览器打开 → 用有订阅的账号 Authorize"
echo "   · 把页面上那串授权 code(带 #，整段)粘回这里、回车"
echo " 剩下的我全自动，你不用再抄任何东西。"
echo "=================================================="
echo

script -q -c "claude setup-token" "$LOG"

echo
echo "== 2/4 从输出里自动提取长效 token =="
TOKEN="$(grep -oE 'sk-ant-oat[A-Za-z0-9_-]+' "$LOG" | tail -1)"

if [ -z "$TOKEN" ]; then
  echo "❌ 没抓到 sk-ant-oat 开头的 token——多半是 setup-token 没走完"
  echo "   (授权失败/code 贴错/中途退出)。.env 一个字没改，重跑本脚本即可。"
  exit 1
fi
echo "抓到 token：${TOKEN:0:18}…${TOKEN: -6}(中间省略，不打全)"

echo
echo "== 3/4 拿它真打一次 API 验证(顺带验 Opus 5 通不通) =="
OUT="$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude --print --model claude-opus-5 "数到三" 2>&1)"
RC=$?
echo "$OUT"
if [ $RC -ne 0 ] || printf '%s' "$OUT" | grep -qiE '401|revoked|not logged in|failed to authenticate|invalid'; then
  echo
  echo "❌ 验证不通过——【没有】改动 $ENV_FILE。"
  echo "   若报 unknown model，可能是模型名的事，token 本身也许是好的："
  echo "   手动跑： bash $(dirname "$0")/set-cc-token.sh '<刚抓到的token>'"
  exit 1
fi

echo
echo "== 4/4 写入 $ENV_FILE(先备份) + 重启 =="
cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)" || { echo "❌ 备份失败，中止"; exit 1; }
sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "$ENV_FILE"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
pm2 restart codeandpurrs --update-env >/dev/null 2>&1
sleep 3

if pm2 logs codeandpurrs --lines 30 --nostream 2>/dev/null | grep -q 'claudecode:已配置'; then
  echo "✅ 全部完成：token 已生效(一年有效)，日志看到 claudecode:已配置。"
  echo "   现在去 https://nekopurrs.uk 找予予聊两句验收吧。"
else
  echo "⚠️  token 验证通过、已写入，但日志暂时没看到 claudecode:已配置。"
  echo "   再等几秒跑： pm2 logs codeandpurrs --lines 20 --nostream"
fi
