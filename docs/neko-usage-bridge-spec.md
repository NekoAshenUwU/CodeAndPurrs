# Neko Usage Bridge｜红米桥接规格

这份文档是 CodeAndPurrs「猫爪足迹｜Paw Trail」和红米手机桥接 App 的开工规格。

## 1. 基础部署信息

- 用户所在地：马来西亚亚庇（Kota Kinabalu, Malaysia），不是中国大陆。
- 设备时间口径：马来西亚时间 UTC+8；Android 端优先读取系统时区，亚庇/沙巴可按 `Asia/Kuching` 处理。
- 主域名：`nekopurrs.uk`。
- VPS：DigitalOcean 新加坡 VPS。
- DNS / CDN / TLS：Cloudflare。
- 当前已使用子域：
  - `tang.nekopurrs.uk`：棠予酿前端。
  - `mcp.nekopurrs.uk`：MCP 服务。
- CodeAndPurrs 后续部署时再单独确认正式前端子域。
- 红米桥接专用推送域名：`bridge.codeandpurrs.com`。

## 2. 架构原则

红米桥接 v1 采用「手机主动推送到 VPS，网页从 VPS 读取」的单向同步架构。

```text
红米 Neko Usage Bridge
  └── 定时 HTTPS POST
        └── bridge.codeandpurrs.com /api/usage/ingest
              └── CodeAndPurrs Paw Trail GET 读取
```

不采用网页直接拉手机本地服务的方案，避免后台保活、混合内容、CORS、局域网 IP 变化、跨网络不可达等问题。

## 3. 隐私与边界

- 只做机主主动授权、主动上传、可关闭、可删除的数据同步。
- 不做偷偷定位。
- 不做隐藏监控。
- 不监控别人。
- API token 只保存在 Android 端安全配置和 VPS 环境变量中，不写入前端仓库。

## 4. Android 桥接 App 要点

Codex 侧实现红米 / MIUI / HyperOS 友好的 Neko Usage Bridge：

1. 使用 Android `UsageStatsManager` 读取 App 前台使用时长。
2. 使用 `queryUsageStats` 或 `queryAndAggregateUsageStats` 汇总每个 App 的使用数据。
3. 使用 `queryEvents` 统计解锁次数、小时分布和当天会话。
4. 引导用户开启 `PACKAGE_USAGE_STATS` 使用情况访问权限。
5. 引导红米系统设置：
   - 自启动。
   - 省电策略设为无限制。
   - 最近任务锁定 App。
6. 使用 WorkManager 定时上传，不依赖裸前台服务常驻。
7. 上传失败要重试，并保留本地离线兜底。
8. UI 至少包含：
   - 当前连接状态。
   - 今日采集总时长。
   - 上次成功上传时间。
   - 去开权限按钮。
   - 去设自启动 / 无限省电按钮。
   - 立即上传按钮。
   - 测试连接按钮。

## 5. 数据契约 v1

`schemaVersion` 当前固定为 `1`。两端如需改字段，必须同步升级版本号。

### 5.1 连通测试

```http
POST https://bridge.codeandpurrs.com/api/usage/ping
Content-Type: application/json
X-Bridge-Token: <共享密钥>
```

### 5.2 上传今日使用数据

```http
POST https://bridge.codeandpurrs.com/api/usage/ingest
Content-Type: application/json
X-Bridge-Token: <共享密钥>
```

示例 payload：

```json
{
  "schemaVersion": 1,
  "owner": "neko",
  "device": {
    "name": "Redmi",
    "platform": "android",
    "osSkin": "MIUI/HyperOS"
  },
  "date": "2026-06-13",
  "tz": "Asia/Kuching",
  "generatedAt": "2026-06-13T20:42:00+08:00",
  "summary": {
    "totalScreenMs": 12345678,
    "unlockCount": 42,
    "firstUsedAt": "2026-06-13T08:12:00+08:00",
    "lastUsedAt": "2026-06-13T20:30:00+08:00"
  },
  "apps": [
    {
      "packageName": "com.example.app",
      "appName": "Example",
      "foregroundMs": 3600000,
      "lastUsedAt": "2026-06-13T19:30:00+08:00"
    }
  ],
  "hourly": [0, 0, 0, 0, 0, 0, 0, 120000, 300000, 600000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 900000, 120000, 0, 0, 0]
}
```

### 5.3 网页读取接口

```http
GET https://bridge.codeandpurrs.com/api/usage/health
GET https://bridge.codeandpurrs.com/api/usage/latest?owner=neko
GET https://bridge.codeandpurrs.com/api/usage/day?owner=neko&date=2026-06-13
GET https://bridge.codeandpurrs.com/api/usage/trend?owner=neko&days=7
POST https://bridge.codeandpurrs.com/api/usage/prune?owner=neko&before=2026-05-01
DELETE https://bridge.codeandpurrs.com/api/usage/day?owner=neko&date=2026-06-13
DELETE https://bridge.codeandpurrs.com/api/usage/owner?owner=neko
```

## 5.4 VPS 参考实现

仓库内提供无依赖 Node 参考服务，包含 `GET /api/usage/health` 健康检查：

```bash
npm run bridge:start
```

运行环境变量：

- `HOST`：默认 `127.0.0.1`。
- `PORT`：默认 `8787`。
- `USAGE_BRIDGE_TOKEN`：红米桥接上传密钥，生产环境必须设置。
- `USAGE_BRIDGE_ALLOWED_ORIGINS`：允许的网页 Origin，逗号分隔；默认 `*`。
- `USAGE_BRIDGE_RETENTION_DAYS`：自动保留天数；`0` 表示不自动清理。
- `USAGE_BRIDGE_DATA_DIR`：可选 runtime 数据目录；默认 `server/data/usage/`。
- `VITE_USAGE_BRIDGE_DEMO`：前端 demo 开关；设为 `1` 时 Paw Trail 使用内置示例数据，不请求 bridge。

数据默认写入 `server/data/usage/<owner>/<YYYY-MM-DD>.json`，该目录不提交到 Git。

部署辅助文件：

- `.env.example`：VPS 环境变量模板，不要把真实 token 提交进仓库。
- `deploy/usage-bridge.service.example`：systemd 服务模板。
- `deploy/nginx-bridge.codeandpurrs.com.conf.example`：`bridge.codeandpurrs.com` 反代到 `127.0.0.1:8787` 的 nginx 模板。
- `docs/neko-usage-bridge-v8-checklist.md`：V8 部署联调验收清单。
- `docs/neko-usage-bridge-android-handoff.md`：V15 Android / Redmi 端交接清单。
- `docs/neko-usage-bridge-v16-cutover.md`：V16 生产上线验收清单。

### 5.5 删除接口

删除 / 清理接口用于兑现「可删除」隐私边界，必须带 `X-Bridge-Token`：

```http
POST https://bridge.codeandpurrs.com/api/usage/prune?owner=neko&before=2026-05-01
DELETE https://bridge.codeandpurrs.com/api/usage/day?owner=neko&date=2026-06-13
DELETE https://bridge.codeandpurrs.com/api/usage/owner?owner=neko
```

- `POST /api/usage/prune`：删除指定日期之前的历史 JSON，适合按保留策略清理旧数据。
- `DELETE /api/usage/day`：删除指定日期的单日 JSON。
- `DELETE /api/usage/owner`：清空指定 owner 的全部 usage 数据，适合桥接重置或迁移前清库。

### 5.6 自动保留策略

如果设置 `USAGE_BRIDGE_RETENTION_DAYS=60`，每次成功 ingest 后会以 payload 的 `date` 为锚点，只保留最近 60 天，自动删除更早的 owner 数据。返回值中的 `prunedDates` 会列出本次自动清掉的日期。

## 6. Paw Trail 网页目标

CodeAndPurrs 的「猫爪足迹｜Paw Trail」页面从 VPS 读取桥接数据，第一版展示：

- 今日总时长发光爪印活动环。
- 猫咪 AI 点评。
- Top Apps 爪印榜。
- 24 小时爪印时间线。
- 7 天趋势山丘，并显示 7 天均值与上一天对比。
- 解锁次数、首次使用、最后放下等小指标。
- 无数据、bridge health 状态、Bridge Doctor 自检、Launch Runbook 上线检查、Redmi Bridge Kit 接入清单、Android Handoff 交接卡、Production Cutover 生产验收、超过 6 小时未同步、加载失败、隐私提示状态，以及不保存 token 的导出 / 删除命令复制控制台。
