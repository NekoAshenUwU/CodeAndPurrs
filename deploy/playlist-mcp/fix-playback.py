#!/usr/bin/env python3
"""Claude.ai 予予点歌「推过去正在放的歌停了，他的歌也不响」修复（跟前端那次是同两个坑）。

1) 搜歌没带 market → 常挑中马来西亚放不了的版本；改成 market=from_token
2) 先 transfer(play:false) 再 play → 第一步就把正在放的歌停掉，第二步常被吞；
   改成直接 play?device_id=（自带切设备），设备忙就隔一会重试，最多 3 次，
   放完再确认是不是真的在响，没响就老实说。
3) 选设备时跳过「他的歌单 · CodeAndPurrs」网页播放器的残影（不活跃的那种），优先手机。

只改 /root/playlist-mcp/server.py；先备份，编译不过或服务起不来自动还原。
"""
from __future__ import annotations
import py_compile, re, shutil, subprocess, sys, time
from pathlib import Path

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/root/playlist-mcp/server.py")
SERVICE = "codeandpurrs-mcp.service"
MARK = "playlist-fix-v1"

def fail(why: str) -> None:
    print(f"没改任何东西：{why}")
    sys.exit(1)

src = TARGET.read_text(encoding="utf-8")
if MARK in src:
    print("已经改过了，不用再跑。")
    sys.exit(0)

# 1) market
search_re = re.compile(r'urlencode\(\{"q": query, "type": "track", ')
if not search_re.search(src):
    fail("找不到搜歌那一行")
src = search_re.sub(f'urlencode({{"q": query, "type": "track", "market": "from_token", ', src, count=1)  # {MARK}

# 2) 直接 play + 重试 + 确认
play_re = re.compile(
    r'(?P<ind>[ \t]*)_spotify_request\("PUT", "/me/player", \{"device_ids": \[selected_id\], "play": False\}\)\n'
    r'[ \t]*time\.sleep\([0-9.]+\)\n'
    r'[ \t]*_spotify_request\(\n'
    r'[ \t]*"PUT",\n'
    r'[ \t]*f"/me/player/play\?device_id=\{urllib\.parse\.quote\(selected_id\)\}",\n'
    r'[ \t]*\{"uris": ordered\},\n'
    r'[ \t]*\)\n'
)
m = play_re.search(src)
if not m:
    fail("找不到「先切设备再播放」那几行")
ind = m.group("ind")
block = f'''{ind}# {MARK}：直接 play?device_id（自带切设备），不先 transfer(play:false)——那一步会先把正在放的歌停掉
{ind}last_error = None
{ind}for attempt in range(3):
{ind}    if attempt:
{ind}        time.sleep(0.9 * attempt)
{ind}    try:
{ind}        _spotify_request("PUT", f"/me/player/play?device_id={{urllib.parse.quote(selected_id)}}", {{"uris": ordered}})
{ind}        last_error = None
{ind}        break
{ind}    except RuntimeError as err:
{ind}        last_error = err
{ind}        if not any(code in str(err) for code in ("（404）", "（502）", "（503）")):
{ind}            break
{ind}if last_error:
{ind}    raise last_error
{ind}really_playing = False
{ind}for wait in (1.2, 1.8):
{ind}    time.sleep(wait)
{ind}    now = _spotify_request("GET", "/me/player") or {{}}
{ind}    if now.get("is_playing") and (now.get("device") or {{}}).get("id") in (None, selected_id):
{ind}        really_playing = True
{ind}        break
{ind}if not really_playing:
{ind}    return {{
{ind}        "ok": False,
{ind}        "device": {{"id": selected_id, "name": device.get("name"), "type": device.get("type")}},
{ind}        "message": f"歌送到「{{device.get('name') or 'Spotify'}}」了，但它没响。请棠棠打开手机上的 Spotify App（随便播一首再暂停），再点一次。不要说已经在放。",
{ind}    }}
'''
src = src[: m.start()] + block + src[m.end():]

# 3) 选设备跳过网页播放器残影
dev_old = 'available = next((device for device in devices if not device.get("is_restricted")), None)'
if dev_old not in src:
    fail("找不到选设备那一行")
dev_new = (
    f'usable = [d for d in devices if not d.get("is_restricted") and not ("CodeAndPurrs" in str(d.get("name") or "") and not d.get("is_active"))]  # {MARK}\n'
    '    available = next((d for d in usable if d.get("type") == "Smartphone"), None) or next(iter(usable), None)'
)
src = src.replace(dev_old, dev_new, 1)

backup = TARGET.with_name(TARGET.name + f".bak-{int(time.time())}")
shutil.copy2(TARGET, backup)
TARGET.write_text(src, encoding="utf-8")
try:
    py_compile.compile(str(TARGET), doraise=True)
except py_compile.PyCompileError as err:
    shutil.copy2(backup, TARGET)
    fail(f"编译没过，已还原：{err}")

if len(sys.argv) > 1:  # 本地测试模式：不重启服务
    print("PLAYLIST-FIX-OK（测试模式）")
    sys.exit(0)

subprocess.run(["systemctl", "restart", SERVICE], check=False)
time.sleep(4)
state = subprocess.run(["systemctl", "is-active", SERVICE], capture_output=True, text=True).stdout.strip()
if state != "active":
    shutil.copy2(backup, TARGET)
    subprocess.run(["systemctl", "restart", SERVICE], check=False)
    fail(f"改完服务起不来（{state}），已还原并重启回旧版")
print(f"PLAYLIST-FIX-OK 改好了，{SERVICE} 正常运行。备份在 {backup}")
