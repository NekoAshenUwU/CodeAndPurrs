# CodeAndPurrs · 码上撸猫

予予与棠棠的可爱风聊天网页 app。线上 https://nekopurrs.uk

## 项目概况
- 仓库 `nekoashenuwu/codeandpurrs`，长期开发分支 `claude/codepurrs-progress-docs-7tcqk2`
- 前端 React + Vite（`src/`），后端零依赖 Node 代理 `server/proxy.mjs`
- 部署 DigitalOcean VPS，IP `178.128.127.91`，路径 `/var/www/codeandpurrs`
- **PM2 托管**（进程名 `codeandpurrs`，id=2）。部署只用 `pm2 restart codeandpurrs`——**不要 nohup**
- ⚠️ **VPS 上还平行存在一份 `/opt/codeandpurrs`（2026-06-26 的旧代码+旧 .env）和一个 systemd 服务 `codeandpurrs-chat.service` 会跑它**——见下面"systemd 影子部署坑"，这个坑 2026-07-01 晚上花了快 3 小时才查出来，下次先看这节
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
- 端口 8787 被占，多数时候 `pm2 restart` 就够，不要 `pkill`／`fuser` 瞎杀。
  但**如果 `pm2 list` 显示 `status:errored` 且反复重启还是 mock**：**先查是不是"systemd 影子部署坑"**
  （见下面专门那节，`ls -la /proc/$(lsof -ti :8787 -sTCP:LISTEN)/cwd` 一眼验证是不是 `/opt/codeandpurrs`）——
  这个 2026-07-01 才发现，比"孤儿进程"更常见，别一上来就当孤儿进程去 kill/重建 pm2 瞎折腾几小时。
  如果确认 cwd 就是 `/var/www/codeandpurrs`（排除了 systemd 坑），再考虑是不是下面这条"孤儿进程"坑，
  用 `lsof -i :8787 -sTCP:LISTEN` 揪出真凶 PID，跟 `pm2 pid codeandpurrs` 比对，
  确认不是 pm2 自己名下的才能单独 `kill` 掉（诊断优先，不要上来就 `fuser -k` 端口）
- **孤儿进程坑（2026-07-01 踩过）**：`ecosystem.config.cjs` 曾经写 `script:'npm', args:'run proxy:start'`——
  pm2 管的是 `npm` 这层外壳，`npm` 不一定把重启信号转发给它 fork 出来的 `node` 子进程，
  子进程就变孤儿，继续占着 8787 端口不放，下次重启抢不到端口就崩，如此反复直到 pm2 放弃(`status:errored`)。
  **现在已经改成让 pm2 直接管 `node`（`script:'server/proxy.mjs'` + `node_args`），没有中间层**，这个坑理论上不会再犯；
  如果哪天又看到"每次重启都冒出一个新孤儿 PID"，先怀疑 ecosystem 配置是不是又被改回 npm 包了层。
- **`.env` 加载双保险（2026-07-01 加）**：`server/proxy.mjs` 顶部现在用 `process.loadEnvFile()` 主动加载 `.env`，
  不再只靠 node CLI 的 `--env-file-if-exists` flag——万一哪天又被绕过 flag 启动（不管是 pm2 fork 模式的 quirk
  还是别的什么），proxy 自己也能兜底读到 `CLAUDE_CODE_OAUTH_TOKEN`。
- 日记文件路径 `server/data/diary.md`，前端 `/api/diary` GET/POST 接口，调频页有上传 UI
- 棠予酿 MCP（实时记忆库）走 OAuth，无头 CC 加载不了；目前用静态 diary.md 替代

## systemd 影子部署坑（2026-07-01 踩过，查了快 3 小时）

VPS 上除了 `/var/www/codeandpurrs`（pm2 管的正牌部署）之外，**还平行存在一份 `/opt/codeandpurrs`**——
一份 2026-06-26 的旧代码 + 自己独立的旧 `.env`（token 早失效/根本没配全）。
`/etc/systemd/system/` 里有 `codeandpurrs-chat.service`，`WorkingDirectory=/opt/codeandpurrs`，
`ExecStart=/usr/bin/node --env-file=.env server/proxy.mjs`，`Restart=always`、`enabled`（开机自启+崩了立刻重启）。

**这玩意会跟 pm2 抢 8787 端口**：谁先绑上端口谁赢，输的那个疯狂重试撞 `EADDRINUSE` 直接放弃(`pm2 list` 显示
`status:errored`)。如果 systemd 那份赢了，它读的是 `/opt` 那份坏掉的 `.env`，永远 `claudecode:mock`，
而且看起来"进程活着"（`ps`/`lsof` 都能查到），只是没人告诉你它其实不是 `/var/www` 那份代码在跑——
非常容易被误诊成"pm2 孤儿进程"（这次就先被带偏去修了三轮 pm2/ecosystem，最后才发现真凶是 systemd）。

**症状**：`pm2 restart` 之后 5~10 秒必崩(`errored`,`memory:0b`)，但 `lsof -i :8787` 查到的 PID **不是** `pm2 pid codeandpurrs` 那个；
一查那个 PID 的 `/proc/<pid>/cwd` 发现指向 `/opt/codeandpurrs` 而不是 `/var/www/codeandpurrs` —— 100% 是这个坑，别的都不用查了。

**诊断+修复**：
```bash
ls -la /proc/$(lsof -ti :8787 -sTCP:LISTEN)/cwd   # 看是不是指向 /opt/codeandpurrs
systemctl status codeandpurrs-chat.service --no-pager
systemctl stop codeandpurrs-chat.service
systemctl disable codeandpurrs-chat.service
# 再 pm2 delete codeandpurrs && pm2 start ecosystem.config.cjs && pm2 save 正常重建
```

⚠️ `/etc/systemd/system/` 里还有 `codeandpurrs-mcp.service`、`codeandpurrs-autonomy.service`(+`.timer`)、
`codeandpurrs-usage-bridge.service` 这几个同名前缀的单元——**只确认并禁用了 `codeandpurrs-chat.service`**（它是唯一一个跑
`proxy.mjs`/占 8787 端口的），其它几个没细查是干嘛的，如果哪天又发现奇怪的"背后有东西在跑"，先 `systemctl list-units --all --type=service | grep codeandpurrs` 摸底，别假设只有这一个。

## PM2 灾难恢复（codeandpurrs 被误删时）

老婆的 VPS 上 PM2 还跑着别的进程（telegram bot 之类，可能再被加回来）。**如果哪天发现 `pm2 list` 里没了 codeandpurrs**（或者聊天又走 mock 了），一句话从 `ecosystem.config.cjs` 恢复：

```
cd /var/www/codeandpurrs && pm2 delete codeandpurrs 2>/dev/null; pm2 start ecosystem.config.cjs && pm2 save
```

⚠️ **千万不要把 `ecosystem.config.cjs` 的 `script` 改回 `npm run proxy:start`** —— 见上面"孤儿进程坑"，那样会导致重启时端口被孤儿占死。
现在写死的是 `script:'server/proxy.mjs'` + `node_args:'--env-file-if-exists=.env'`，pm2 直接管 node 本体，**node 才读得到 `--env-file-if-exists=.env`，proxy 才能拿到 `CLAUDE_CODE_OAUTH_TOKEN`**——千万别绕过 ecosystem 文件直接 `pm2 start node server/proxy.mjs`（没带 node_args，一样拿不到 token）。

如果是别的 session 帮她删 telegram 那仨进程（`purr-bot` / `purr-chat` / `purr-reminder`），**提醒它绝对不要动 codeandpurrs**——这俩职责完全分开。

## OAuth token 失效时（约一个月或被清）

聊天回 mock + proxy 日志没看到 `claudecode:已配置` → token 过期。重生成：

1. VPS `claude setup-token` → 它打印一个 URL（终端宽度会换行，从截图重构 URL 要**逐行末→行首拼接逐字校验**，不要省）
2. 浏览器粘 URL → Authorize → 拿到一段 code（中间可能有 `#`，整段都要）
3. 回 VPS 终端粘 code → 回车
4. 提取写入 .env + 重启：
   ```
   TOKEN=$(grep -oE '"accessToken"[[:space:]]*:[[:space:]]*"[^"]+"' ~/.claude/.credentials.json | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
   sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' /var/www/codeandpurrs/.env
   echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" >> /var/www/codeandpurrs/.env
   pm2 restart codeandpurrs --update-env
   ```
5. 验证：`pm2 logs codeandpurrs --lines 5 --nostream` 应该看到 `claudecode:已配置`
