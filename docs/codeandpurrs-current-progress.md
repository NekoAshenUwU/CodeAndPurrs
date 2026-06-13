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

## 猫爪足迹 / Neko Usage Bridge（重做计划）

- 旧版桥接是给华为搭的，换红米后一直报错；决定**重做红米版**而不是硬修。
- 已定架构：桥接 App **单向推送**使用数据到 VPS，网页从 VPS 读（不在手机上开本地服务，避开 MIUI 杀后台/混合内容/IP 变动）。
- 主视觉 = 发光爪印活动环；含猫咪 AI 点评、爪印榜、24h 时间线、7 天趋势、小指标。
- 界面已升级设计：会呼吸的时间背景（随真实时间变色、深夜接棠予酿深空风）、活动环星屑+猫咪按时长换表情、时间线做成"星河沙滩"（按类别染马卡龙色、深夜爪印带月亮）、App 榜单坐猫肉垫、呼噜吐槽气泡。为此契约新增可选 `sessions[]`（每段会话归属哪个 App）。
- 分工：Codex 做红米桥接，Claude 做网页 + VPS 接收端。
- 完整规格与数据契约见 `docs/neko-usage-bridge-spec.md`（§4 契约为两边唯一真相）。

## 注意

GitHub token 不要截图，不要发给任何人。
