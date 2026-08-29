#!/usr/bin/env python3
"""
把 nekopurrs.uk 的登录密码设对，然后当场验证。

不猜路径：从 nginx 配置里找出【服务 nekopurrs.uk 的那个 server 块】
真正在读哪个口令文件，写那个。写完用 curl 打一次真站点，
看它是不是真的放你进去了。
"""
import base64, getpass, glob, hashlib, os, re, shutil, ssl, sys, urllib.request

USER = os.environ.get("WEB_USER", "nekolau")
SITES = os.environ.get("SITES_DIR", "/etc/nginx/sites-enabled")
VERIFY_URL = os.environ.get("VERIFY_URL", "https://nekopurrs.uk/")


def blocks(text):
    for m in re.finditer(r"(?m)^[ \t]*server\s*\{", text):
        depth, i = 0, m.end() - 1
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    yield text[m.start():i]
                    break
            i += 1


def main():
    found = {}          # 口令文件 -> [是哪个 vhost 文件]
    for path in sorted(glob.glob(os.path.join(SITES, "*"))):
        if not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for blk in blocks(text):
            names = re.search(r"\bserver_name\s+([^;]+);", blk)
            if not names:
                continue
            hosts = names.group(1).split()
            # 要的是站点本身，不是 api. 那个子域
            if "nekopurrs.uk" not in hosts and "www.nekopurrs.uk" not in hosts:
                continue
            for f in re.findall(r"\bauth_basic_user_file\s+([^;]+);", blk):
                found.setdefault(f.strip(), []).append(os.path.basename(path))

    print("nekopurrs.uk 这个站在读的口令文件：")
    if not found:
        print("  一个都没有——说明这个站根本没配 auth_basic。")
        print("  那弹密码框的就不是它。把这个贴出来：")
        print("    grep -rn 'auth_basic' /etc/nginx/")
        return 1
    for f, who in found.items():
        exists = "在" if os.path.isfile(f) else "【不存在】"
        users = ""
        if os.path.isfile(f):
            users = "，里面的用户名: " + ", ".join(
                l.split(":")[0] for l in open(f).read().splitlines() if ":" in l)
        print(f"  {f}   ({exists}，来自 {', '.join(who)}{users})")

    pw = getpass.getpass(f"\n给 {USER} 设个密码（不回显）: ")
    if not pw:
        print("空密码，没动任何东西。", file=sys.stderr)
        return 1

    line = USER + ":{SHA}" + base64.b64encode(hashlib.sha1(pw.encode()).digest()).decode() + "\n"
    for f in found:
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, "w") as fh:
            fh.write(line)
        os.chmod(f, 0o640)
        try:
            shutil.chown(f, group="www-data")
        except Exception as err:
            print(f"！{f} 属组没设成 www-data（{err}）——worker 读不到会返回 500", file=sys.stderr)
        print(f"  ✓ 写好 {f}")

    # 当场验：拿真站点打一次
    print(f"\n验证中（直接打 {VERIFY_URL} ）…")
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, VERIFY_URL, USER, pw)
    opener = urllib.request.build_opener(
        urllib.request.HTTPBasicAuthHandler(mgr),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(VERIFY_URL, timeout=15) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:
        print(f"  连不上（{e}）——这不是密码的事，是网络或 TLS。")
        return 1

    if code == 200:
        print(f"  ✓ HTTP {code} —— 密码是对的，服务器认了。")
        print(f"\n用户名 {USER}，密码就是你刚敲的那个。")
        print("浏览器还进不去的话就是它在用记住的旧密码：")
        print("  Chrome 里长按 nekopurrs.uk 的书签/历史 → 或者用无痕窗口开一次试试。")
    elif code == 401:
        print(f"  ✗ HTTP {code} —— 服务器不认。口令文件写对了但没生效，")
        print("     多半是还有别的地方也在管这个站。把这个贴出来：")
        print("       grep -rn 'auth_basic' /etc/nginx/")
    elif code == 500:
        print(f"  ✗ HTTP {code} —— 这不是密码错，是 nginx 的 worker 读不到口令文件。")
        print("     跑：chown root:www-data " + " ".join(found) + " && chmod 640 " + " ".join(found))
    else:
        print(f"  ? HTTP {code} —— 没料到这个码，把这行贴给我。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
