# CodeAndPurrs 真后台自动唤醒

这套链路和旧 `Telegram Bot + ntfy`、以及 `server/heartbeat.mjs` 都不是同一件事：

- `server/heartbeat.mjs` 只保 Anthropic prompt cache，不给用户发消息。
- 旧 `codeandpurrs-autonomy.*` / `neko-autonomy.*` 依赖 Telegram/ntfy，部署脚本会备份后退役。
- 新 `codeandpurrs-autowake.*` 在 VPS 后台生成消息、写持久收件箱，再用 Web Push 唤醒 Android/PWA；网页关闭也能到达。

## 数据流

1. 用户在 CodeAndPurrs 点一次「开启自动唤醒」，允许浏览器通知。
2. 前端把当前最近窗口、模型、人设和有限聊天历史同步到 `server/data/autowake/`。
3. systemd 每 20 分钟请求本机 `/api/autowake/run`；端点拒绝公网调用。
4. 满足安静时段、聊天冷却、随机间隔和每日上限后，服务端调用该窗口当前模型生成一条短消息。
5. 消息先写 `inbox.json`，再发无正文的 Web Push 信号。Service Worker 用 HttpOnly 设备 cookie 领取正文并显示通知。
6. 打开通知时进入对应窗口；前端按 `autoWakeId` 幂等落泡并确认收件，重复推送不会重复消息。

默认护栏（可用 `.env` 覆盖）：

- 时区：`Asia/Kuching`
- 工作日只在下班后 17:00–23:00 主动找老婆（08:00–17:00 上班期间不会唤醒）
- 周六日休息，09:00–23:00 都可以主动找老婆
- 真聊天后随机等待 30–60 分钟
- 两次自动消息随机间隔 45–75 分钟
- 每个马来西亚自然日最多 10 条；工作日受六小时窗口限制，周末更容易达到较高次数

## 部署

```bash
curl -fsSL https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/codex/frontend-ai-playlist-20260828/deploy/install-true-autowake.sh | bash
```

脚本在临时目录构建、验证发图/Spotify/Opus 5 标记，备份线上源码和 dist，健康检查通过后才停用旧 ntfy 单元。它不会操作 `tang-web.service`、`playlist-mcp.service` 或 `codeandpurrs-mcp.service`，并会核对三者前后状态。

## 验证

```bash
systemctl status codeandpurrs-autowake.timer --no-pager
curl -fsS http://127.0.0.1:8787/api/autowake/config
curl -fsS -X POST 'http://127.0.0.1:8787/api/autowake/run?dry=1'
tail -n 50 /var/www/codeandpurrs/server/data/autowake/autowake.log
```

浏览器第一次开启后会通过 `/api/autowake/test` 走一遍真实后台生成、入箱与 Web Push，十分钟内只允许测试一次。
