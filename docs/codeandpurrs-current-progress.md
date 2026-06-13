# CodeAndPurrs 当前进度

## 已完成

- 已建立 CodeAndPurrs GitHub 仓库。
- 已推送 Vite + React + TypeScript 前端初版。
- 首页已经可以打开。
- 已完成 12 个房间入口卡片。
- 已完成 Purr Channel 初版聊天页。
- 已支持 DeepSeek V4 / Gemini 2.5 Flash 的前端模型切换占位。
- 已修复 CSS build 报错。
- VPS 已可通过 178.128.127.91:5173 访问。

## 目前状态

当前还是前端初版，聊天回复是 mock 假回复，还没有真正接 DeepSeek / Gemini 后端接口。

## 下一阶段

1. 上传并整理背景图、App icon、mascot、语音装饰图。
2. 把素材放进 public/assets/。
3. 前端改成真实使用这些图片。
4. 接 VPS 后端 /api/chat。
5. 让 Purr Channel 真正调用 DeepSeek V4 和 Gemini 2.5 Flash。
6. 后面再做 Whisperline、红包金库、导出舱等房间。

## 猫爪足迹 / Neko Usage Bridge 更新

- 用户实际所在地是马来西亚亚庇（Kota Kinabalu, Malaysia），不是中国大陆。
- 主域名是 `nekopurrs.uk`，挂在 DigitalOcean 新加坡 VPS 上，并走 Cloudflare。
- 当前已使用子域：`tang.nekopurrs.uk`（棠予酿前端）和 `mcp.nekopurrs.uk`（MCP 服务）。
- CodeAndPurrs 后续部署时需要单独确认正式前端子域。
- 红米桥接专用推送域名定为 `bridge.codeandpurrs.com`，专门用于 Neko Usage Bridge 上传使用数据。
- 红米桥接规格、接口契约和 Paw Trail 展示目标见 `docs/neko-usage-bridge-spec.md`。
- Paw Trail 前端页面已开工：入口改为 Ready，并开始从 `bridge.codeandpurrs.com/api/usage/latest?owner=neko` 读取最新足迹。
- Neko Usage Bridge VPS 接收端第二版已开工：新增无依赖 Node 服务，支持 `/api/usage/ping`、`/api/usage/ingest`、`/api/usage/latest`、`/api/usage/day`、`/api/usage/trend`，并用 `server/data/usage/` 做本地 JSON 存储。
- Paw Trail 第三版已补上 `/api/usage/trend` 读取、7 天趋势山丘、7 天均值、与上一天对比，以及超过 6 小时未同步的红米省电提醒。
- Neko Usage Bridge 第四版已补部署可用性：新增 `/api/usage/health` 健康检查、`.env.example`、systemd 服务模板和 `bridge.codeandpurrs.com` nginx 反代模板。
- Neko Usage Bridge 第五版补齐「可删除」闭环：新增需要 token 的 `DELETE /api/usage/day` 单日删除和 `DELETE /api/usage/owner` 清空 owner 数据接口。
- Neko Usage Bridge 第六版补上数据保留策略：新增 `USAGE_BRIDGE_RETENTION_DAYS` 自动清理和需要 token 的 `POST /api/usage/prune` 历史清理接口。
- Paw Trail 第七版补上前端隐私控制台：可导出当前 JSON，并复制需要 token 执行的单日删除 / 清空全部 curl 命令，前端不保存桥接密钥。
- Neko Usage Bridge 第八版进入 MVP 收口：新增 `npm run bridge:smoke` 全链路 smoke test 和 `docs/neko-usage-bridge-v8-checklist.md` 部署联调验收清单。
- Neko Usage Bridge 第九版补上一键本地验收：新增 `npm run bridge:verify`，自动启动临时 bridge、运行 smoke test、清理临时数据。
- Paw Trail 第十版补上前端 Demo Mode：`VITE_USAGE_BRIDGE_DEMO=1` 时使用内置示例数据渲染完整页面，不请求 bridge，方便 UI 验收和截图。
- Paw Trail 第十一版补上 bridge health 状态卡：页面读取 `/api/usage/health`，显示在线状态、token 配置、retention 天数和检查时间；health 失败不阻断 usage 展示。
- Paw Trail 第十二版补上 Bridge Doctor 自检面板：把服务、存储、token、最新数据和趋势窗口做成部署前检查项，并可复制 health / latest / trend 公开 curl 命令。
- Paw Trail 第十三版补上 Launch Runbook 上线检查：页面内整理 VPS service、token、首包上传、前端读取四步状态，并可复制 env 清单和公网 smoke 命令。
- Paw Trail 第十四版补上 Redmi Bridge Kit：页面内整理 Usage Access、自启动、无限制省电、手动上传四步接入清单，并可复制 Android 配置 JSON 与权限检查顺序。
- Paw Trail 第十五版补上 Android Handoff：新增 `docs/neko-usage-bridge-android-handoff.md`，并在页面内提供 Android 交接卡，可复制 manifest 权限片段与 Kotlin 上传草案。
- Paw Trail 第十六版补上 Production Cutover：新增 `docs/neko-usage-bridge-v16-cutover.md`，并在页面内提供公网 health、smoke、红米首包和删除验证四步生产验收卡。

## 注意

GitHub token 不要截图，不要发给任何人。
