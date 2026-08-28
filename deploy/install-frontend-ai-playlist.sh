#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly BRANCH="codex/frontend-ai-playlist-20260828"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly STAGE="$(mktemp -d /tmp/codeandpurrs-ai-play.XXXXXX)"
readonly BACKUP="/root/backups/codeandpurrs-ai-play-${STAMP}"
readonly FILES=("server/proxy.mjs" "src/pages/PurrChannelPage.tsx" "src/services/spotify.ts")
readonly BLOBS=("f240b4e14a4922ef5d88c6c6b41d6aa4d1376f74" "75ac9d323583f1024507427b6e4e807c1e561d6e" "566921064045d67b0159e70e1f8dd9fa786d8276")

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。"
  exit 1
fi
if [[ "${APP}" != "/var/www/codeandpurrs" ]]; then
  echo "拒绝操作未知目录：${APP}"
  exit 1
fi
for command_name in git tar node npm pm2 curl; do
  command -v "${command_name}" >/dev/null || { echo "缺少命令：${command_name}"; exit 1; }
done
[[ -d "${APP}/.git" && -f "${APP}/server/proxy.mjs" && -d "${APP}/dist" ]] || {
  echo "CodeAndPurrs 目录结构不符合预期，未改动。"
  exit 1
}
pm2 describe codeandpurrs >/dev/null || {
  echo "没有找到 PM2 进程 codeandpurrs，未改动。"
  exit 1
}

tang_before="$(systemctl is-active tang-web.service 2>/dev/null || true)"
git -C "${APP}" fetch --quiet origin "${BRANCH}"
fetched_commit="$(git -C "${APP}" rev-parse FETCH_HEAD)"

for index in "${!FILES[@]}"; do
  file="${FILES[${index}]}"
  expected="${BLOBS[${index}]}"
  actual="$(git -C "${APP}" rev-parse "FETCH_HEAD:${file}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "远端文件校验失败：${file}，未改动。"
    exit 1
  fi
done

(
  cd "${APP}"
  tar --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='server/data' -cf - .
) | (
  cd "${STAGE}"
  tar -xf -
)

for file in "${FILES[@]}"; do
  mkdir -p "${STAGE}/$(dirname "${file}")"
  git -C "${APP}" show "FETCH_HEAD:${file}" > "${STAGE}/${file}"
done

if [[ -d "${APP}/node_modules" ]]; then
  ln -s "${APP}/node_modules" "${STAGE}/node_modules"
else
  (cd "${STAGE}" && npm ci)
fi

node --check "${STAGE}/server/proxy.mjs"
(cd "${STAGE}" && npm run build)
[[ -f "${STAGE}/dist/index.html" ]] || {
  echo "构建没有产生 dist/index.html，未改动线上。"
  exit 1
}

mkdir -p "${BACKUP}"
for file in "${FILES[@]}"; do
  mkdir -p "${BACKUP}/$(dirname "${file}")"
  cp -a "${APP}/${file}" "${BACKUP}/${file}"
done
cp -a "${APP}/dist" "${BACKUP}/live-dist"

next_dist="${APP}/.dist-ai-play-${STAMP}"
cp -a "${STAGE}/dist" "${next_dist}"
for file in "${FILES[@]}"; do
  install -m 0644 "${STAGE}/${file}" "${APP}/${file}"
done
mv "${APP}/dist" "${BACKUP}/deployed-old-dist"
mv "${next_dist}" "${APP}/dist"

deployment_ok=1
pm2 restart codeandpurrs --update-env >/dev/null || deployment_ok=0
sleep 3
curl -fsS http://127.0.0.1:8787/api/spotify/status >/dev/null || deployment_ok=0

if [[ "${deployment_ok}" -ne 1 ]]; then
  echo "健康检查失败，正在恢复 CodeAndPurrs 备份。"
  for file in "${FILES[@]}"; do
    cp -a "${BACKUP}/${file}" "${APP}/${file}"
  done
  mv "${APP}/dist" "${BACKUP}/failed-new-dist"
  mv "${BACKUP}/deployed-old-dist" "${APP}/dist"
  pm2 restart codeandpurrs --update-env >/dev/null || true
  echo "已回滚。备份：${BACKUP}"
  exit 1
fi

tang_after="$(systemctl is-active tang-web.service 2>/dev/null || true)"
echo "完成：CodeAndPurrs AI 点歌已部署。"
echo "GitHub 提交：${fetched_commit}"
echo "备份：${BACKUP}"
echo "Tang 状态：${tang_before} -> ${tang_after}（未操作）"
echo "现在打开 CodeAndPurrs 呼噜频道，让任一 AI 说“给我点一首歌”即可测试。"
