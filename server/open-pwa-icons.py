#!/usr/bin/env python3
"""
让主屏快捷方式重新显示 CodeAndPurrs 的图标。

为什么会变成一个自动生成的字母「N」：
    站点上锁（lock-usage-reads.py 给 location / 加了 basic auth）之后，
    <link rel="manifest"> 这一类请求浏览器【默认不带】凭据去取
    （credentials mode = omit，规范如此，不是 bug），于是拿到 401。
    manifest 取不到 → name / icons 全部作废 → 加到主屏时浏览器只好
    拿域名首字母画一个圆底图标。图标文件本身好好地躺在 dist/ 里，
    从来没丢过，是被锁在门外了。

两边一起改才彻底：
    · index.html 那行 <link rel="manifest"> 加 crossorigin="use-credentials"
      （已经在代码里改好，随下次 npm run build 生效）
    · 这个脚本把 manifest 和几个图标从 basic auth 里放出来——因为图标是
      浏览器在页面之外单独取的，光靠上面那行不一定够，而这几个文件
      本来也没有任何隐私可言。

    python3 open-pwa-icons.py            # 只看会改成什么，不落盘
    python3 open-pwa-icons.py --apply    # 真改，改完自动 nginx -t + reload
                                         # -t 不过就原样还原
"""

import argparse
import pathlib
import re
import shutil
import subprocess
import sys
from datetime import datetime

SITE_VHOST = "/etc/nginx/sites-enabled/nekopurrs.uk"
BACKUP_DIR = pathlib.Path("/root/nginx-backups")

MARK = "manifest\\.webmanifest"          # 认这个判断装没装过

PUBLIC_FILES = (
    "manifest.webmanifest",
    "sw.js",
    "favicon.ico",
    "favicon-32.png",
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-192.png",
    "icon-maskable-512.png",
)

BLOCK_TPL = """
    # 主屏图标：manifest 和图标得免密才取得到，否则桌面上只剩一个字母「N」。
    # 由 server/open-pwa-icons.py 加的。正则 location 优先级高于前缀 location，
    # 所以它盖得住上面那个上了锁的 location /；/api/ 一律不匹配，不受影响。
    # root 从 server 块继承，不用再写一遍。
    location ~* ^/({names})$ {{
        auth_basic off;
        access_log off;
    }}
"""

BLOCK_RE = re.compile(r"(?m)^([ \t]*)(location\b[^{;]*|server)\s*\{")


def _match_brace(text: str, open_idx: int) -> int:
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _blocks(text: str, kind: str):
    for m in BLOCK_RE.finditer(text):
        head = m.group(2)
        if not head.startswith(kind):
            continue
        open_idx = m.end() - 1
        close = _match_brace(text, open_idx)
        if close < 0:
            continue
        yield m.group(1), head, open_idx, close


def patch(text: str) -> tuple:
    """
    只动【真正提供页面的那个 server 块】——certbot 会另留一个 listen 80
    只做 301 跳转的块，那个碰不得。认 try_files 找它（SPA 的 location /
    一定有这行），跟 lock-usage-reads.py 用的是同一个判据。
    """
    target = None
    for _indent, _head, open_idx, close in _blocks(text, "server"):
        if "try_files" in text[open_idx:close]:
            target = (open_idx, close)
            break
    if target is None:
        return text, "找不到提供页面的那个 server 块（没有 try_files）"

    open_idx, close = target
    block = text[open_idx:close]
    if MARK in block:
        return text, "已经放行过了，不用再改"

    names = "|".join(f.replace(".", "\\.") for f in PUBLIC_FILES)
    m = re.search(r"(?m)^[ \t]*server_name\b[^;]*;[ \t]*\n", block)
    if not m:
        return text, "这个 server 块里没有 server_name，不敢乱插"
    at = open_idx + m.end()
    return text[:at] + BLOCK_TPL.format(names=names) + text[at:], ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site-vhost", default=SITE_VHOST)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--no-reload", action="store_true", help="自测用：不碰真 nginx")
    a = ap.parse_args()

    path = pathlib.Path(a.site_vhost)
    if not path.exists():
        print(f"找不到 {path}", file=sys.stderr)
        return 1

    old = path.read_text()
    new, why = patch(old)
    if new == old:
        print(why or "没什么可改的")
        return 0

    if not a.apply:
        print("—— 会加这一段（加 --apply 才真写）——")
        for line in new.splitlines():
            if line not in old.splitlines():
                print("  +" + line)
        return 0

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUP_DIR / f"{path.name}.{stamp}"
    shutil.copy2(path, backup)
    path.write_text(new)

    if a.no_reload:
        print(f"已写入 {path}（备份 {backup}），--no-reload 跳过 nginx -t")
        return 0

    t = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if t.returncode != 0:
        shutil.copy2(backup, path)
        print("nginx -t 没过，已经原样还原：\n" + t.stderr, file=sys.stderr)
        return 1
    subprocess.run(["nginx", "-s", "reload"], check=False)
    print(f"好了。备份在 {backup}")
    print("手机上要重新加一次主屏快捷方式，图标才会换过来（旧的那个删掉）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
