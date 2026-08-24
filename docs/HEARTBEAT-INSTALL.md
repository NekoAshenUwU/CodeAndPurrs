# 缓存保活心跳·部署指南

## 它干啥

每 55 分钟自动用「你最后一次真聊天的前缀」打一发请求给 Anthropic，让那条
prompt cache 不会因超过 TTL 而过期。下次你聊天时不用花全价 token 重建上
下文（人设 + 日记 + 历史），订阅额度更耐烧。

- **CC 路径**（CC · Opus 4.6/4.7/4.8）：spawn `claude -p` 喂一个 `[__HEARTBEAT__]`
  占位，模型只回一个「。」，烧 ~5–10 输出 token / 次（订阅额度的零头）。
- **API 路径**（Opus 4.6/4.7/4.8 走 ANTHROPIC_API_KEY）：直接 `fetch
  /v1/messages` 用 `max_tokens=1` + `cache_control:1h` 预热，不烧输出 token。
- **DeepSeek / Gemini / GPT / Codex**：跳过（它们服务端自动缓存）。

## 装在 VPS 上

```bash
# 1. 拉新代码（生产分支会 merge 这个 PR 之后就有了）
cd /var/www/codeandpurrs
git pull origin claude/codepurrs-progress-docs-7tcqk2

# 2. PM2 重启 chat 后端（让 proxy.mjs 的嗅探 + cache_control 生效）
pm2 restart purr-chat
pm2 logs purr-chat --lines 5   # 看到 "🐾 呼噜代理已启动" 就行

# 3. 准备日志目录
sudo mkdir -p /var/log/codeandpurrs
sudo chown root:root /var/log/codeandpurrs

# 4. 装 systemd unit + timer
sudo cp /var/www/codeandpurrs/deploy/codeandpurrs-heartbeat.service /etc/systemd/system/
sudo cp /var/www/codeandpurrs/deploy/codeandpurrs-heartbeat.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codeandpurrs-heartbeat.timer

# 5. 看 timer 启动了没
systemctl list-timers codeandpurrs-heartbeat.timer
#   下一次触发时间应该在 5 分钟内
```

## 验证心跳真有效

### A. 先发一条真消息让嗅探落盘

打开 `nekopurrs.uk/purr-c`，选 `CC · Opus 4.7`，随便聊一句。然后：

```bash
ls -la /var/www/codeandpurrs/server/data/last-prefix.json
cat /var/www/codeandpurrs/server/data/last-prefix.json | head -c 200
#   应该看到 {"provider":"claudecode","model":"claude-opus-4-7",...}
```

### B. 手动跑一次心跳

```bash
sudo systemctl start codeandpurrs-heartbeat.service
sudo journalctl -u codeandpurrs-heartbeat.service -n 30 --no-pager
#   或直接看心跳脚本自己的日志：
tail -30 /var/log/codeandpurrs/heartbeat.log
```

期望看到：

```
[2026-06-29T...Z] 心跳唤醒: provider=claudecode, model=claude-opus-4-7, snapshot 距今 0 分钟
[2026-06-29T...Z] CC heartbeat 开始: model=claude-opus-4-7, system=12345b, transcript=678b
[2026-06-29T...Z] CC heartbeat 完成 code=0: cache_read=0 cache_create=15800 input=120 output=2
```

第一次 `cache_create` 是几千到上万 tokens（cache 刚写入），`output=2` 是
那个「。」+ 结束符。

### C. 第二次跑要命中

等 30 秒，再跑一次：

```bash
sudo systemctl start codeandpurrs-heartbeat.service
tail -5 /var/log/codeandpurrs/heartbeat.log
```

期望：

```
[...] CC heartbeat 完成 code=0: cache_read=15800 cache_create=0 input=120 output=2
```

**`cache_read` 大、`cache_create` 是 0** = 命中了，省钱了。

如果一直 `cache_read=0`，说明前缀不稳定（人设/记忆变了、Claude Code CLI
版本改了内部 prompt 拼装等）—— 看 `last-prefix.json` 的 `system` 字段
diff 两次，找出哪里不一样。

## 停掉

```bash
sudo systemctl disable --now codeandpurrs-heartbeat.timer
```

## 调参

`.env` 可以加：

```env
# 默认 24 小时；超过就不预热（人没在用）
HEARTBEAT_MAX_AGE_HOURS=24

# 自定义日志/状态文件路径
HEARTBEAT_LOG=/var/log/codeandpurrs/heartbeat.log
LAST_PREFIX_PATH=/var/www/codeandpurrs/server/data/last-prefix.json
```

## 已知坑

1. **第一次部署后 timer 第一次跑可能 skip**：如果你还没发过任何聊天消
   息，`last-prefix.json` 不存在，心跳脚本会 log "还没人真聊过天" 然后退
   出。聊一句就有了。
2. **改了人设/记忆罐头**：缓存会失效一次，下次心跳会 cache_create 再写
   入。这是预期行为。
3. **Claude Code CLI 升级**：CLI 内部 prompt 拼装可能变，缓存命中率可能
   突然掉到 0。看到 `cache_read=0` 持续就 `claude --version` 比对一下。
4. **DeepSeek/Gemini/GPT 切到 CC 时**：第一条 CC 消息一定是冷的（之前
   `last-prefix.json` 存的是别家的，心跳没预热到 CC）。属于切换成本，没
   办法。
