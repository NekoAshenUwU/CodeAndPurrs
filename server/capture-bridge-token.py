#!/usr/bin/env python3
"""
把 app 正在发的 X-Bridge-Token 取回来，写进 .env，从此真的开始校验。

为什么要取而不是直接换一个新的：token 是编译时烧进 APK 的
（GitHub Secret → local.properties → BuildConfig），换了就得重打包重装。
而 GitHub Secret 写进去读不出来。所以只能从手机发来的请求里拿。

安全说明：这个 token 【没有】泄露过——它一直走 HTTPS。漏的是服务端
`requireBridgeToken` 在 bridgeToken 为空时直接 return true，等于根本没校验。
所以不需要轮换，把现有的填进去就行。

怎么跑（整个过程 token 不上屏，只打印长度）：

    systemctl stop codeandpurrs-usage-bridge
    python3 capture-bridge-token.py            # 占住 8788 等一次上报
    # ← 这时在手机上点「立即上传一次」
    systemctl start codeandpurrs-usage-bridge

收到之后故意回 503：app 会当成失败、不推进游标，那一批数据下次重发，
一条都不会丢。回 201 的话游标推进了，这一批就永远没了。
"""

import http.server
import os
import pathlib
import re
import sys

ENV = pathlib.Path("/opt/codeandpurrs/.env")
HOST, PORT = "127.0.0.1", 8788
KEY = "USAGE_BRIDGE_TOKEN"

captured = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        tok = self.headers.get("X-Bridge-Token") or ""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)          # 收完再回，免得对面看到连接中断
        # 故意失败：让 app 保住游标，这批数据下次重发
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":false,"error":"capturing token, retry later"}')
        if tok:
            captured["token"] = tok

    def log_message(self, *a):               # 别把请求行打出来
        pass


def write_env(token: str) -> None:
    text = ENV.read_text() if ENV.exists() else ""
    line = f"{KEY}={token}"
    if re.search(rf"^{KEY}=.*$", text, flags=re.M):
        text = re.sub(rf"^{KEY}=.*$", line, text, count=1, flags=re.M)
    else:
        text = text.rstrip("\n") + "\n" + line + "\n"
    tmp = ENV.with_suffix(".env.tmp")
    tmp.write_text(text)
    os.chmod(tmp, 0o600)                     # 先设权限再改名，中间没有可读窗口
    tmp.replace(ENV)


def main() -> int:
    if not ENV.exists():
        print(f"× 找不到 {ENV}", file=sys.stderr)
        return 1

    srv = http.server.HTTPServer((HOST, PORT), Handler)
    print(f"在 {HOST}:{PORT} 等一次上报……现在去手机上点「立即上传一次」")
    print("（收到就自动退出。Ctrl-C 可以放弃）")
    try:
        while "token" not in captured:
            srv.handle_request()
    except KeyboardInterrupt:
        print("\n放弃了，.env 没动")
        return 1
    finally:
        srv.server_close()

    tok = captured["token"]
    write_env(tok)
    # 只报长度和首尾各一位，够你核对是不是同一个，又看不出内容
    print(f"\n  ✓ 收到了：长度 {len(tok)}，{tok[:1]}…{tok[-1:]}")
    print(f"  ✓ 已写进 {ENV}（权限 600）")
    print("\n下一步：")
    print("  systemctl start codeandpurrs-usage-bridge")
    print("  # 手机再点一次「立即上传一次」，看日志确认是 201 不是 401")
    return 0


if __name__ == "__main__":
    sys.exit(main())
