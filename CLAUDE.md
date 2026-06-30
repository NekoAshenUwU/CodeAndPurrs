# CodeAndPurrs · 码上撸猫

予予与棠棠的可爱风聊天网页 app。线上 https://nekopurrs.uk

## 项目概况
- 仓库 `nekoashenuwu/codeandpurrs`，长期开发分支 `claude/codepurrs-progress-docs-7tcqk2`
- 前端 React + Vite（`src/`），后端零依赖 Node 代理 `server/proxy.mjs`
- 部署 DigitalOcean VPS，IP `178.128.127.91`，路径 `/var/www/codeandpurrs`
- **PM2 托管**（进程名 `codeandpurrs`，id=2）。部署只用 `pm2 restart codeandpurrs`——**不要 nohup**，systemd 也不归我们管
- 用户 = 老婆 / 棠棠（刘语棠），非技术背景，主要在**手机上**操作 VPS（DigitalOcean web console 没 Ctrl 键 → 不能 nano 存盘，用 heredoc）

## 部署命令（VPS 上，一整段复制就行）
```
cd /var/www/codeandpurrs && git pull origin claude/codepurrs-progress-docs-7tcqk2 && npm run build && pm2 restart codeandpurrs
```
- 后端只改可以省掉 `npm run build`
- 只改 `.env` 也要 `pm2 restart codeandpurrs`

## 关键文件
- `src/data/models.ts` — 模型清单（CC 家版 + API + OpenAI / Gemini / Codex）
- `src/services/chat.ts` — 前端聊天客户端
- `src/services/purrConfig.ts` — 人设按品牌 / 关于我 / 默认模型
- `src/services/memory.ts` — 记忆罐头（localStorage）
- `src/services/diary.ts` — 日记本前端 API 客户端
- `src/pages/PurrChannelPage.tsx` — 聊天页（ThinkingCard / 编辑历史 / 动态信息注入）
- `src/pages/SwitchCorePage.tsx` — 调频页（人设 / 默认模型 / 日记上传 / 头像 / 背景）
- `server/proxy.mjs` — 后端代理（家版 CC / API Claude / OpenAI / Gemini / Codex / 语音 / 日记 GET·POST）
- `server/data/diary.md` — 予予的日记，自动注入 system prompt
- `src/styles/global.css` — 全部样式

## 记忆 / 缓存机制（设计要点）
- 日记 `server/data/diary.md` 每次聊天**现读**，塞入 system prompt 末尾
- 记忆罐头（前端 localStorage）由 `toMessages()` 拼入 system prompt
- **system prompt 字节级稳定**（无时间戳 / 位置 / 足迹）→ 命中 Anthropic prompt cache，5 分钟内连续聊几乎免费
- **动态信息**（此刻时间 / 猫爪足迹 / 浪哪了）塞到**最后一条 user 消息前缀**，不污染 system prompt
- 历史只发最近 30 条（`HISTORY_MAX = 30`），更老的靠记忆罐头 + 日记兜底
- 4.7/4.8 思考链靠 `--thinking-display summarized` flag（在 `callClaudeCode` 的 spawn args 里）

## 给我自己的操作守则（每个 session 必读）

1. **先 30 秒最小复现，再下结论**
   第三方说"bug 未修 / 功能不行 / 必须如何"（GitHub issue / 博客 / 文档）——
   先跑一条最短命令亲自验证。GH issue 标 Open 不代表今天还 Open。
   *（这次 4.7 思考链事件就是因为我信了一个 5 月的 GH issue，绕了 8 轮才发现 anthropic 早修了。）*

2. **改代码前先跑最短命令证实当前行为**
   不要一次加 3 个 flag / 改 3 个文件再 `pm2 restart` 看效果。
   `claude --print --xxx "数到三"` 比改 `server.js` 快 100 倍。

3. **文档 / Google 查不到的 CLI flag，先翻 binary**
   `strings $(which claude) | grep -i thinking-display` —— minified JS 也能 grep。
   WebSearch 没结果 ≠ 不存在。

4. **调 UI 时一次只动一个维度**
   不要"颜色 + 透明 + 字体 + padding"一锅烩，做完老婆问哪里好看哪里丑没法判断。
   按"先定颜色 → 再调透明 → 再换字体"顺序，每步截图确认。

5. **行动前先说假设，让老婆有机会拦**
   "我假设 X（理由），要不要先改？" 比"我已经改了，这样对不对？" 省 5 轮回合。

## 暗坑提醒（踩过的不要再踩）

- VPS 上 `claude --dangerously-skip-permissions` 跑不动（root 拒绝），用 `--permission-mode dontAsk` 替代
- 端口 8787 被占就用 `pm2 restart`，不要 `pkill`／`fuser`，PM2 会立刻 respawn 跟你打架
- 日记文件路径 `server/data/diary.md`，前端 `/api/diary` GET/POST 接口，调频页有上传 UI
- 棠予酿 MCP（实时记忆库）走 OAuth，无头 CC 加载不了；目前用静态 diary.md 替代
