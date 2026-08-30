#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP="${CODEANDPURRS_DIR:-/var/www/codeandpurrs}"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly STAGE="$(mktemp -d /tmp/codeandpurrs-image-fix.XXXXXX)"
readonly BACKUP="/root/backups/codeandpurrs-image-fix-${STAMP}"
readonly FILES=("src/pages/PurrChannelPage.tsx" "src/services/photos.ts" "src/services/memes.ts")

cleanup() { rm -rf -- "${STAGE}"; }
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。"
  exit 1
fi
if [[ "${APP}" != "/var/www/codeandpurrs" ]]; then
  echo "拒绝操作未知目录：${APP}"
  exit 1
fi
for command_name in tar node npm pm2 curl python3; do
  command -v "${command_name}" >/dev/null || { echo "缺少命令：${command_name}"; exit 1; }
done
for file in "${FILES[@]}"; do
  [[ -f "${APP}/${file}" ]] || { echo "缺少 ${APP}/${file}，未改动。"; exit 1; }
done
[[ -d "${APP}/dist" ]] || { echo "缺少线上 dist，未改动。"; exit 1; }
pm2 describe codeandpurrs >/dev/null || { echo "没有找到 PM2 进程 codeandpurrs，未改动。"; exit 1; }

tang_before="$(systemctl is-active tang-web.service 2>/dev/null || true)"
(
  cd "${APP}"
  tar --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='server/data' -cf - .
) | (
  cd "${STAGE}"
  tar -xf -
)

# 只在临时副本中恢复已经验证过的两项图片修复；任一结构不符就停止。
python3 - "${STAGE}" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
purr = root / "src/pages/PurrChannelPage.tsx"
text = purr.read_text(encoding="utf-8")

selected_sentinel = "const selectedFiles = files ? Array.from(files) : [];"
if selected_sentinel not in text:
    marker = "  const pickPhoto = async (files: FileList | null) => {\n"
    if text.count(marker) != 1:
        raise SystemExit("图片选择回调结构不符，未改动线上。")
    block = (
        "    // 复制 FileList 后才能清空 input；Android 会同步清空 live FileList。\n"
        "    const selectedFiles = files ? Array.from(files) : [];\n"
    )
    text = text.replace(marker, marker + block, 1)

    old_guard = "    if (!files || sending) return;"
    if text.count(old_guard) != 1:
        raise SystemExit("图片选择 guard 结构不符，未改动线上。")
    text = text.replace(old_guard, "    if (selectedFiles.length === 0 || sending) return;", 1)

    old_list = "    const list = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, remaining);"
    if text.count(old_list) != 1:
        raise SystemExit("图片列表结构不符，未改动线上。")
    text = text.replace(
        old_list,
        "    const list = selectedFiles.filter((f) => f.type.startsWith('image/')).slice(0, remaining);",
        1,
    )

error_sentinel = "图片没有存进去："
if error_sentinel not in text:
    old_store = (
        "    const ids = await Promise.all(list.map((f) => addPhoto(f)));\n"
        "    setPendingPhotos((prev) => [...prev, ...ids]);\n"
    )
    if text.count(old_store) != 1:
        raise SystemExit("图片存储结构不符，未改动线上。")
    new_store = (
        "    try {\n"
        "      const ids = await Promise.all(list.map((f) => addPhoto(f)));\n"
        "      setPendingPhotos((prev) => [...prev, ...ids]);\n"
        "    } catch (err) {\n"
        "      setNotice(`图片没有存进去：${String((err as Error)?.message || err)}`);\n"
        "    }\n"
    )
    text = text.replace(old_store, new_store, 1)

purr.write_text(text, encoding="utf-8")

for relative in ("src/services/photos.ts", "src/services/memes.ts"):
    path = root / relative
    source = path.read_text(encoding="utf-8")
    if "indexedDB.open(DB_NAME);" in source:
        continue
    old_open = "indexedDB.open(DB_NAME, DB_VERSION)"
    if source.count(old_open) != 1:
        raise SystemExit(f"数据库打开结构不符：{relative}，未改动线上。")
    source, removed = re.subn(r"^const DB_VERSION = \d+;\n", "", source, count=1, flags=re.MULTILINE)
    if removed != 1:
        raise SystemExit(f"数据库版本结构不符：{relative}，未改动线上。")
    source = source.replace(old_open, "indexedDB.open(DB_NAME)", 1)
    path.write_text(source, encoding="utf-8")

print("临时源码图片修复完成。")
PY

if [[ -d "${APP}/node_modules" ]]; then
  ln -s "${APP}/node_modules" "${STAGE}/node_modules"
else
  (cd "${STAGE}" && npm ci)
fi

node --check "${STAGE}/server/proxy.mjs"
(cd "${STAGE}" && npm run build)
[[ -f "${STAGE}/dist/index.html" ]] || { echo "构建没有产生 dist/index.html，未改动线上。"; exit 1; }

mkdir -p "${BACKUP}"
for file in "${FILES[@]}"; do
  mkdir -p "${BACKUP}/$(dirname "${file}")"
  cp -a "${APP}/${file}" "${BACKUP}/${file}"
done
cp -a "${APP}/dist" "${BACKUP}/live-dist"

next_dist="${APP}/.dist-image-fix-${STAMP}"
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
  for file in "${FILES[@]}"; do cp -a "${BACKUP}/${file}" "${APP}/${file}"; done
  mv "${APP}/dist" "${BACKUP}/failed-new-dist"
  mv "${BACKUP}/deployed-old-dist" "${APP}/dist"
  pm2 restart codeandpurrs --update-env >/dev/null || true
  echo "已回滚。备份：${BACKUP}"
  exit 1
fi

tang_after="$(systemctl is-active tang-web.service 2>/dev/null || true)"
echo "完成：呼噜频道发图已修复。"
echo "备份：${BACKUP}"
echo "Tang 状态：${tang_before} -> ${tang_after}（未操作）"
