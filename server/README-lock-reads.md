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

## 装

```bash
python3 server/lock-usage-reads.py            # 只看会改什么
python3 server/lock-usage-reads.py --apply    # 会先备份；nginx -t 不过自动还原
systemctl reload nginx                        # 这一步之前都没生效
```

密码是随机生成的，**只在 `--apply` 那次打印一次**，存进密码管理器。
（想自己定就 `--password '...'`。）

验：

```bash
curl -si https://api.nekopurrs.uk/api/usage/latest | head -1              # 该 401
curl -si -u neko:'<密码>' https://api.nekopurrs.uk/api/usage/latest | head -1  # 该 200
```

手机 app 不受影响。不放心就在 app 里点一下「立即上传」。

## 两个坑

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

## 猫爪足迹那个网页会怎样

会**看不到真数据，退回 demo 示例数据**——不会白屏、不会报错，
但也不会告诉你它退了。

原因：网页在 `nekopurrs.uk`，接口在 `api.nekopurrs.uk`，是跨域。
`fetch` 默认不带凭据；就算加了 `credentials: 'include'`，跨域的 401
挑战在 fetch 里**不会弹浏览器密码框**，只会静悄悄失败。

要让页面继续看到真数据，正路是**把读接口挪到同源**，不是把锁拆了：

1. `nekopurrs.uk` 的 vhost 里加一段 `location /api/usage/` 反代到 `8788`
2. 给 `nekopurrs.uk` 也套上 `auth_basic`（跟 `tang` 那个 vhost 一个套路）
3. 前端用 `VITE_USAGE_BRIDGE_BASE_URL=` （**留空**）重新 build

同源之后 `fetch` 自动带凭据，浏览器正常弹一次密码框，页面和接口
共用同一把锁。这一步没做，所以先只锁 API——**数据不再对公网敞着**，
代价是那个页面暂时只有示例数据。要做第 3 步再说，别忘了它得重新 build。
