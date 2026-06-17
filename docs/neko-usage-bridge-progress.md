# Neko Usage Bridge / 猫爪足迹进度记录

更新时间：2026-06-17

## 目标范围

「猫爪足迹」只需要读取机主手机里的 App 使用记录，并把这些数据接到现有前端视觉结构上。

当前确认的范围：

- Android 端读取 UsageStats 使用记录。
- Android 端上传 usage payload 到 VPS。
- VPS 后端保存最近 usage 数据，并提供读取接口。
- 前端 `Paw Trail` 页面读取后端数据，填入现有视觉结构。

明确不需要：

- 不需要读取聊天、短信、相册或输入内容。
- 不需要把 usage bridge 强行塞进主聊天 proxy。
- 不需要额外做 unrelated API 集成。

## 当前已完成

### Android 端

- 已创建独立 Android 项目 `NekoAshenUwU/neko-usage-bridge`。
- APK 已能安装到 RedMi。
- 通过降低 `targetSdk` 后，RedMi 可以开启「使用情况访问」。
- App 已能列出今日 Top Apps、包名、使用时长、最后使用时间和分类。
- 已修正早期 `queryUsageStats` 可能把跨日/旧缓存算进「今天」的问题，改为更靠近事件会话的统计逻辑。

### CodeAndPurrs 前端/后端代码

- 前端视觉方向已明确：保持现有「猫爪足迹 / Paw Trail」视觉结构，只把数据源接到 usage bridge。
- 后端设计为独立 Usage Bridge 服务，默认监听 `127.0.0.1:8788`。
- 目标接口：
  - `POST /api/usage/ingest`：Android 上传。
  - `POST /api/usage/ping`：Android 测试连接。
  - `GET /api/usage/latest?owner=neko`：前端读取最新一天。
  - `GET /api/usage/day?owner=neko&date=YYYY-MM-DD`：前端读取指定日期。
  - `GET /api/usage/trend?owner=neko&days=7`：前端读取趋势。

## 当前卡点

### GitHub PR 状态

GitHub 上已有 PR：

```text
Add Neko Usage Bridge backend, smoke/verify scripts, tests and Paw Trail frontend
```

但该 PR 目前有冲突，GitHub 显示冲突文件：

```text
docs/neko-usage-bridge-spec.md
```

由于冲突未解决，PR 还没有合并进 `main`。

### VPS 状态

VPS 路径：

```text
/root/CodeAndPurrs
```

VPS 当前在 `main` 分支，但 `main` 还没有完整 usage bridge 文件。排查过程中见到过：

```text
ls: cannot access 'server/usageBridge.mjs': No such file or directory
```

后续尝试本地 merge PR 分支后，`server/usageBridgeServer.mjs` 曾出现，但 `server/usageBridge.mjs` 仍缺失，导致 `npm run bridge:start` 无法真正启动独立 bridge。

### systemd 状态

已创建 systemd unit：

```text
/etc/systemd/system/usage-bridge.service
```

目标配置：

```ini
WorkingDirectory=/root/CodeAndPurrs
ExecStart=/usr/bin/npm run bridge:start
Environment=HOST=127.0.0.1
Environment=BRIDGE_PORT=8788
EnvironmentFile=-/root/CodeAndPurrs/.env
```

当前失败原因不是 nginx，而是本机 `127.0.0.1:8788` 服务没有起来。

排查中过去出现过两类失败：

1. `bridge:start` 指向了 `server/proxy.mjs`，导致尝试监听 `127.0.0.1:8787`，与现有聊天后端冲突。
2. 修正 `bridge:start` 后，`server/usageBridge.mjs` 缺失，导致独立 bridge 仍无法启动。

## 下一步建议

### 1. 先处理 GitHub PR 冲突

优先处理 PR 中唯一冲突文件：

```text
docs/neko-usage-bridge-spec.md
```

冲突解决后，将 PR 合并到 `main`。

### 2. VPS 拉取合并后的 main

PR 合并后，在 VPS 执行：

```bash
cd /root/CodeAndPurrs
git checkout main
git pull --ff-only
ls -la server/usageBridge.mjs server/usageBridgeServer.mjs
npm run | grep bridge
```

必须确认同时存在：

```text
server/usageBridge.mjs
server/usageBridgeServer.mjs
bridge:start
```

### 3. 重启 usage bridge

确认文件存在后执行：

```bash
systemctl daemon-reload
systemctl reset-failed usage-bridge
systemctl restart usage-bridge
sleep 2
systemctl status usage-bridge --no-pager -l
curl -i --max-time 10 http://127.0.0.1:8788/api/usage/health
```

本地成功标志：

```text
HTTP/1.1 200 OK
```

### 4. 再处理公网 nginx / SSL

只有本地 `127.0.0.1:8788` 通了以后，才继续处理：

- `https://api.nekopurrs.uk/api/usage/health`
- nginx `/api/usage/` 反代到 `127.0.0.1:8788`
- `api.nekopurrs.uk` 证书 SAN 不匹配问题

## 暂停点

当前建议先暂停 VPS 继续排错，避免反复修改临时文件导致状态更乱。

恢复时从这三个检查开始：

```bash
cd /root/CodeAndPurrs
git status --short
ls -la server/usageBridge.mjs server/usageBridgeServer.mjs
npm run | grep bridge
```

## Codex 提交备注

本记录用于在重新开始前快速恢复上下文：先确认 GitHub PR 冲突和 VPS 文件完整性，再继续处理 systemd、nginx 与 SSL。若 Codex 菜单消失，可重新从本提交创建 PR。
