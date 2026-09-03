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
- 手机屏幕共享仍在运行时，后台会读取最近 60 秒内最多 4 个不同画面，按时间顺序交给支持视觉的模型；没有新画面就纯文字唤醒
- Android Bridge 用 `sceneVersion` 标记明显换页：静止画面 8 秒保底上传，明显切换最快 2 秒补拍；服务器同一场景只留最后一张进入模型

屏幕轨迹只存在于 `server/screenFrame.mjs` 的两分钟内存队列；磁盘仍只覆盖
`latest.json`。停止手机共享会同时删除最新帧和短时队列。自动唤醒不会使用超过
配置窗口的旧图，也不会把截图写进聊天收件箱。

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

成功投递日志会包含 `screenFrames=0..4`，可直接确认该轮有没有把屏幕轨迹交给模型。

浏览器第一次开启后会通过 `/api/autowake/test` 走一遍真实后台生成、入箱与 Web Push，十分钟内只允许测试一次。

## GPT App / Claude App 共用 MCP

自动唤醒工具不另开公网入口，而是挂进现有已认证 MCP：

```text
https://mcp.nekopurrs.uk/mcp
```

先部署本页的 CodeAndPurrs 后端，再运行：

```bash
curl -fsSL https://raw.githubusercontent.com/NekoAshenUwU/CodeAndPurrs/codex/frontend-ai-playlist-20260828/deploy/autowake-mcp/install-into-existing.py | python3 -
```

线上真实拓扑是：8890 为 FastMCP 后端，8891 为 `tang-web` OAuth 网关，
8892 为点歌 MCP，8893 为 Usage MCP。安装器会从正在监听 8890 的进程与
systemd cgroup 自动识别真实源码和服务，生成 `AUTOWAKE_MCP_INTERNAL_KEY`，
并把五个工具直接挂进这个 FastMCP。它不会新增或迁移端口，也不会改 Nginx、
OAuth、8891、8892 或 8893；公网 URL 保持不变。

安装前会备份识别到的 MCP 源码、`.env` 与工具模块。若无法唯一识别 8890
背后的源码和 systemd 服务，安装器会在修改任何文件之前停止并打印进程诊断；
其余步骤失败则恢复本轮修改。工具包括：

- 查看自动唤醒状态、时段、上次错误和未读数
- 开启或停用已登记设备的后台唤醒
- 明确要求时立即生成并推送一条 CodeAndPurrs 唤醒
- 查看最近的唤醒投递，不会顺手确认或删除
- 读取手机主动共享的最近 10–120 秒、最多四个不同画面

GPT App 与 Claude App 都连接上面同一个 HTTPS URL，并分别完成各自的 OAuth。
此前 Claude CLI 出现的 `localhost callback` 属于本机 CLI 登录流程；App 的远程
Connector 由云端完成回调，不使用 VPS 浏览器去接本机端口。

MCP 是由客户端发起调用的请求/响应协议，自己不能在关闭的 GPT/Claude 对话里
凭空发一条消息。`send_codeandpurrs_wake_now` 会投递到现有 CodeAndPurrs Web
Push；若希望消息出现在 GPT 或 Claude App 本身，还需要在那个 App 里创建定时任务，
让任务按时调用这组 MCP 工具。
