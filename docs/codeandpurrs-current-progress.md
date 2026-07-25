# CodeAndPurrs 当前进度

## 已完成

- 已建立 CodeAndPurrs GitHub 仓库。
- 已推送 Vite + React + TypeScript 前端初版。
- 首页已经可以打开。
- 已完成 12 个房间入口卡片。
- 已完成 Purr Channel 初版聊天页。
- 已支持 DeepSeek V4 / Gemini 2.5 Flash / Claude Opus 5 (CC Opus 5) 的前端模型切换占位。
- 已把模型列表统一放到 src/data/models.ts，SwitchCore 房间点开就能看到三个模型卡片，Claude Opus 5 是默认选择。
- 已加档案 docs/cc-opus-5-integration.md，讲 CC Opus 5 = Claude Code CLI 上的 Opus 5，走 Claude 订阅 OAuth（不买 Anthropic API key），VPS 上 claude login 一次，server/proxy.mjs 遇到 model=claude-opus-5 就 spawn claude -p。前端占位已完成，server/proxy.mjs 那一路分路和 Purr Channel 聊天页还没写。
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
