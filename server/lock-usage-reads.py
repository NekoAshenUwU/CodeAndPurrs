#!/usr/bin/env python3
"""
给 bridge 的【读】接口上锁。写接口（app 上报）一点不动。

现在的状况：/api/usage/latest、/day、/trend、/health、/api/location/latest
全都是裸的，谁知道域名谁就能看见棠棠昨晚几点睡、今天刷了多久小红书。
Node 那边的 X-Bridge-Token 只挡 POST，GET 从来没挡过。

为什么在 nginx 上做而不是改 Node：
  · 红米 app 一个字都不用动，也不用重装
  · Node 那边不用重启，上报不断线
  · 出事回退就是把备份拷回去 reload，不牵扯服务

放行的只有这三条，而且【连方法一起钉死】——GET /api/usage/ingest 也进不来：
    POST /api/usage/ingest
    POST /api/usage/ping
    POST /api/location/ingest
外加 OPTIONS（CORS 预检，401 掉的话浏览器那边会变成一个查不出原因的
网络错误）。其余一律要 basic auth。

做法是两张 map + 每个反代块加两行 auth_basic。auth_basic 的值可以是变量，
值为 off 就是这一条不查——所以同一个 location 里能按路径分开处理，
不用把 location 拆成一堆。

两个 vhost 一起改，是因为只改一个必然留下坏状态：
  · 只锁 api.* → 足迹页跨域拿不到数据，静悄悄退回 demo
  · 只改站点  → 数据还在公网上敞着
所以要么两个都成，要么一个都不动（nginx -t 不过会把两个都还原）。

    python3 lock-usage-reads.py                 # 只看会改什么，不落盘
    python3 lock-usage-reads.py --apply
"""

import argparse
import base64
import hashlib
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime

VHOST = "/etc/nginx/sites-enabled/api.nekopurrs.uk"
MAPFILE = "/etc/nginx/conf.d/neko-bridge-auth.conf"
HTPASSWD = "/etc/nginx/.htpasswd-neko"
BACKUP_DIR = pathlib.Path("/root/nginx-backups")
SITE_VHOST = "/etc/nginx/sites-enabled/nekopurrs.uk"
UPSTREAM = "127.0.0.1:8788"
USER = "neko"
# 站点和读接口用同一个 realm，浏览器才会把输过的密码自动带给同源的
# /api/usage/*。realm 不一样的话页面弹一次、fetch 再被挡一次。
REALM = "neko purrs"

MARK = "$bridge_auth"          # 认这个判断装没装过

MAPS = """# 猫爪足迹 bridge：只有 app 上报那几条免密，其余都要 basic auth。
# 由 server/lock-usage-reads.py 生成，别手改——再跑一次会整个覆盖。
#
# 键把方法和路径拼在一起，所以 GET /api/usage/ingest 不算放行。
map "$request_method:$request_uri" $bridge_open {
    default                         0;
    "~^OPTIONS:"                    1;   # CORS 预检，挡掉会变成查不出原因的网络错误
    "~^POST:/api/usage/ingest"      1;
    "~^POST:/api/usage/ping"        1;
    "~^POST:/api/location/ingest"   1;
}

# auth_basic 收到 off 就是不查这一条。
map $bridge_open $bridge_auth {
    1   off;
    0   "neko usage bridge";
}
"""

SITE_LOCATIONS_TPL = """
    # 猫爪足迹：读接口走同源，跟站点共用一把锁。lock-usage-reads.py 加的。
    # 跨域的 401 在 fetch 里不会弹密码框，只会静悄悄失败——所以页面要看真数据
    # 就得从同源拿。nginx 前缀匹配取最长的，这两条比下面的 /api/ 更具体，
    # 所以 8787 那条不受影响。
{blocks}"""

SITE_ONE_LOC_TPL = """
    location {path} {{
        auth_basic "{realm}";
        auth_basic_user_file {htpasswd};
        proxy_pass http://{upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }}
"""

SITE_AUTH_TPL = (
    '        auth_basic "{realm}";\n'
    "        auth_basic_user_file {htpasswd};\n"
)

AUTH_LINES_TPL = (
    "        auth_basic {mark};\n"
    "        auth_basic_user_file {htpasswd};\n"
)


def worker_user(nginx_conf: pathlib.Path) -> str:
    """
    nginx 的 worker 是降权跑的（Debian/Ubuntu 上是 www-data），
    读口令文件的是它不是 root。600 root-only 的话每次请求都是
    500 + error.log 里一行 Permission denied——【不是】401，
    看状态码根本猜不到是权限问题。2026-08-29 自测就撞了这个。
    """
    for line in nginx_conf.read_text().splitlines():
        s = line.strip()
        if s.startswith("user ") and s.endswith(";"):
            return s[5:-1].split()[0]
    return "www-data"


def htpasswd_line(user: str, password: str) -> str:
    """nginx 认 {SHA} 这种。单人自用、文件 600、外面套着 TLS，够了。"""
    digest = base64.b64encode(hashlib.sha1(password.encode()).digest()).decode()
    return f"{user}:{{SHA}}{digest}\n"


# nginx 的块可以写成一行（location /x/ { proxy_pass ...; }），也可以摊开写。
# 早先按行匹配「以 { 结尾的行」，一行式的块整个漏掉——而且当时还报了成功，
# 那比漏掉更糟。所以改成认花括号不认换行。
BLOCK_RE = re.compile(r"(?m)^([ \t]*)(location\b[^{;]*|server)\s*\{")


def _match_brace(text: str, open_idx: int) -> int:
    """text[open_idx] 是 '{'，返回配对的 '}' 的下标；配不上返回 -1。"""
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
    """依次给出 (缩进, 头部文字, 左括号下标, 右括号下标)。"""
    for m in BLOCK_RE.finditer(text):
        head = m.group(2)
        if not head.startswith(kind):
            continue
        open_idx = m.end() - 1
        close = _match_brace(text, open_idx)
        if close < 0:
            continue
        yield m.group(1), head, open_idx, close


def _insert_all(text: str, inserts: list) -> str:
    """inserts = [(下标, 要插的字符串)]，按下标从小到大插。"""
    out, prev = [], 0
    for idx, s in sorted(inserts):
        out.append(text[prev:idx])
        out.append(s)
        prev = idx
    out.append(text[prev:])
    return "".join(out)


def patch_vhost(text: str, auth_lines: str) -> tuple:
    """给每个反代到 8788 的 location 块插上 auth_basic。返回 (新文本, 改了几处)。"""
    inserts = []
    for indent, _head, open_idx, close in _blocks(text, "location"):
        body = text[open_idx + 1 : close]
        if UPSTREAM in body and MARK not in body:
            inserts.append((open_idx + 1, "\n" + auth_lines.rstrip("\n") + "\n" + indent))
    return _insert_all(text, inserts), len(inserts)


def patch_site(text: str, htpasswd: str) -> tuple:
    """
    站点 vhost：加两条同源反代 + 给 SPA 那个 location / 上锁。

    只动【真正提供页面的那个 server 块】——certbot 会额外留一个
    listen 80 只做 301 跳转的块，那个不能碰（碰了会在跳转前先要密码）。
    认 try_files 找它：SPA 的 location / 一定有这行。
    """
    target = None
    for indent, _head, open_idx, close in _blocks(text, "server"):
        if "try_files" in text[open_idx : close]:
            target = (open_idx, close)
            break
    if target is None:
        return text, []

    open_idx, close = target
    block = text[open_idx : close]
    inserts, done = [], []

    if htpasswd not in block:
        # 1) SPA 的 location / 上锁
        for indent, head, o, c in _blocks(text, "location"):
            if not (open_idx < o < close):
                continue
            if head.strip().rstrip("{").strip() == "location /":
                auth = SITE_AUTH_TPL.format(realm=REALM, htpasswd=htpasswd)
                inserts.append((o + 1, "\n" + auth.rstrip("\n") + "\n" + indent))
                done.append("location / 上锁")
                break

    # 2) 插两条同源反代，放在 server_name 那行后面（前缀匹配跟顺序无关）
    if UPSTREAM not in block:
        m = re.search(r"(?m)^[ \t]*server_name\b[^;]*;[ \t]*\n", text[open_idx:close])
        if m:
            blocks = "".join(
                SITE_ONE_LOC_TPL.format(path=q, realm=REALM,
                                        htpasswd=htpasswd, upstream=UPSTREAM)
                for q in ("/api/usage/", "/api/location/")
            )
            inserts.append((open_idx + m.end(), SITE_LOCATIONS_TPL.format(blocks=blocks)))
            done.append("加了 /api/usage/ 和 /api/location/ 两条同源反代")

    return _insert_all(text, inserts), done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vhost", default=VHOST)
    ap.add_argument("--site-vhost", default=SITE_VHOST)
    ap.add_argument("--no-site", action="store_true",
                    help="不动站点，只锁 api.*（足迹页会退回 demo 数据）")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--password", help="不给就随机生成一个，只打印这一次")
    # 下面这几个只为自测搭一套假的 nginx 目录用，正常跑不用给
    ap.add_argument("--map-file", default=MAPFILE)
    ap.add_argument("--htpasswd", default=HTPASSWD)
    ap.add_argument("--nginx-conf", default="/etc/nginx/nginx.conf")
    ap.add_argument("--backup-dir", default=str(BACKUP_DIR))
    ap.add_argument("--nginx-test", default="nginx -t", help="配置检查命令")
    a = ap.parse_args()

    auth_lines = AUTH_LINES_TPL.format(mark=MARK, htpasswd=a.htpasswd)
    backup_dir = pathlib.Path(a.backup_dir)

    vhost = pathlib.Path(a.vhost)
    if not vhost.is_file():
        print(f"× 找不到 {vhost}", file=sys.stderr)
        print("  先 ls -l /etc/nginx/sites-enabled/ 看真名。注意它可能不是符号链接。",
              file=sys.stderr)
        return 1

    text = vhost.read_text()
    if UPSTREAM not in text:
        print(f"× {vhost} 里没有反代到 {UPSTREAM} 的块，改错文件了，已中止", file=sys.stderr)
        print(f"  grep -rn 'api/usage' /etc/nginx/ 看现役的是哪个。", file=sys.stderr)
        return 1

    new_text, n = patch_vhost(text, auth_lines)
    if n == 0 and MARK not in text:
        # 找得到 8788 却一处都没插上 = 匹配逻辑跟这个文件的写法对不上。
        # 这种时候【绝不能】报成功往下走：nginx -t 会过，reload 会成功,
        # 然后接口还是敞着的，而你以为锁上了。2026-08-29 自测就出过这一幕。
        print(f"× {vhost} 里有 {UPSTREAM}，但一个 location 都没匹配上，已中止",
              file=sys.stderr)
        print("  多半是块的写法没见过。把这几行贴给我：", file=sys.stderr)
        print(f"  grep -n -B2 -A6 '{UPSTREAM}' {vhost}", file=sys.stderr)
        return 1
    have_maps = pathlib.Path(a.map_file).is_file()
    have_pw = pathlib.Path(a.htpasswd).is_file()

    site = pathlib.Path(a.site_vhost)
    site_text = site_new = None
    site_done = []
    if not a.no_site:
        if not site.is_file():
            print(f"× 找不到站点 vhost {site}", file=sys.stderr)
            print("  只锁接口不改站点的话，足迹页会静悄悄退回 demo 数据。", file=sys.stderr)
            print("  确认要那样就加 --no-site；否则用 --site-vhost 指对路径。", file=sys.stderr)
            return 1
        site_text = site.read_text()
        site_new, site_done = patch_site(site_text, a.htpasswd)
        if not site_done and a.htpasswd not in site_text:
            print(f"× {site} 里找不到带 try_files 的 server 块（SPA 那个），已中止",
                  file=sys.stderr)
            return 1

    print(f"vhost : {vhost}")
    print(f"  反代到 {UPSTREAM} 的 location：要加锁 {n} 处"
          + ("" if n else "（已经加过了）"))
    print(f"map   : {a.map_file} " + ("（已存在，会覆盖成最新版）" if have_maps else "（新建）"))
    print(f"口令  : {a.htpasswd} " + ("（已存在，保留不动）" if have_pw else "（新建）"))

    if not a.no_site:
        print(f"站点  : {site}")
        for d in site_done:
            print(f"  · {d}")
        if not site_done:
            print("  （已经改过了）")

    if n == 0 and have_maps and have_pw and not site_done:
        print("\n都装好了，没什么要改的。")
        return 0

    if not a.apply:
        print("\n（没落盘）确认就加 --apply。会先备份，nginx -t 不过自动还原。")
        return 0

    # http{} 里得 include conf.d 才轮得到那两张 map
    conf = pathlib.Path(a.nginx_conf).read_text()
    if "conf.d/*.conf" not in conf:
        print(f"× {a.nginx_conf} 里没有 include conf.d/*.conf，"
              "map 放进去也不生效，已中止", file=sys.stderr)
        return 1

    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = backup_dir / f"{vhost.name}.{stamp}"
    shutil.copy2(vhost, bak)
    site_bak = None
    if site_done:
        site_bak = backup_dir / f"{site.name}.{stamp}"
        shutil.copy2(site, site_bak)

    password = None
    if not have_pw:
        password = a.password or secrets.token_urlsafe(12)
        p = pathlib.Path(a.htpasswd)
        p.write_text(htpasswd_line(USER, password))
        # 640 + 属组给 worker：worker 读得到，其他用户读不到
        os.chmod(p, 0o640)
        grp = worker_user(pathlib.Path(a.nginx_conf))
        try:
            shutil.chown(p, group=grp)
        except (LookupError, PermissionError, OSError) as err:
            print(f"！属组没能设成 {grp}（{err}）。", file=sys.stderr)
            print(f"  nginx worker 读不到就是 500 不是 401，手工补："
                  f"chown root:{grp} {p} && chmod 640 {p}", file=sys.stderr)

    pathlib.Path(a.map_file).write_text(MAPS)
    vhost.write_text(new_text)
    if site_done:
        site.write_text(site_new)

    r = subprocess.run(a.nginx_test.split(), capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(bak, vhost)
        if site_bak:
            shutil.copy2(site_bak, site)
        pathlib.Path(a.map_file).unlink(missing_ok=True)
        if password:
            # 这次刚建的口令文件也要删掉。留着的话下次跑会当成「已存在」
            # 跳过生成，密码就再也印不出来了——手里拿着一个谁也不知道的口令。
            pathlib.Path(a.htpasswd).unlink(missing_ok=True)
        print("× nginx -t 没过，两个 vhost 都还原了、map 也删了，现在跟动手前一样。",
              file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        return 1

    print(f"\n  ✓ 改好了，nginx -t 过。备份：{bak}")
    if "conflicting server name" in r.stderr:
        print("  ！nginx -t 里有 conflicting server name —— sites-enabled 里躺着备份文件，"
              "挪去 /root/nginx-backups/")
    if password:
        print("\n" + "=" * 52)
        print(f"  用户名  {USER}")
        print(f"  密码    {password}")
        print("  只打印这一次。存进密码管理器，别贴回聊天里。")
        print("=" * 52)

    print("\n还没生效，要 reload：")
    print("  systemctl reload nginx")
    print("\n然后验（第一条该 401，第二条该 200）：")
    print("  curl -si https://api.nekopurrs.uk/api/usage/latest | head -1")
    print(f"  curl -si -u {USER}:'<密码>' https://api.nekopurrs.uk/api/usage/latest | head -1")
    if site_done:
        print("\n足迹页要看真数据，前端得用【空的】base URL 重新 build 一次：")
        print("  cd /var/www/codeandpurrs && git pull")
        print("  VITE_USAGE_BRIDGE_BASE_URL= npm run build")
        print("  （不 build 的话页面还在打 api.nekopurrs.uk，跨域，会退回 demo 数据）")
    print("\n手机 app 不受影响，下次上报照常。不放心就在 app 里点一下立即上传。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
