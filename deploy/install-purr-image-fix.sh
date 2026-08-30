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

# 线上分支经历过多次人工合并，旧 guard 的具体拼法并不稳定。定位唯一的
# pickPhoto 函数并整体替换，避免再依赖其中某一行文字。
function_marker = "  const pickPhoto = async "
if text.count(function_marker) != 1:
    raise SystemExit("图片选择函数数量异常，未改动线上。")
function_start = text.index(function_marker)
function_end_marker = "\n  };\n"
function_end = text.find(function_end_marker, function_start)
if function_end == -1:
    raise SystemExit("图片选择函数结尾缺失，未改动线上。")
function_end += len(function_end_marker)

max_line = "  const MAX_PHOTOS_PER_SEND = 3;\n"
if max_line not in text[:function_start]:
    text = text[:function_start] + max_line + text[function_start:]
    function_start += len(max_line)
    function_end += len(max_line)

new_function = '''  const pickPhoto = async (files: FileList | null) => {
    // Android/部分 WebView 的 FileList 是 live 对象；先复制成普通数组再处理。
    const selectedFiles = files ? Array.from(files) : [];
    if (selectedFiles.length === 0 || sending) return;
    const remaining = MAX_PHOTOS_PER_SEND - pendingPhotos.length;
    if (remaining <= 0) return;
    // content:// 图片有时没有 MIME；accept 已限定为图片，空 MIME 也接收。
    const list = selectedFiles.filter((f) => !f.type || f.type.startsWith('image/')).slice(0, remaining);
    if (list.length === 0) {
      setNotice('没有读到可用图片，请换一张重试');
      return;
    }
    try {
      const ids = await Promise.all(list.map((f) => addPhoto(f)));
      setPendingPhotos((prev) => [...prev, ...ids]);
    } catch (err) {
      setNotice(`图片没有存进去：${String((err as Error)?.message || err)}`);
    }
  };
'''
text = text[:function_start] + new_function + text[function_end:]

# 同样整体替换唯一的相册 input：取消 Android 容易卡住的 multiple，
# 在打开相册前清空 value，确保同一张图也能再次触发 change。
input_ref = "ref={photoFileRef}"
if text.count(input_ref) != 1:
    raise SystemExit("图片 input 数量异常，未改动线上。")
ref_index = text.index(input_ref)
input_start = text.rfind("          <input", 0, ref_index)
input_end = text.find("          />", ref_index)
if input_start == -1 or input_end == -1:
    raise SystemExit("图片 input 边界缺失，未改动线上。")
input_end += len("          />")
new_input = '''          <input
            ref={photoFileRef}
            type="file"
            accept="image/*"
            hidden
            onClick={(event) => { event.currentTarget.value = ''; }}
            onChange={(event) => void pickPhoto(event.currentTarget.files)}
          />'''
text = text[:input_start] + new_input + text[input_end:]

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
