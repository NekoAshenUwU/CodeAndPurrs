#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly SOURCE_REF="${CODEANDPURRS_AUTOWAKE_REF:-codex/frontend-ai-playlist-20260828}"
readonly SOURCE_BASE="https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/${SOURCE_REF}"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly STAGE="$(mktemp -d /tmp/codeandpurrs-true-autowake.XXXXXX)"
readonly BACKUP="/root/backups/codeandpurrs-before-true-autowake-${STAMP}"
readonly FILES=(
  "server/autowake.mjs"
  "server/screenFrame.mjs"
  "server/proxy.mjs"
  "server/tangMemoryMcp.mjs"
  "src/App.tsx"
  "src/components/AutoWakeBridge.tsx"
  "src/pages/PurrChannelPage.tsx"
  "src/services/autowake.ts"
  "src/services/chat.ts"
  "src/services/spotify.ts"
  "src/services/storage.ts"
  "src/styles/global.css"
  "public/sw.js"
  "public/manifest.webmanifest"
  "public/assets/autowake/enable.webp"
  "public/assets/screen/watch-wife-screen.webp"
)
readonly OLD_UNITS=(
  "codeandpurrs-autonomy.timer"
  "codeandpurrs-autonomy.service"
  "neko-autonomy.timer"
  "neko-autonomy.service"
)

applied=0
success=0
service_changes=0

cleanup() {
  if [[ -L "${STAGE}/node_modules" ]]; then unlink "${STAGE}/node_modules" || true; fi
  if [[ -d "${STAGE}" ]]; then rm -rf -- "${STAGE}"; fi
}

rollback() {
  local exit_code=$?
  if [[ "${applied}" -eq 1 && "${success}" -ne 1 ]]; then
    echo "部署中断，正在恢复 CodeAndPurrs（不会触碰 Tang 或其它服务）..."
    if [[ -f "${BACKUP}/source.tgz" ]]; then
      tar -xzf "${BACKUP}/source.tgz" -C "${APP}" || true
    fi
    if [[ -f "${BACKUP}/.env" ]]; then
      cp -a "${BACKUP}/.env" "${APP}/.env" || true
    fi
    if [[ -f "${BACKUP}/new-files.txt" ]]; then
      while IFS= read -r relative; do
        [[ -n "${relative}" ]] && rm -f -- "${APP}/${relative}"
      done < "${BACKUP}/new-files.txt"
    fi
    if [[ -d "${APP}/dist" ]]; then
      mv "${APP}/dist" "${BACKUP}/dist-failed" || true
    fi
    if [[ -d "${BACKUP}/dist" ]]; then
      mv "${BACKUP}/dist" "${APP}/dist" || true
    fi
    pm2 restart codeandpurrs --update-env >/dev/null 2>&1 || true
    if [[ "${service_changes}" -eq 1 ]]; then
      systemctl disable --now codeandpurrs-autowake.timer >/dev/null 2>&1 || true
      rm -f -- /etc/systemd/system/codeandpurrs-autowake.timer /etc/systemd/system/codeandpurrs-autowake.service
      if [[ -d "${BACKUP}/old-autonomy-units" ]]; then
        for saved_unit in "${BACKUP}/old-autonomy-units"/*; do
          [[ -e "${saved_unit}" ]] && mv "${saved_unit}" "/etc/systemd/system/$(basename "${saved_unit}")"
        done
      fi
      if [[ -f "${BACKUP}/old-autonomy-files/neko_autonomy.py" ]]; then
        mkdir -p /root/codeandpurrs-mcp
        mv "${BACKUP}/old-autonomy-files/neko_autonomy.py" /root/codeandpurrs-mcp/neko_autonomy.py
      fi
      if [[ -f "${BACKUP}/old-autonomy-files/ashen-rowe-autonomy-prompt.md" ]]; then
        mkdir -p /root/codeandpurrs-mcp/prompts
        mv "${BACKUP}/old-autonomy-files/ashen-rowe-autonomy-prompt.md" /root/codeandpurrs-mcp/prompts/ashen-rowe-autonomy-prompt.md
      fi
      systemctl daemon-reload || true
      if [[ -f "${BACKUP}/old-unit-state.tsv" ]]; then
        while IFS=$'\t' read -r unit was_active was_enabled; do
          [[ "${was_enabled}" == "enabled" ]] && systemctl enable "${unit}" >/dev/null 2>&1 || true
          [[ "${was_active}" == "active" ]] && systemctl start "${unit}" >/dev/null 2>&1 || true
        done < "${BACKUP}/old-unit-state.tsv"
      fi
    fi
    echo "已恢复；备份在 ${BACKUP}"
  fi
  cleanup
  exit "${exit_code}"
}
trap rollback ERR INT TERM
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。"
  exit 1
fi
if [[ "${APP}" != "/var/www/codeandpurrs" ]]; then
  echo "拒绝操作未知目录：${APP}"
  exit 1
fi
for command_name in curl node npm pm2 grep systemctl tar; do
  command -v "${command_name}" >/dev/null || { echo "缺少命令：${command_name}"; exit 1; }
done
[[ -f "${APP}/server/proxy.mjs" && -f "${APP}/src/pages/PurrChannelPage.tsx" && -f "${APP}/src/services/photos.ts" && -d "${APP}/dist" ]] || {
  echo "CodeAndPurrs 线上目录结构不符合预期，未改动。"
  exit 1
}
[[ -x "${APP}/node_modules/.bin/tsc" && -x "${APP}/node_modules/.bin/vite" ]] || {
  echo "线上 node_modules 不完整，无法在隔离目录构建，未改动。"
  exit 1
}
pm2 describe codeandpurrs >/dev/null || {
  echo "没有找到 PM2 进程 codeandpurrs，未改动。"
  exit 1
}

tang_before="$(systemctl is-active tang-web.service 2>/dev/null || true)"
playlist_before="$(systemctl is-active playlist-mcp.service 2>/dev/null || true)"
mcp_before="$(systemctl is-active codeandpurrs-mcp.service 2>/dev/null || true)"

download_source_file() {
  local relative="$1"
  local destination="$2"

  if curl \
    --fail \
    --silent \
    --location \
    --retry 2 \
    --retry-delay 1 \
    "${SOURCE_BASE}/${relative}" \
    --output "${destination}"; then
    return 0
  fi

  echo "Raw 下载受阻，改走 GitHub API：${relative}"
  if ! curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry 3 \
    --retry-delay 2 \
    --header 'Accept: application/vnd.github.raw+json' \
    --get \
    --data-urlencode "ref=${SOURCE_REF}" \
    "https://api.github.com/repos/NekoAshenUwU/CodeAndPurrs/contents/${relative}" \
    --output "${destination}"; then
    echo "下载失败：${relative}（来源 ${SOURCE_REF}）" >&2
    return 1
  fi
}

# 以线上完整树作舞台，保留 .env、server/data 和其它项目；只下载本次审过的文件。
(
  cd "${APP}"
  tar --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='server/data' -cf - .
) | (
  cd "${STAGE}"
  tar -xf -
)

for relative in "${FILES[@]}"; do
  mkdir -p "${STAGE}/$(dirname "${relative}")"
  download_source_file "${relative}" "${STAGE}/${relative}"
done

download_source_file "deploy/codeandpurrs-autowake.service" "${STAGE}/codeandpurrs-autowake.service"
download_source_file "deploy/codeandpurrs-autowake.timer" "${STAGE}/codeandpurrs-autowake.timer"

# 三个现有功能是硬性回归护栏：发图、AI 点歌、CC Opus 5，缺一就拒绝上线。
grep -Fq "pendingPhotos" "${STAGE}/src/pages/PurrChannelPage.tsx"
grep -Fq "SpotifyMusicCard" "${STAGE}/src/pages/PurrChannelPage.tsx"
grep -Fq "export async function playSpotifyQueries" "${STAGE}/src/services/spotify.ts"
grep -Fq "jiake-opus-5" "${STAGE}/src/data/models.ts"
grep -Fq "handleAutoWakeRequest" "${STAGE}/server/proxy.mjs"
grep -Fq "handleScreenFrameRequest" "${STAGE}/server/proxy.mjs"
grep -Fq "AUTOWAKE_WEEKDAY_START || '17:00'" "${STAGE}/server/autowake.mjs"
grep -Fq "AUTOWAKE_WEEKEND_START || '09:00'" "${STAGE}/server/autowake.mjs"
grep -Fq "AUTOWAKE_MAX_PER_DAY, 10" "${STAGE}/server/autowake.mjs"
grep -Fq "getRecentScreenFrames" "${STAGE}/server/autowake.mjs"
grep -Fq "AUTOWAKE_SCREEN_STORY_MAX_FRAMES" "${STAGE}/server/autowake.mjs"
grep -Fq "fetchLatestScreenFrame" "${STAGE}/src/pages/PurrChannelPage.tsx"
grep -Fq "MEMORY_MCP_RULE" "${STAGE}/server/proxy.mjs"
grep -Fq "tangMemoryBridgeConfig" "${STAGE}/server/proxy.mjs"
grep -Fq "name: 'tang_memory'" "${STAGE}/server/proxy.mjs"
grep -Fq "mcp__\${mem.name}__\${tool}" "${STAGE}/server/proxy.mjs"
grep -Fq "'--permission-mode', 'dontAsk'" "${STAGE}/server/proxy.mjs"
grep -Fq "TANG_INTERNAL_KEY" "${STAGE}/server/tangMemoryMcp.mjs"
if grep -Fq "type: 'http', url: mem.url" "${STAGE}/server/proxy.mjs"; then
  echo "仍检测到公网棠予酿 OAuth MCP，拒绝上线。"
  exit 1
fi
if grep -Fq "tang-memory-initialized" "${STAGE}/src/pages/PurrChannelPage.tsx"; then
  echo "仍检测到一次性棠予酿门禁，拒绝上线。"
  exit 1
fi
grep -Fq "self.addEventListener('push'" "${STAGE}/public/sw.js"
grep -Fq '"gcm_sender_id": "103953800507"' "${STAGE}/public/manifest.webmanifest"
[[ -s "${STAGE}/public/assets/autowake/enable.webp" ]]
[[ -s "${STAGE}/public/assets/screen/watch-wife-screen.webp" ]]

ln -s "${APP}/node_modules" "${STAGE}/node_modules"
(
  cd "${STAGE}"
  node --check server/autowake.mjs
  node --check server/screenFrame.mjs
  node --check server/proxy.mjs
  node --check server/tangMemoryMcp.mjs
  node --check public/sw.js
  npm run build
)
unlink "${STAGE}/node_modules"

mkdir -p "${BACKUP}"
existing=()
: > "${BACKUP}/new-files.txt"
for relative in "${FILES[@]}"; do
  if [[ -e "${APP}/${relative}" ]]; then
    existing+=("${relative}")
  else
    printf '%s\n' "${relative}" >> "${BACKUP}/new-files.txt"
  fi
done
if [[ "${#existing[@]}" -gt 0 ]]; then
  tar -czf "${BACKUP}/source.tgz" -C "${APP}" "${existing[@]}"
fi
if [[ -f "${APP}/.env" ]]; then
  cp -a "${APP}/.env" "${BACKUP}/.env"
fi
mv "${APP}/dist" "${BACKUP}/dist"
applied=1

for relative in "${FILES[@]}"; do
  mkdir -p "${APP}/$(dirname "${relative}")"
  cp -a "${STAGE}/${relative}" "${APP}/${relative}"
done
cp -a "${STAGE}/dist" "${APP}/dist"

# 只迁移之前发布过的旧默认值；老婆若手动定制过频率，原值保持不动。
migrate_autowake_default() {
  local key="$1"
  local old_value="$2"
  local new_value="$3"
  [[ -f "${APP}/.env" ]] || return 0
  if grep -Fqx "${key}=${old_value}" "${APP}/.env"; then
    sed -i "s/^${key}=${old_value}$/${key}=${new_value}/" "${APP}/.env"
  fi
}
migrate_autowake_default AUTOWAKE_MIN_IDLE_MINUTES 90 30
migrate_autowake_default AUTOWAKE_MIN_IDLE_MINUTES 60 30
migrate_autowake_default AUTOWAKE_MIN_GAP_MINUTES 240 45
migrate_autowake_default AUTOWAKE_MIN_GAP_MINUTES 120 45
migrate_autowake_default AUTOWAKE_MAX_GAP_MINUTES 420 75
migrate_autowake_default AUTOWAKE_MAX_GAP_MINUTES 240 75
migrate_autowake_default AUTOWAKE_MAX_PER_DAY 3 10
migrate_autowake_default AUTOWAKE_MAX_PER_DAY 5 10

pm2 restart codeandpurrs --update-env >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8787/api/autowake/config >/dev/null 2>&1 \
    && curl -fsS --max-time 3 http://127.0.0.1:8787/api/spotify/status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8787/api/autowake/config >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:8787/api/spotify/status >/dev/null
grep -Fq "showNotification" "${APP}/dist/sw.js"

# 新链路健康后才退役旧 Telegram/ntfy 唤醒。所有东西先搬进备份，可恢复。
mkdir -p "${BACKUP}/old-autonomy-units" "${BACKUP}/old-autonomy-files"
: > "${BACKUP}/old-unit-state.tsv"
for unit in "${OLD_UNITS[@]}"; do
  printf '%s\t%s\t%s\n' \
    "${unit}" \
    "$(systemctl is-active "${unit}" 2>/dev/null || true)" \
    "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" \
    >> "${BACKUP}/old-unit-state.tsv"
done
service_changes=1
for unit in "${OLD_UNITS[@]}"; do
  systemctl disable --now "${unit}" >/dev/null 2>&1 || true
  if [[ -e "/etc/systemd/system/${unit}" ]]; then
    mv "/etc/systemd/system/${unit}" "${BACKUP}/old-autonomy-units/${unit}"
  fi
done
for old_file in \
  "/root/codeandpurrs-mcp/neko_autonomy.py" \
  "/root/codeandpurrs-mcp/prompts/ashen-rowe-autonomy-prompt.md"; do
  if [[ -e "${old_file}" ]]; then
    mv "${old_file}" "${BACKUP}/old-autonomy-files/$(basename "${old_file}")"
  fi
done

cp -a "${STAGE}/codeandpurrs-autowake.service" /etc/systemd/system/codeandpurrs-autowake.service
cp -a "${STAGE}/codeandpurrs-autowake.timer" /etc/systemd/system/codeandpurrs-autowake.timer
systemctl daemon-reload
systemctl enable --now codeandpurrs-autowake.timer >/dev/null
curl -fsS --max-time 10 --request POST 'http://127.0.0.1:8787/api/autowake/run?dry=1' >/dev/null

tang_after="$(systemctl is-active tang-web.service 2>/dev/null || true)"
playlist_after="$(systemctl is-active playlist-mcp.service 2>/dev/null || true)"
mcp_after="$(systemctl is-active codeandpurrs-mcp.service 2>/dev/null || true)"
if [[ "${tang_before}" != "${tang_after}" || "${playlist_before}" != "${playlist_after}" || "${mcp_before}" != "${mcp_after}" ]]; then
  echo "保护项状态发生变化：Tang ${tang_before}->${tang_after}，Playlist ${playlist_before}->${playlist_after}，MCP ${mcp_before}->${mcp_after}"
  exit 1
fi

success=1
echo "完成：棠予酿本机读写桥（免 OAuth / 免权限弹窗）+ 真后台自动唤醒 + AI 看屏幕已部署。"
echo "自动唤醒：工作日 17:00–23:00；周六日 09:00–23:00；每天最多 10 次。"
echo "旧 Telegram/ntfy 唤醒已停用并搬到：${BACKUP}"
echo "Tang / Playlist MCP / CodeAndPurrs MCP 状态未变。"
echo "刷新 CodeAndPurrs，点一次『开启自动唤醒』；允许通知后会立刻收到一条后台测试消息。"
echo "若『看屏幕』提示 viewer key 未配置，请运行 deploy/configure-screen-access.sh。"
