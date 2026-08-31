#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly ENV_FILE="${APP}/.env"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly BACKUP="/root/backups/codeandpurrs-env-before-screen-${STAMP}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。"
  exit 1
fi
if [[ "${APP}" != "/var/www/codeandpurrs" || ! -f "${APP}/server/proxy.mjs" || ! -f "${ENV_FILE}" ]]; then
  echo "CodeAndPurrs 目录或 .env 不符合预期，未改动。"
  exit 1
fi
for command_name in node pm2 curl awk grep; do
  command -v "${command_name}" >/dev/null || { echo "缺少命令：${command_name}"; exit 1; }
done

mkdir -p "${BACKUP}"
cp -a "${ENV_FILE}" "${BACKUP}/.env"

viewer_key="$(awk -F= '/^CHAT_SAVE_KEY=/{sub(/^[^=]*=/, ""); value=$0} END{print value}' "${ENV_FILE}")"
if [[ -z "${viewer_key}" ]]; then
  viewer_key="$(node -e "process.stdout.write(require('node:crypto').randomBytes(18).toString('hex'))")"
fi

temp_env="$(mktemp "${APP}/.env.screen.XXXXXX")"
awk -v key="${viewer_key}" '
  BEGIN { written = 0 }
  /^CHAT_SAVE_KEY=/ {
    if (!written) {
      print "CHAT_SAVE_KEY=" key
      written = 1
    }
    next
  }
  { print }
  END {
    if (!written) {
      print ""
      print "CHAT_SAVE_KEY=" key
    }
  }
' "${ENV_FILE}" > "${temp_env}"
chmod --reference="${ENV_FILE}" "${temp_env}"
chown --reference="${ENV_FILE}" "${temp_env}"
mv "${temp_env}" "${ENV_FILE}"

pm2 restart codeandpurrs --update-env >/dev/null

http_code=""
for _ in $(seq 1 30); do
  http_code="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    -H "X-Chat-Save-Key: ${viewer_key}" \
    http://127.0.0.1:8787/api/screen/latest || true)"
  if [[ "${http_code}" == "200" || "${http_code}" == "404" ]]; then
    break
  fi
  sleep 1
done

if [[ "${http_code}" != "200" && "${http_code}" != "404" ]]; then
  cp -a "${BACKUP}/.env" "${ENV_FILE}"
  pm2 restart codeandpurrs --update-env >/dev/null 2>&1 || true
  echo "屏幕密码验证失败，已恢复原 .env。"
  exit 1
fi

echo "完成：AI 看屏幕密码已配置并通过接口验证。"
echo "屏幕密码：${viewer_key}"
echo "原 .env 备份：${BACKUP}/.env"

