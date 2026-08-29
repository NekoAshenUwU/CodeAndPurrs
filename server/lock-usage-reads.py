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
UPSTREAM = "127.0.0.1:8788"
USER = "neko"

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


def patch_vhost(text: str, auth_lines: str) -> tuple[str, int]:
    """给每个反代到 8788 的 location 块插上 auth_basic。返回 (新文本, 改了几处)。"""
    lines = text.splitlines(keepends=True)
    out, n = [], 0
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.match(r"\s*location\b[^{]*\{\s*$", line)
        if not m:
            i += 1
            continue

        # 找到这个块的范围（数花括号）
        depth, j = 1, i + 1
        while j < len(lines) and depth:
            depth += lines[j].count("{") - lines[j].count("}")
            j += 1
        block = "".join(lines[i + 1 : j])

        if UPSTREAM in block and MARK not in block:
            out.append(auth_lines)
            n += 1
        i += 1
    return "".join(out), n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vhost", default=VHOST)
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
    have_maps = pathlib.Path(a.map_file).is_file()
    have_pw = pathlib.Path(a.htpasswd).is_file()

    print(f"vhost : {vhost}")
    print(f"  反代到 {UPSTREAM} 的 location：要加锁 {n} 处"
          + ("" if n else "（已经加过了）"))
    print(f"map   : {a.map_file} " + ("（已存在，会覆盖成最新版）" if have_maps else "（新建）"))
    print(f"口令  : {a.htpasswd} " + ("（已存在，保留不动）" if have_pw else "（新建）"))

    if n == 0 and have_maps and have_pw:
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

    r = subprocess.run(a.nginx_test.split(), capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(bak, vhost)
        pathlib.Path(a.map_file).unlink(missing_ok=True)
        if password:
            # 这次刚建的口令文件也要删掉。留着的话下次跑会当成「已存在」
            # 跳过生成，密码就再也印不出来了——手里拿着一个谁也不知道的口令。
            pathlib.Path(a.htpasswd).unlink(missing_ok=True)
        print("× nginx -t 没过，已经把 vhost 还原、map 删掉了，现在跟动手前一样。",
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
    print("\n手机 app 不受影响，下次上报照常。不放心就在 app 里点一下立即上传。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
