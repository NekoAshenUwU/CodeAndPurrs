# CodeAndPurrs 当前进度

> 🟢 **新窗口先读 `docs/SESSION-HANDOFF.md`** —— 那是最新、最全的交接(含 Paw Trail 反复打磨后的真实状态、待办、文件地图、踩过的坑)。本文件保留早期脉络,细节以 HANDOFF 为准。
> 开发分支：`claude/codepurrs-progress-docs-lngqpl`。

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

## 猫爪足迹 / Neko Usage Bridge（重做计划）

- 旧版桥接是给华为搭的，换红米后一直报错；决定**重做红米版**而不是硬修。
- 已定架构：桥接 App **单向推送**使用数据到 VPS，网页从 VPS 读（不在手机上开本地服务，避开 MIUI 杀后台/混合内容/IP 变动）。
- 主视觉 = 发光爪印活动环；含猫咪 AI 点评、爪印榜、24h 时间线、7 天趋势、小指标。
- 界面已升级设计：会呼吸的时间背景（随真实时间变色、深夜接棠予酿深空风）、活动环星屑+猫咪按时长换表情、时间线做成"星河沙滩"（按类别染马卡龙色、深夜爪印带月亮）、App 榜单坐猫肉垫、呼噜吐槽气泡。为此契约新增可选 `sessions[]`（每段会话归属哪个 App）。
- 分工（已校准）：**Codex 做红米安卓 App**（真正取数据那端），**Claude 做网页 + VPS 接收端 + 整合**。
- 完整规格与数据契约见 `docs/neko-usage-bridge-spec.md`（§4 契约为两边唯一真相）。
- 时区口径修正：机主在亚庇，owner 时区 = `Asia/Kuching`（非上海，都是 UTC+8）。
- ✅ **VPS 接收端已实现并整合**（基于 Codex PR #1，对齐 §4）：`server/usageBridgeServer.mjs` + 独立启动器 `server/usageBridge.mjs`（端口 8788，不动聊天后端 `proxy.mjs`）。endpoint：ingest/ping/latest/day/trend + health/prune/delete/owner-delete；读取走 `{ok,meta{owner,lastIngestAt,stale},data}` 外壳、服务端算 stale；校验 `device{}`、§4 字段名、`sessions[]`、`notifications`、app `category/iconBase64`；token 鉴权 + CORS + 保留天数。零依赖。`npm run bridge:test`（11/11 过）、`npm run bridge:verify`（端到端过）。部署样例 `deploy/nginx-api.nekopurrs.uk.conf.example`、`deploy/usage-bridge.service.example`。
- ✅ **前端猫爪足迹页已实现并多轮打磨**（按 §6 重写）。**最新真实状态见 `docs/SESSION-HANDOFF.md` §3**（要点：进度环每日目标 12h/从12点顺时针填/果冻管状无白内圈；玻璃珠 App Icon + 按 App 双色渐变进度条 + 龙珠体字色；周柱莫兰迪马卡龙各色渐变+星座点+柱身爪印;两张 GPT 画框图拼成白天/夜晚两套无缝背景;**「星河沙滩」模块已删除**)。
- ⏳ 待办（详见 HANDOFF §6）：首页白天/夜晚新背景图、ashen 版背景、Mascot 文案待棠棠、Codex 安卓 App、VPS 部署、关 PR #1、择期合并 main。
- 注：Codex PR #1 里那 11 张 `file_*.png`（~15MB）是垃圾,未采纳;其改写的 spec/字段名也未采纳,以 §4 为准。

## 首页改造（hero 升级）

- 目标：hero 区精致度追上 12 枚 3D 图标，从「海报」变「入口」。
- 七件事：hero 出 mascot（呼吸/摆尾）、卡片从「卡」变「窗」（极光层+星屑+呼吸光晕）、房间错落悬浮+云影+视差、会呼吸的时段背景（与猫爪足迹共用）、指尖爪印彩蛋、中文装饰句加深可读、性能红线（粒子≤35、reduced-motion 降级）。
- 现状已具备不少氛围件（Atmosphere 光尘+自动爪印、LoveCursor、hero 斜高光、点击果冻弹、字体已子集化），属"补主角+升级氛围"非重写。
- 实现就绪规格（含现状/改法/文件映射 + 落地顺序）见 `docs/homepage-redesign-spec.md`。
- ✅ 已实现：会呼吸的时段背景（4 套渐变 crossfade + 深夜星点，`timeOfDay.ts` 与爪足迹共用）、hero 出 mascot（呼吸摆尾）+ 卡后极光 + 边缘呼吸光晕 + 卡内星屑、房间错落悬浮 + 云影 + 滚动视差、指尖爪印彩蛋（`PawCursor`）、装饰句加深可读、深夜文字提亮、reduced-motion 全量降级。`npm run build` 通过，四时段已截图验收。
- ✅ 背景改回 GPT 梦境底图（`.timesky__photo`），时段只叠一层薄色纱（白天近透明让原图发光、傍晚粉紫、深夜压暗+星点）；深夜预留 `public/rooms/home-dream-night.webp`，放了就自动用夜图、没放则压暗原图兜底。
- ✅ 门牌液态玻璃强化：液态按压（非等比挤压+圆角形变果冻回弹）、光跟手走（指针位置写入 `--mx/--my`，高光在玻璃面流动）、深夜文字/高光可读性单独校过。

## 注意

GitHub token 不要截图，不要发给任何人。
