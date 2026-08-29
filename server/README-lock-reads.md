# 给 bridge 的读接口上锁

## 在补什么洞

`X-Bridge-Token` 从来只挡 POST。这几条一直是裸的，谁知道域名谁就能看：

| 路径 | 泄的是什么 |
|---|---|
| `GET /api/usage/latest` | 今天每个 app 用了多久、解锁几次、首次末次使用 |
| `GET /api/usage/day?date=` | 任意一天的同上 |
| `GET /api/usage/trend` | 连续多天的曲线 |
| `GET /api/usage/health` | 服务状态 + `tokenConfigured` |
| `GET /api/location/latest` | 最后一次位置 |
| `POST /api/usage/prune`、`DELETE /api/usage/day`、`DELETE /api/usage/owner` | **删数据** |

访问日志里目前只有棠棠自己的 IP，没被人翻过。但「没人翻」不是「翻不了」。

## 怎么做的

在 nginx 上做，不改 Node：app 不用重装，bridge 不用重启，上报不断线，
回退就是把备份拷回去 reload。

两张 `map` + 每个反代块两行 `auth_basic`。`auth_basic` 的值可以是变量，
值为 `off` 就是这条不查——所以同一个 `location` 里能按「方法 + 路径」
分开处理，不用把 location 拆成一堆。

免密的只有这四类，**方法和路径一起钉死**（`GET /api/usage/ingest` 也进不来）：

```
POST /api/usage/ingest        ← 红米 app 上报
POST /api/usage/ping          ← 连通测试
POST /api/location/ingest
OPTIONS *                     ← CORS 预检
```

其余一律 basic auth。

## 两个 vhost 一起改

只改一个必然留下坏状态：

| 只做这个 | 结果 |
|---|---|
| 只锁 `api.*` | 足迹页跨域拿不到数据，**静悄悄退回 demo**，不报错不白屏 |
| 只改站点 | 数据还在公网上敞着 |

所以脚本一趟改两个，`nginx -t` 不过就两个一起还原。

站点这边做的是：`nekopurrs.uk` 加两条 `/api/usage/`、`/api/location/`
反代到 `8788`（**同源**），跟 `location /` 一起套 `auth_basic`，
**用同一个 realm**——浏览器才会把输过的密码自动带给同源的
`/api/usage/*`，否则页面弹一次、`fetch` 再被挡一次。

`location /api/` → `8787`（聊天后端 SSE）**不动**：nginx 前缀匹配取最长的，
新加的两条更具体，聊天照旧走 8787 且不要密码。

certbot 留下的那个只做 301 跳转的 `server` 块也不动（在跳转前要密码是荒唐的）。
认 `try_files` 找真正提供页面的那个块。

## 装

```bash
python3 server/lock-usage-reads.py            # 只看会改什么
python3 server/lock-usage-reads.py --apply    # 会先备份；nginx -t 不过两个都还原
systemctl reload nginx                        # 这一步之前都没生效

# 前端必须用【空的】base URL 重 build，否则页面还在打 api.nekopurrs.uk（跨域）
cd /var/www/codeandpurrs && git pull
VITE_USAGE_BRIDGE_BASE_URL= npm run build
```

只想锁接口、不动站点：加 `--no-site`（清楚代价再用）。

密码是随机生成的，**只在 `--apply` 那次打印一次**，存进密码管理器。
（想自己定就 `--password '...'`。）

验：

```bash
curl -si https://api.nekopurrs.uk/api/usage/latest | head -1              # 该 401
curl -si -u neko:'<密码>' https://api.nekopurrs.uk/api/usage/latest | head -1  # 该 200
```

手机 app 不受影响。不放心就在 app 里点一下「立即上传」。

## 三个坑

0. **一行式的 `location`。** nginx 允许
   `location /x/ { proxy_pass ...; }` 全写一行。早先按行匹配「以 `{`
   结尾的行」，这种块整个漏掉——**而且当时还报了成功**：`nginx -t` 过、
   `reload` 成功、接口还是敞着的，你以为锁上了。比漏掉更糟。
   现在改成认花括号不认换行，另外加了一道闸：文件里有 `8788`
   却一个 location 都没匹配上就整体中止，绝不往下走。

1. **口令文件的属主。** nginx 的 worker 是降权跑的（`www-data`），读口令
   文件的是它不是 root。`chmod 600` root-only 的话每个请求都是
   **500**，不是 401——看状态码根本猜不到是权限问题，得去翻 `error.log`
   才见到一行 `Permission denied`。脚本写成 `640` + 属组 `www-data`
   （属组从 `nginx.conf` 的 `user` 指令读，不是写死的）。
   2026-08-29 自测就撞了这个，所以才有这一段。

2. **`sites-enabled/api.nekopurrs.uk` 不是符号链接，是独立文件**，跟
   `sites-available` 那份内容已经不一样了。脚本默认就是改
   `sites-enabled` 那个。备份一律去 `/root/nginx-backups/`，
   **不能留在 `sites-enabled/` 里**（nginx 是 `include sites-enabled/*`，
   备份会被当配置加载，`conflicting server name`）。

## 为什么非得挪到同源

跨域的 401 挑战在 `fetch` 里**不会弹浏览器密码框**，只会静悄悄失败——
就算前端加了 `credentials: 'include'` 也一样。所以「锁上 api.* 但页面
照旧打 api.*」这条路走不通，页面只会一直吃 demo 数据。

同源之后 `fetch` 默认就带凭据（`credentials` 默认值是 `same-origin`），
浏览器正常弹一次密码框，页面和读接口共用同一把锁。

## 还没管的

`nekopurrs.uk` 的 `location /api/` → `8787`（聊天后端）仍然不要密码，
跟这次改动之前一样。这次动的只是足迹数据那条线。

## 验过什么

拿真 nginx 1.24 起了一套两个 vhost 的环境，18 条全过：

- api.*：五种裸读全 401、密码错 401、带密码 200、三条 app 上报路径裸的 200、
  `GET /api/usage/ingest` 401（方法钉死）、OPTIONS 200
- 站点：裸开首页 401、带密码 200、同源 `/api/usage/latest` 裸 401 带密码 200
  且**确认转给的是 8788 不是 8787**、`/api/chat` 照旧裸的 200 走 8787、
  301 跳转块没被加锁
- 重复跑幂等、配置坏掉两个 vhost 一起还原、匹配不上时中止而不是假报成功
