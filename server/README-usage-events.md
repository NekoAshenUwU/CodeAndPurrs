# 事件式会话落库（schemaVersion 2）

`patch-usage-bridge-events.py` 改的是**同目录的 `usageBridgeServer.mjs`**，
所以放在这里。跟 `/root/patch_usage_bridge.py` 同一套路：用系统自带
`sqlite3` CLI（`child_process`），不新增任何 npm 依赖，每一步单独判断是否
已生效，可以安全重复运行。

数据契约见 `docs/neko-usage-bridge-spec.md` §4 / §4.1b / §4.1c。

## 这套东西分在三个仓库，规矩是「补丁跟着它改的那个文件走」

| 改的是 | 在哪个仓库 |
|---|---|
| `server/usageBridgeServer.mjs` | **CodeAndPurrs**（就是这里） |
| `/root/server.py` 注册棠予酿的两个工具 | **Veyron-Solace** `tang-yu-niang/` |
| 红米 app 本身 | **neko-usage-bridge** |

## 现役链路（2026-08-23 实地查证）

```
红米 app ──POST /api/usage/ingest──▶ nginx api.nekopurrs.uk
                                       │ location /api/usage/
                                       ▼
                   codeandpurrs-usage-bridge.service  :8788
                   /opt/codeandpurrs/server/usageBridgeServer.mjs
                       │                        │
         server/data/usage/neko/{date}.json  spawnSync('sqlite3')
             （星河沙滩时间线读这个）              ▼
                                        /root/data/dream_events.db
                                        usage_sessions / screen_events
```

判断现役链路只信一个信号：**nginx 把 `/api/usage/` 转给谁**
（`grep -rn "api/usage" /etc/nginx/`）。`8799` **不是** Bridge，那是
`/root/ashen-fishing-mcp/server.py`。

## 装

**顺序不能反：服务端先改，再装新 APK。** 反过来的话新 app 发
`schemaVersion: 2`，旧服务端 `!== 1` 直接 400，**连现在正常的统计一起断**。

```bash
python3 server/patch-usage-bridge-events.py --dry-run
python3 server/patch-usage-bridge-events.py --apply
systemctl restart codeandpurrs-usage-bridge.service
journalctl -u codeandpurrs-usage-bridge.service -n 20 --no-pager
```

默认目标是 `/opt/codeandpurrs/server/usageBridgeServer.mjs`，
`--server` 可以改。会自动备份、跑 `node --check`、锚点对不上就整体中止。

## nginx 那一层也要放宽（补丁管不到）

请求体有【两道】关卡，只放宽一道没用：

| 关卡 | 在哪 | 原值 |
|---|---|---|
| `MAX_BODY_BYTES` | `usageBridgeServer.mjs` | 512 KB（补丁会改成 8 MB） |
| `client_max_body_size` | nginx | `512k` ← **要手工改** |

```bash
ls -l /etc/nginx/sites-enabled/api.nekopurrs.uk   # 先看它是不是符号链接！
F=/etc/nginx/sites-enabled/api.nekopurrs.uk
sed -i 's/client_max_body_size 512k;/client_max_body_size 16m;/' $F
nginx -t && systemctl reload nginx
```

**两个坑，2026-08-23 都踩了：**

1. **`sites-enabled/api.nekopurrs.uk` 不是符号链接，是独立文件。** 跟
   `sites-available` 那份内容已经不一样了。改 `sites-available` 会「改完
   `nginx -t` 通过、reload 成功、然后完全没反应」——因为 nginx 读的是
   `sites-enabled`。动手前先 `ls -l`。

2. **备份文件不能放在 `sites-enabled/` 里面。** nginx 是
   `include sites-enabled/*`，`api.nekopurrs.uk.bak-20260823` 会被当成配置
   一起加载，同一个域名两份 server 块，`nginx -t` 报
   `conflicting server name ... ignored`。现在靠字母序侥幸没坏，但 `.bak`
   里是旧的 `512k`。备份往 `/root/nginx-backups/` 放。

判断有没有中招：`nginx -t` 输出里有没有 `conflicting server name`。

## 为什么会超 512 KB

v2 首次上传要回溯 3 天，会话下限又从 30 秒降到 1 秒（为了抓夜醒）。
实测一次 **3339 段会话 + 262 个屏幕事件 ≈ 610 KB**。旧的快照格式日文件
才 39–70 KB，512 KB 这个数是照那个定的。

## 改了哪五处

0. **`MAX_BODY_BYTES` 512 KB → 8 MB。** 见上。
1. **`schemaVersion !== 1` → 认 1 和 2。** 不改，新 APK 装上去所有上报 400。
2. **事件落库独立于 `app_usage` 那条链路。** 现有 dream_events 同步里有一句
   `apps is empty, skip`，8/23 日志里 00:33 和 02:34 各命中一次。夜里没开
   app 是常态，而那正是睡眠数据唯一有价值的时段。
3. **日文件按会话合并，不整份覆盖。** 采集改成增量游标之后，整份覆盖会让
   星河沙滩时间线当天只剩最后一次同步那一小段（§4.1b）。
4. **补 `spawnSync` 的 import。**
