# 接 CC Opus 5 到 CodeAndPurrs

> **只加一路，不动 Opus 4.7。**
> Purr Channel 现在跑的是 **CC · Opus 4.7**，走 `claude -p`（CC-p 头less 模式）。这份档只讲怎么把 **Opus 5** 作为**新的**下拉选项加进去，让老婆想切就切，不影响现在稳定跑的 4.7。

## 0. 现状（截图确认过的事实）

- 生产地址：`nekopurrs.uk/purr-c`
- 标题："CC 04.7 Purr Channel"
- 模型选择器："CC · Opus 4.7 ▼"
- 后端走 `claude -p`（Claude Code headless），不是 Anthropic API
- 已经稳定在用：Mind Theater 思考显示、耳边话（语音回复）、猫爪足迹点评都跑得起来
- 07-25 21:47 那条 `('-')ノ)`-')` 没收到回复 = **另一个 bug**，跟这份档无关

## 1. 这份档要做的事（只两条）

1. 模型下拉里**多一个** `CC · Opus 5` 选项，4.7 保留不动
2. 后端 `server/proxy.mjs` 分路里**加一个** `case "claude-opus-5"`，走同一套 `claude -p` 调用，只是 `--model` 换字符串

**不要做的事**：

- ❌ 不要删 `claude-opus-4-7`
- ❌ 不要把默认改成 Opus 5（默认还是 4.7，让老婆自己切）
- ❌ 不要改现有 4.7 分路的任何一行

## 2. 前端（本 repo 已经改好）

`src/data/models.ts` 现在有四条：

| id | 显示名 | 备注 |
|---|---|---|
| `deepseek-v4` | DeepSeek V4 | 占位（build-plan 里的计划模型） |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 占位 |
| `claude-opus-4-7` | **CC · Opus 4.7** | 当前正在跑的，**default** |
| `claude-opus-5` | **CC · Opus 5** | 新增，需要后端加分路才真能用 |

`defaultModelId = 'claude-opus-4-7'` — 保持默认是 4.7，老婆想试 Opus 5 就点下拉切。

> 注意：这个 repo 的 `src/` 只是最初版首页 + 房间入口，**Purr Channel 页面真代码不在这个 branch**（我确认过 main / origin 都没）。真正生产用的模型下拉在哪个 repo / VPS 目录里，你更清楚。改法都一样：在**那个** `models.ts`（或等价数据源）里加一条 `claude-opus-5` 就行。

## 3. 后端 `server/proxy.mjs` 加分路

假设现在 4.7 那一路长这样（示意，你 VPS 上真代码可能略不同）：

```js
case "claude-opus-4-7":
  return await chatWithClaudeCLI(body, "claude-opus-4-7");
```

**加一行就行**：

```js
case "claude-opus-4-7":
  return await chatWithClaudeCLI(body, "claude-opus-4-7");
case "claude-opus-5":                                  // ← 加这两行
  return await chatWithClaudeCLI(body, "claude-opus-5");
```

如果 `chatWithClaudeCLI` 是复用的（推荐做法），改动就这两行；如果每个模型各写一份 handler，那就复制一份 4.7 的，把 `--model` 换成 `claude-opus-5`。

### 3.1 spawn 参数（如果你已有这段可以对照）

```js
spawn("claude", [
  "-p", prompt,
  "--model", "claude-opus-5",             // ← 唯一实质区别
  "--output-format", "text",              // 或 stream-json，看现有 4.7 是啥
  "--allowed-tools", "",                  // 保持和 4.7 一致，别给工具权限
  "--permission-mode", "read-only",
]);
```

**保持和 4.7 完全一样的其它参数** — timeout、env、cwd、stderr 处理，全复制。别趁机改 4.7 的行为。

## 4. VPS 验证

登录 VPS 直接测新模型能不能跑（不用先改代码）：

```bash
ssh root@178.128.127.91
claude -p "呼噜一下，一句话回我" --model claude-opus-5
```

- 打字出来 = OK，Opus 5 你订阅能用，可以加分路
- 报错 "model not available" / 类似 = 你的 Claude 订阅档还没解锁 Opus 5，得先在 Anthropic 那边看订阅状态

（**Opus 5 是新模型，某些订阅档要一段时间才推送**。装的 `claude` CLI 版本太老也可能不认新 model ID，可以先跑 `npm i -g @anthropic-ai/claude-code@latest` 更新一下。）

## 5. 上线之后

前端 `models.ts` 加进去 + 后端 `server/proxy.mjs` case 加好 → 重启后端：

```bash
pm2 restart <你的后端进程名>
pm2 logs <进程名> --lines 30
```

老婆打开 `nekopurrs.uk/purr-c`，下拉里就会多一个 **CC · Opus 5**。点它 → 发消息 → 走新分路。原来的 4.7 完全不受影响。

## 6. 07-25 那条丢回复的 bug（分开处理）

跟 Opus 5 接入无关，但顺手记一下排查方向：

- `pm2 logs <进程名>` 翻到 07-25 21:47 前后，看有没有 stderr
- Claude 订阅额度：有没有 429 rate limit
- Nginx 日志：`/var/log/nginx/error.log`，看 upstream timeout
- `claude` 子进程有没有 hang 住（`ps aux | grep claude`）
- 前端 fetch 有没有 catch 到错，UI 是不是 silent fail

要我一起看这个 bug 就说一声，需要你把 pm2 日志那段贴过来（或 SSH 让我进 VPS）。

## 7. 待办

- [x] 前端 `src/data/models.ts` 加 `claude-opus-4-7` + `claude-opus-5` 两条并列
- [ ] **生产**的模型数据源（不在这个 repo 里的那份）同步加 `claude-opus-5`
- [ ] `server/proxy.mjs` 加 `case "claude-opus-5"` 分路
- [ ] VPS 上先 `claude -p --model claude-opus-5` 单跑一次确认订阅能用
- [ ] 重启后端 + 老婆试切换
- [ ] （另开）查 07-25 21:47 那条为什么没回复
