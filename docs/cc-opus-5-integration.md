# 接 CC Opus 5 (Claude Opus 5) 到 CodeAndPurrs

老婆版说明书。这份档案只讲怎么把 **CC Opus 5** 一个模型接进 CodeAndPurrs — DeepSeek / Gemini 那些不管。

## 0. CC Opus 5 是什么

- 官方名：**Claude Opus 5**
- API 上的字符串 ID：`claude-opus-5`（不要加日期后缀）
- 厂商：Anthropic
- 上下文窗口：1M tokens（默认 = 上限）
- 单次最大输出：128K tokens
- 价格：input **$5 / 1M tokens**，output **$25 / 1M tokens**
- 走什么协议：Anthropic Messages API — `POST /v1/messages`

## 1. 当前 CodeAndPurrs 已经做好的一半

前端这边我已经接好：

- `src/data/models.ts`：模型元数据，包含 `claude-opus-5`，默认模型就是它
- `src/components/RoomPreview.tsx`：SwitchCore 房间预览会显示三个模型卡片
- `src/data/rooms.ts`：SwitchCore 描述里带上 Claude Opus 5

**前端唯一需要送去后端的字段**（之后接后端时用）：

```ts
{
  model: "claude-opus-5",
  messages: [{ role: "user", content: "..." }]
}
```

## 2. 还没做的一半（VPS 后端）

CodeAndPurrs 现在只是纯前端 Vite 项目，没有后端进程。要让 CC Opus 5 真回话，VPS 上得跑一个 Node 后端做代理。

### 为什么要代理？

- **Anthropic API key 不能放前端** — 前端 JS 谁都能看，key 一泄漏钱包就飞
- key 存在 VPS 的 `.env`
- 前端只跟 VPS 后端讲话，VPS 后端拿着 key 去跟 Anthropic 讲话

### 数据流

```
浏览器 (CodeAndPurrs 前端)
    │  POST /api/chat  { model: "claude-opus-5", messages: [...] }
    ▼
VPS Node 后端 (Express)
    │  Anthropic SDK, 带 ANTHROPIC_API_KEY
    ▼
Anthropic API (api.anthropic.com)
    │  claude-opus-5 回复
    ▼
VPS 后端 → 前端 → 显示在呼噜频道
```

## 3. VPS 后端要做的东西（还没写）

### 3.1 依赖

在 `package.json` 里加：

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "express": "latest",
    "cors": "latest"
  }
}
```

### 3.2 `.env`（放 VPS，别提交 git）

```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxx
PORT=8787
```

Anthropic key 去 https://console.anthropic.com/settings/keys 生成（要 Anthropic 账号 + 充值）。

### 3.3 后端骨架（`server/index.ts`，示意）

只处理 `claude-opus-5` 一条路：

```ts
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const client = new Anthropic(); // 自动读 ANTHROPIC_API_KEY

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.post("/api/chat", async (req, res) => {
  const { model, messages } = req.body ?? {};

  if (model !== "claude-opus-5") {
    return res.status(400).json({ error: `unsupported model: ${model}` });
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      messages,
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    res.json({
      text,
      stop_reason: response.stop_reason,
      usage: response.usage,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

app.listen(Number(process.env.PORT ?? 8787), "0.0.0.0", () => {
  console.log(`CodeAndPurrs backend :${process.env.PORT ?? 8787}`);
});
```

**几个关键点**：

- **默认模型就用 `claude-opus-5`**，不加日期后缀
- **不要传 `temperature` / `top_p` / `top_k`** — Claude Opus 5 会 400（这三个字段在 Opus 4.7+ 已删）
- **不要传 `thinking: { type: "enabled", budget_tokens: N }`** — 也会 400
- Claude Opus 5 **thinking 默认是开的**（自适应）。要关得配 `thinking: { type: "disabled" }`，而且此时 `effort` 只能到 `high`，不能 `xhigh` / `max`
- `max_tokens` 是**思考 + 回复**的总上限。默认思考开着的话，`max_tokens` 要留出空间（16000 稳妥）
- **一定要检查 `response.stop_reason`**：`"refusal"` 时 `content` 可能是空数组，直接读 `content[0]` 会崩

### 3.4 检查 refusal（安全防护）

Claude Opus 5 的安全分类器可能拒答，返回 HTTP 200 + `stop_reason: "refusal"`：

```ts
if (response.stop_reason === "refusal") {
  return res.status(200).json({
    text: "（Claude 拒绝回答这条请求）",
    refusal: response.stop_details ?? null,
  });
}
```

进阶：想让被拒的请求自动 fallback 到 Claude Opus 4.8，用 `fallbacks: "default"` + beta header `server-side-fallback-2026-07-01`。第一版可以先不做。

## 4. 前端要补的（还没写）

现在前端只有房间入口，Purr Channel 聊天页还没写。要真能聊，得加：

1. `src/pages/PurrChannelPage.tsx`：聊天消息列表 + 输入框
2. `src/data/chatStore.ts`：会话状态 + 当前选的模型 id（从 `models.ts` 拿）
3. `src/api/chat.ts`：`POST /api/chat`，传 `{ model: currentModelId, messages }`

前端调用示例：

```ts
export async function sendChat(model: ModelId, messages: ChatMessage[]) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  return (await res.json()) as { text: string; stop_reason: string };
}
```

Vite dev 阶段要把 `/api` 代理到 8787：

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
```

## 5. VPS 部署指令

代码写好推 main 之后，在 VPS 上：

```bash
ssh root@178.128.127.91
cd ~/CodeAndPurrs
git pull origin main
npm install

# 建 .env
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-api03-...      # 换成真实 key
PORT=8787
EOF
chmod 600 .env

# 构建前端
npm run build

# pm2 跑后端（第一次装 pm2）
sudo npm i -g pm2
pm2 start "npm run start:server" --name codeandpurrs
pm2 save
pm2 startup   # 按输出再跑一次那条命令，开机自启

# 放行端口
sudo ufw allow 8787/tcp
```

访问：`http://178.128.127.91:8787`

## 6. 先在 VPS 测 key 通不通（不用等前端）

```bash
source .env
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"呼噜一下"}]
  }'
```

返回 200 + 一段文字 = key OK。返回 401 = key 错。返回 400 = 请求体错。

## 7. 换 key / 查日志 / 重启

```bash
nano .env             # 改 key
pm2 restart codeandpurrs
pm2 logs codeandpurrs # 实时日志
pm2 status            # 看进程状态
```

## 8. 安全 checklist

- [ ] `.env` 有 `chmod 600`，只有 root 能读
- [ ] `.env` 不在 git 里（`.gitignore` 已经挡了 `.env` 和 `.env.*`）
- [ ] Anthropic key 不在任何前端代码 / commit message / 截图里
- [ ] 后端 `/api/chat` 之后要加请求频率限制（express-rate-limit），防止有人拿你的 key 白嫖
- [ ] Anthropic 控制台开个花销上限（monthly spend limit）

## 9. 参考

- Anthropic Messages API 文档：https://platform.claude.com/docs/en/build-with-claude
- 模型 ID 权威列表：`claude-opus-5`（就这一个，别加后缀）
- Anthropic Node SDK：`@anthropic-ai/sdk`

## 10. 下一步（要不要我做，你说）

现在这份档案定了 CC Opus 5 的接入方案。真正落地还需要：

1. 写 `server/index.ts` + 更新 `package.json` 加依赖
2. 加 `vite.config.ts` 的 `/api` 代理
3. 写 Purr Channel 聊天页 + `sendChat()`
4. 加 `npm run start:server` 到 `package.json`
5. 在 VPS 上按 §5 部署

要开工的话跟我说一声，我一步一步来。
