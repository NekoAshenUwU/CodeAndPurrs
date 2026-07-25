# 接 CC Opus 5 (Claude Code · Opus 5) 到 CodeAndPurrs

> **走 Claude 订阅，不买 Anthropic API key。**
> VPS 上装 `claude` CLI，用你现有的 Claude 账号登录一次，`server/proxy.mjs` 遇到 `model: "claude-opus-5"` 就 shell 出去调 `claude -p`，把回复送回呼噜频道。

## 0. 前置事实（照 neko-usage-bridge-spec.md 对齐）

- VPS：`178.128.127.91`，域名 `nekopurrs.uk`
- API 域名：`api.nekopurrs.uk` → `VPS:8787`（Nginx + certbot 反代到本地 Node）
- 现有聊天后端：`server/proxy.mjs`（零依赖 Node http，已经在处理 `/api/chat`；DeepSeek / Gemini 走它的分路）
- 现有前端调用点：猫爪足迹的"足迹点评猫"就是 POST `/api/chat` 拿一句短评
- 前端本仓库已经加好：`src/data/models.ts` 里 `claude-opus-5` 默认，SwitchCore 房间预览能看到

**这一份要做的事**：让 `server/proxy.mjs` 多认一路 `model === "claude-opus-5"`，走 `claude` CLI 而不是 API。

## 1. 为什么不走 Anthropic API

- API key 要单独充值，Claude 订阅（Pro / Max / Team）本身**不给** API key
- 你已经在用 Claude Code，那个 OAuth 登录直接把订阅额度接进 CLI，不用再花钱
- 缺点：CLI 会话有速率上限（按订阅档），并发大要注意；后面真高频再考虑升级或加缓存

## 2. VPS 一次性安装 & 登录

一次性做完，以后不用碰：

```bash
ssh root@178.128.127.91

# 装 Node ≥ 18（Claude Code 要）
node -v   # 要 >= 18，不够就升级

# 装 Claude Code CLI（官方）
npm i -g @anthropic-ai/claude-code

# 确认装上了
which claude
claude --version

# 用你自己的 Claude 账号登录（浏览器 OAuth 一次）
claude login
# 会打印一个 URL，本地浏览器打开 → 授权 → 复制回来的 code 粘回终端
# 完事后 token 存在 ~/.config/claude/ (或类似路径)，pm2 起的进程能读到
```

**验证**（不进 REPL，直接 headless 问一句）：

```bash
claude -p "呼噜一下，一句话回我"
```

看到 Claude 打字 = OK。这条命令就是后端要 subprocess 的东西。

## 3. `server/proxy.mjs` 加一路 Claude

`server/proxy.mjs` 的现有骨架应该是按 `req.body.model` 分路（DeepSeek / Gemini）。加一路 `claude-opus-5`，用 `child_process.spawn` 调 `claude -p`。

### 3.1 核心思路

- `spawn("claude", ["-p", promptString, "--model", "claude-opus-5", "--output-format", "text"])`
- `stdin` 不用（用 `-p` 一次把 prompt 传完；或者 messages 长的话 `spawn` 后写 stdin 更稳）
- 读 `stdout` 一路拼字符串
- 进程 exit 后把整段 text 一起返回前端

### 3.2 一段可参考的分路（放进 `server/proxy.mjs`）

```js
import { spawn } from "node:child_process";

// 已有：DeepSeek / Gemini 的 handler
// 新增：Claude Code CLI handler
function chatWithClaudeCLI({ messages }) {
  return new Promise((resolve, reject) => {
    // 把 messages 转成一段单轮 prompt。
    // v1 简化：只取最后一条 user 内容。多轮上下文之后再加 --continue / 会话文件。
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return reject(new Error("no user message"));
    const prompt =
      typeof lastUser.content === "string"
        ? lastUser.content
        : lastUser.content.map((c) => c.text ?? "").join("");

    const child = spawn(
      "claude",
      ["-p", prompt, "--model", "claude-opus-5", "--output-format", "text"],
      { env: process.env, timeout: 120_000 },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (err += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ text: out.trim() });
      else reject(new Error(`claude exit ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

// 在现有的 /api/chat 分路里加：
// switch (model) {
//   case "deepseek-v4":     return await chatWithDeepSeek(body);
//   case "gemini-2.5-flash": return await chatWithGemini(body);
//   case "claude-opus-5":    return await chatWithClaudeCLI(body);
//   default: throw 400 "unsupported model";
// }
```

前端已经在 `src/data/models.ts` 里传 `model: "claude-opus-5"`，后端 case 就是那个字符串。

### 3.3 `--output-format` 选择

`claude -p` 的输出格式选项（写这份档时的版本）：

| 选项 | 用途 |
|---|---|
| `text`（默认） | 纯文本回复，最简单，v1 就用这个 |
| `json` | 结构化 JSON，带 metadata / stop reason，之后要展示 usage 时切这个 |
| `stream-json` | 流式 SSE，之后想让前端"打字机效果"时切这个 |

v1 先 `text`，别一次上流式。

### 3.4 关掉工具（防止 CLI 乱跑 bash）

CodeAndPurrs 用 CC 只是当聊天引擎，**不要**给它工具权限。加 `--allowed-tools ""` 明确清空（或用 permission mode）：

```js
spawn("claude", [
  "-p", prompt,
  "--model", "claude-opus-5",
  "--output-format", "text",
  "--allowed-tools", "",           // 关掉所有工具
  "--permission-mode", "read-only", // 双保险
]);
```

不然 Claude 拿到"帮我做 xxx"这种 prompt，可能自己去读文件、跑命令。聊天场景纯浪费 token + 有安全风险。

## 4. 关键坑 & 注意

### 4.1 pm2 进程要能读到 `claude login` 的 token

`claude login` 存的 token 在 **登录时那个用户的 home 目录**下（一般 `~/.config/claude/` 或 `~/.claude/`）。pm2 起 `server/proxy.mjs` 时如果用同一个用户就没事；如果 pm2 跑在别的 user（比如 `www-data`），要么用同一账号 login，要么把 token 目录 chown 过去。

排查：
```bash
pm2 exec codeandpurrs -- claude -p "test"
```
（看是不是 401 / no credentials）

### 4.2 速率限制

Claude 订阅按档给消息数上限。频繁请求会被 429，`claude -p` 会打印错误并 exit 非 0。后端应该：
- catch 到 exit code ≠ 0 时给前端一个可读错误（"呼噜歇一会儿，稍后再试"）
- 想真扛并发：加个 in-memory queue，一次最多 N 个 concurrent claude 进程

### 4.3 subprocess 冷启延迟

`claude -p` 每次都启动一次 Node 进程 + 建立会话，冷启 1-3 秒。用户敲完回车到看到第一个字会有明显停顿。

优化选项（v2 再说）：
- 换 `--output-format stream-json`，让前端边收边显示 → 感知延迟降低
- 或用 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）常驻进程，省掉每次冷启

### 4.4 多轮上下文

`claude -p prompt` 是**单轮**（每次新会话）。要多轮：

- **简化派**：`server/proxy.mjs` 里把整段 `messages` 拼成一段带角色前缀的 prompt 传进去（v1 够用）
- **CLI 派**：`claude -p --resume <session-id>` 或 `--continue`，在 proxy 里维护 sessionId 表
- **SDK 派**：换 Agent SDK，会话状态自己管

v1 用**简化派**（因为反正 CodeAndPurrs 前端还没做 Purr Channel 的完整多轮 UI，聊天记录也计划放小暗格 IndexedDB，后端可以拿到完整 history）。

### 4.5 timeout

Claude 复杂 prompt 可能生成很久（尤其思考模型）。上面示例给了 `timeout: 120_000`（2 分钟）。Nginx 的 `proxy_read_timeout` 也要够长，否则前端先超时。

## 5. VPS 部署指令

代码写好推 main：

```bash
ssh root@178.128.127.91
cd ~/CodeAndPurrs
git pull origin main
npm install    # 如果没加新依赖其实不用，纯 stdlib
pm2 restart codeandpurrs    # 或对应进程名
pm2 logs codeandpurrs --lines 50
```

第一次改完，在 VPS 上直接测一发：

```bash
curl -X POST https://api.nekopurrs.uk/api/chat \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-5","messages":[{"role":"user","content":"呼噜一下"}]}'
```

回一段 JSON `{ text: "..." }` = OK。

## 6. 前端已经准备好的部分

- `src/data/models.ts`：`claude-opus-5` 是默认 `defaultModelId`
- SwitchCore 房间预览：三张模型卡片，Claude Opus 5 挂"默认"标签
- Purr Channel 聊天页：**还没写**（前端只有 HomePage + 房间入口）

真要能聊，前端还得加：
- `src/pages/PurrChannelPage.tsx`：消息列表 + 输入框
- `src/api/chat.ts`：`fetch("/api/chat", { model: currentModelId, messages })`
- Vite dev 加 `/api` proxy 到 `https://api.nekopurrs.uk`（或 dev 时 `localhost:8787`）

## 7. 安全 checklist

- [ ] `claude login` 的 OAuth token 只在 VPS 那个 user 的 home 里，`~/.config/claude/` chmod 700
- [ ] `server/proxy.mjs` 调 `spawn` 时**永远不要**把 user 输入拼进 argv（用参数数组，不用 shell string）
- [ ] `--allowed-tools ""` + `--permission-mode read-only`：CC 不能读 VPS 文件、不能跑命令
- [ ] Nginx 上 `/api/chat` 加 rate limit（`limit_req_zone`），防止有人白嫖你的 Claude 订阅
- [ ] 前端不做任何鉴权 = 谁都能调 → 至少加个 `X-Bridge-Token` 或 Cloudflare turnstile
- [ ] 出错回给前端时**不要**把 Claude 的原始 stderr 直接吐出去（可能带路径 / 环境信息）

## 8. 下一步 todo

- [ ] VPS 上装 claude CLI + `claude login`（一次性）
- [ ] `server/proxy.mjs` 加 `chatWithClaudeCLI` 分路 + case
- [ ] 在 VPS 上 curl 测一发确认通
- [ ] 前端补 Purr Channel 聊天页 + `/api/chat` proxy
- [ ] Nginx 加 rate limit

要我动手写代码就说一声。目前**只是档案 + 前端占位**，`server/proxy.mjs` 我没碰过（它不在这个 branch 的 tree 里，可能在 VPS 上或别的地方）。
