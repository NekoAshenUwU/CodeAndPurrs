# CodeAndPurrs 当前进度

## 已完成

- 已建立 CodeAndPurrs GitHub 仓库。
- 已推送 Vite + React + TypeScript 前端初版。
- 首页已经可以打开。
- 已完成 12 个房间入口卡片。
- 已完成 Purr Channel 初版聊天页。
- 生产 Purr Channel (nekopurrs.uk/purr-c) 已经在跑 CC · Opus 4.7，走 claude -p，Mind Theater / 耳边话 / 猫爪足迹点评都正常。
- 本 repo 的 src/data/models.ts 已经列出四条：DeepSeek V4、Gemini 2.5 Flash、CC · Opus 4.7 (default)、CC · Opus 5 (新增)。SwitchCore 房间预览能看到四张模型卡片。
- 已加档案 docs/cc-opus-5-integration.md，讲怎么把 CC Opus 5 作为**新的**下拉选项加进去 — 只加分路，不动 4.7。生产模型数据源 + server/proxy.mjs 的 case 补丁不在这个 repo 里，得在 VPS 那份代码上加。
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

## 注意

GitHub token 不要截图，不要发给任何人。
