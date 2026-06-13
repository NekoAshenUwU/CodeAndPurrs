# Neko Usage Bridge V8｜部署联调验收清单

这份清单用于把 Paw Trail + VPS Bridge 这一段收口到 MVP。红米 Android App 本体另开版本线。

## 1. VPS 文件与环境

1. 把仓库部署到 DigitalOcean 新加坡 VPS，例如 `/opt/CodeAndPurrs`。
2. 复制 `.env.example` 到 VPS 的私有环境文件，或把变量写进 systemd：
   - `HOST=127.0.0.1`
   - `PORT=8787`
   - `USAGE_BRIDGE_TOKEN=<长随机密钥>`
   - `USAGE_BRIDGE_ALLOWED_ORIGINS=<CodeAndPurrs 前端域名>,https://tang.nekopurrs.uk`
   - `USAGE_BRIDGE_RETENTION_DAYS=60`
3. 确认 `server/data/` 不提交 Git，只保存在 VPS。

## 2. systemd

1. 参考 `deploy/usage-bridge.service.example` 安装服务。
2. 启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now usage-bridge
sudo systemctl status usage-bridge
```

3. 本机检查：

```bash
curl -s http://127.0.0.1:8787/api/usage/health
```

验收标准：返回 `ok: true`、`service: neko-usage-bridge`、`tokenConfigured: true`。

## 3. nginx + Cloudflare

1. 参考 `deploy/nginx-bridge.codeandpurrs.com.conf.example` 配置 nginx。
2. Cloudflare 中把 `bridge.codeandpurrs.com` 指向 VPS。
3. 公网检查：

```bash
curl -s https://bridge.codeandpurrs.com/api/usage/health
```

验收标准：公网 HTTPS 可访问 health，且不需要 token。

## 4. Smoke test


一键本地验收（自动启动临时 bridge、跑 smoke、清理数据）：

```bash
npm run bridge:verify
```


本地 VPS 直连：

```bash
BRIDGE_BASE_URL=http://127.0.0.1:8787 \
BRIDGE_TOKEN=<长随机密钥> \
npm run bridge:smoke
```

公网域名联调：

```bash
BRIDGE_BASE_URL=https://bridge.codeandpurrs.com \
BRIDGE_TOKEN=<长随机密钥> \
BRIDGE_DELETE_AFTER_SMOKE=1 \
npm run bridge:smoke
```

验收标准：脚本依次通过 health、ping、ingest、latest、day、trend；如果设置 `BRIDGE_DELETE_AFTER_SMOKE=1`，最后会删除 smoke test 当天数据。

## 5. Paw Trail 前端

1. 部署 CodeAndPurrs 前端时设置：

```bash
VITE_USAGE_BRIDGE_BASE_URL=https://bridge.codeandpurrs.com
```

2. 本地无 VPS / 无红米数据时可先开 demo：

```bash
VITE_USAGE_BRIDGE_DEMO=1 npm run dev
```

3. 打开 Paw Trail：
   - 首次无数据时显示空状态。
   - smoke / 红米上传后显示今日总时长、Top Apps、24h timeline、7-day trend。
   - 数据超过 6 小时未更新时显示省电提醒。
   - 隐私控制台能导出 JSON，并复制删除命令。
   - Bridge Doctor 能显示服务、存储、token、最新数据和趋势窗口状态，并复制 health / latest / trend 公开 curl 命令。
   - Launch Runbook 能显示 VPS service、token、首包上传、前端读取四步上线状态，并复制 env 清单和公网 smoke 命令。
   - Redmi Bridge Kit 能显示 Usage Access、自启动、无限制省电、手动上传四步接入清单，并复制 Android 配置 JSON 与权限检查顺序。
   - Android Handoff 能链接 V15 交接文档，并复制 manifest 权限片段与 Kotlin 上传草案。
   - Production Cutover 能链接 V16 生产验收文档，并复制公网 health、smoke 和删除验证命令。

## 6. 收口定义

Paw Trail + VPS Bridge 这段 V8 MVP 完成条件：

- VPS bridge 可用 systemd 常驻。
- `bridge.codeandpurrs.com/api/usage/health` 公网可访问。
- `npm run bridge:smoke` 对公网域名通过。
- Paw Trail 能读取 latest / trend 并正常渲染。
- 删除、prune、retention 策略已验证。
- 前端不保存、不输入、不暴露 bridge token。
