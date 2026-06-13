# Neko Usage Bridge ＋ 猫爪足迹｜规格交接（v1）

> 目标：让红米手机上的 **Neko Usage Bridge** 把"今天用了多久手机、用了哪些 App"安静地推到 VPS，
> 「码上撸猫」的 **猫爪足迹（Paw Trail）** 房间再把它画成一页好看的、有猫味的爪印仪表盘。
>
> 这不是监控。是一对人**自愿**把自己的一天分享给对方看——"今天 ta 在忙啥、累不累、记得护眼没"。
> 语气和「浪哪了」一样：**只做主动分享，不做偷偷监视。**

## 0. 谁做哪部分

| 部分 | 谁做 | 说明 |
|---|---|---|
| 红米桥接 App（原生安卓，推数据到 VPS） | **Codex** | 见 §2、§3。按 §4 的契约推 JSON。 |
| VPS 接收端 + 存储 + 读取接口 | Claude（网页侧） | 见 §5。零依赖 Node，接进现有 `server/proxy.mjs`。 |
| 猫爪足迹网页（这一页的 UI） | Claude（网页侧） | 见 §6。 |

**两边对齐的唯一真相 = §4 的数据契约。** 改契约必须两边同步改 `schemaVersion`。

---

## 1. 架构：为什么用"推送到 VPS"，不在手机上开本地服务

旧版（华为版）的做法如果是"手机上跑个本地小服务、等网页来拉"，在红米上**注定一直报错**，因为：

- **MIUI / 澎湃 OS 杀后台极狠**：息屏/切后台，本地服务进程很快被杀，网页一连就失败。
- **混合内容 / CORS**：https 网页去 fetch `http://手机IP:端口` 会被浏览器拦。
- **手机 IP 会变**：不在同一 WiFi 就连不上。

所以 v1 一律改成 **单向推送**：

```
红米 Neko Usage Bridge ──(定时 HTTPS POST)──▶ VPS /api/usage/ingest ──▶ 存盘
                                                      ▲
                          码上撸猫网页 ──(GET 读)──────┘
```

手机只要"偶尔醒一下、把今天的汇总推上去"就行，不需要常驻、不需要和网页在同一网络。

---

## 2. 红米桥接 App｜Codex 实现要点

### 2.1 数据从哪来：`UsageStatsManager`（华为/红米通用）

读屏幕使用时长用的是**安卓标准 API**，华为红米一模一样，不用为红米重写采集逻辑：

- **每个 App 前台时长 / 首末使用时间**：`UsageStatsManager.queryUsageStats(INTERVAL_DAILY, start, end)`
  → 每个 `UsageStats` 取 `packageName`、`totalTimeInForeground`(ms)、`firstTimeStamp`、`lastTimeStamp`、`lastTimeUsed`。
  （或 `queryAndAggregateUsageStats` 直接按包名聚合。）
- **App 名称**：`PackageManager.getApplicationLabel(...)`。
- **解锁次数 / 按小时分布 / 一天的会话**：`UsageStatsManager.queryEvents(start, end)` 遍历 `UsageEvents.Event`：
  - 解锁次数 `unlocks`：数 `KEYGUARD_HIDDEN`（API 26+）次数；拿不到就退化成数屏幕点亮次数。
  - 按小时桶 `hourly[24]`：用 `ACTIVITY_RESUMED` / `ACTIVITY_PAUSED`（旧名 `MOVE_TO_FOREGROUND/BACKGROUND`）配对成"会话区间"，把每段时长按本地小时切片累加成 24 个桶（单位：分钟）。
  - 这些会话区间同时用来画网页的 24h 时间线。
- **通知数 `notifications`**（可选）：能拿就拿（需通知监听权限，嫌麻烦 v1 直接传 `null`）。

### 2.2 权限（红米上最容易"报错"的就是这块）

1. **`android.permission.PACKAGE_USAGE_STATS`**（特殊权限，不能普通弹窗申请）：
   - manifest 里声明（`tools:ignore="ProtectedPermissions"`）。
   - App 内引导用户去开：`startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))`。
   - 用 `AppOpsManager.checkOpNoThrow(OPSTR_GET_USAGE_STATS, ...)` 检测是否已授权，没授权就显示"去开启"按钮，**别在没权限时直接读，否则就是空数据/异常**。
2. 网络权限 `android.permission.INTERNET`。
3. 可选：`POST_NOTIFICATIONS`（如果用前台服务）、`RECEIVE_BOOT_COMPLETED`（开机自启补传）。

### 2.3 MIUI / 澎湃 OS 必做的"保活"引导（否则定时任务不跑）

App 第一次启动给一个**引导页**，带按钮跳到对应设置（跳不过去就给图文步骤）：

- **自启动**：MIUI「自启动管理」里允许本 App。
- **省电策略**：电池设置里把本 App 设为「**无限制**」，并在最近任务里**锁定**本 App。
- **后台弹窗/无障碍**：一般不需要。

> 把这页做成可随时回看的"连接状态 / 排错"页（见 §2.6）。这页就是用户报错时第一眼看的地方。

### 2.4 上传调度：用 WorkManager，别用裸前台服务

- **`WorkManager` 周期任务**：每 ~1–2 小时跑一次；约束 `NetworkType.CONNECTED`。
- 触发时：采集"今天到现在"的汇总 → POST。失败则 `Result.retry()`（WorkManager 自带指数退避）。
- 另外加：**网络恢复时**用一次性 expedited work 补传；**充电时**也补一次（这时最稳）。
- **离线兜底**：采集到的当日 payload 先写本地（一个文件或 Room 一行，按 `date` 覆盖），POST 成功才标记已传；失败留着下次补。
- 这样即使被杀，下次 Work 醒来也能把今天补上，不会"少一天"。

### 2.5 网络与安全

- **`VPS_BASE = https://api.nekopurrs.uk`**（已有域名 `nekopurrs.uk`，VPS = `178.128.127.91`）。App 一律走这个 https 地址，**不要用裸 IP、不要走明文**。
- 域名 + TLS 配置见 §5.1（一次性，配好后 App/网页都走 https，无明文告警）。
- 万一 TLS 还没配好的临时兜底：`android:usesCleartextTraffic` 仅对 `api.nekopurrs.uk` 放行（`network_security_config.xml` 白名单单域），**不要全局开明文**；TLS 一上线就撤掉。
- **鉴权**：请求头带 `X-Bridge-Token: <共享密钥>`。密钥写在 App 的 `local.properties`/BuildConfig，**别硬编码进提交的源码**，也别截图。VPS 侧用同一个密钥校验（§5）。
- 超时设短（连接 10s / 读 15s），失败交给 WorkManager 重试，别让 UI 卡。

### 2.6 App 自己的界面（极简，1–2 屏即可，重点是"看得出连上没")

桥接 App 不用做得花哨，但要让人**一眼看出状态**（旧版"很普通"主要也是这页太朴素）：

- 顶部一行大状态：🟢 已连接 / 🟡 权限没开 / 🔴 上次上传失败（带原因）。
- 关键数字：今天已采集总时长、上次成功上传时间。
- 三个引导按钮：① 去开"使用情况访问"权限 ② 去设自启动/无限制省电 ③ 立即上传一次（手动 flush，方便排错）。
- 一个"测试连接"按钮：打一发 `POST /api/usage/ping`，把 VPS 返回的状态码/错误**原文显示出来**——以后再报错，截这页就知道卡哪了。

### 2.7 验收标准（Codex 完成判定）

- [ ] 未授权时显示"去开启"，不崩、不传空。
- [ ] 授权后，手动"立即上传"能让 VPS 收到一条符合 §4 契约的 JSON（`schemaVersion=1`）。
- [ ] 息屏放置 ≥2 小时后，WorkManager 仍能自动补传当天数据（可放宽到"充电+WiFi 时必传"）。
- [ ] "测试连接"能显示 VPS 真实响应，失败时给出可读原因。
- [ ] 杀进程/重启手机后，下次任务能恢复，不丢当天数据。

---

## 3. 字段语义对照（采集 → 契约）

| 契约字段 | 来源 | 单位/说明 |
|---|---|---|
| `summary.totalForegroundMs` | 各 App `totalTimeInForeground` 之和（当天） | 毫秒 |
| `summary.unlocks` | `queryEvents` 数 `KEYGUARD_HIDDEN` | 次 |
| `summary.firstUseAt` / `lastUseAt` | 当天最早/最晚的前台事件时间 | ISO8601 带时区 |
| `summary.notifications` | 通知监听（可选） | 条，可为 `null` |
| `hourly[24]` | 会话区间按本地小时切片累加 | 每桶分钟数，index0=00:00 |
| `apps[].foregroundMs` | 该包 `totalTimeInForeground` | 毫秒 |
| `apps[].label` | `PackageManager` 应用名 | 中文名优先 |
| `apps[].iconBase64` | 可选，PNG base64（仅 top N，省流量） | 可为 `null` |
| `recentDays[]` | 最近 7–14 天每日聚合（用于补历史） | 可选 |

---

## 4. 数据契约（两边唯一真相）｜`schemaVersion: 1`

> **`VPS_BASE = https://api.nekopurrs.uk`**（域名 `nekopurrs.uk` → VPS `178.128.127.91`，配置见 §5.1）。下文所有 `{VPS_BASE}` 都替换成它。

### 4.0 时区与"一天"的口径（必须两边一致，否则会出灵异账目）

- **机主时区固定 `Asia/Shanghai`（UTC+8）**，这是切"一天"的唯一基准。VPS 虽然在新加坡（也是 +8），但**不准用服务器本地时间**判断日期——一切以 payload 里带的时区为准。
- **所有时间字段都用带时区偏移的 ISO8601**（如 `2026-06-12T23:58:00+08:00`），不准发裸时间戳或不带偏移的字符串。
- **"今天"= 机主本地零点切**：`date` 字段就是这个本地日期；`[本地 00:00, 次日 00:00)` 内的使用全算这天。
  → 凌晨 0:30 刷的小红书 = **今天**这一份；23:30 刷到 0:10 的会话，按本地小时切片，0:00 前算今天、0:00 后算次日。
- `hourly[24]` 的 index 0 = 机主本地 `00:00–01:00`，依此类推到 index 23。
- VPS 落盘、网页读取、趋势聚合**一律按 payload 的 `date`/`tz`**,不碰服务器本地时间。

### 4.1 上传（桥接 → VPS）

```
POST  {VPS_BASE}/api/usage/ingest
Headers:
  Content-Type: application/json
  X-Bridge-Token: <共享密钥>
```

```jsonc
{
  "schemaVersion": 1,
  "device": {
    "id": "redmi-<稳定唯一串>",     // 同一台机固定；别用会变的东西
    "owner": "neko",                // 这台机是谁的：'neko' | 'ashen'
    "model": "Redmi Turbo 4",
    "os": "HyperOS 2 / Android 15"
  },
  "tz": "Asia/Shanghai",
  "date": "2026-06-12",             // 本 payload 汇总的"本地日期"
  "generatedAt": "2026-06-12T16:20:00+08:00",

  "summary": {
    "totalForegroundMs": 11520000,
    "unlocks": 47,
    "firstUseAt": "2026-06-12T07:14:00+08:00",
    "lastUseAt":  "2026-06-12T23:58:00+08:00",
    "notifications": 213            // 可为 null
  },

  // 24 个整数 = 每个本地小时的前台分钟数；index 0 = 00:00–01:00
  "hourly": [0,0,0,0,0,0,0,12,34,20,8,5,3,15,22,18,9,11,40,55,48,30,14,2],

  // 按 foregroundMs 降序，取前 ~20 个
  "apps": [
    {
      "package": "com.ss.android.ugc.aweme",
      "label": "抖音",
      "category": "social",         // 可选；拿不到给 null
      "foregroundMs": 7200000,
      "lastUsedAt": "2026-06-12T22:40:00+08:00",
      "iconBase64": null
    }
  ],

  // 可选：让 VPS 补齐被杀漏掉的历史天
  "recentDays": [
    { "date": "2026-06-11", "totalForegroundMs": 13980000, "unlocks": 52 }
  ]
}
```

**VPS 返回**：`200 { "ok": true, "stored": "2026-06-12" }`；鉴权失败 `401`；体不合法 `400 { ok:false, error }`。

### 4.2 连通测试（排错用）

```
POST {VPS_BASE}/api/usage/ping     →  200 { "ok": true, "serverTime": "...", "owner": "neko" }
```

### 4.3 读取（网页 → VPS，GET，带同一 token 或只读 token）

```
GET {VPS_BASE}/api/usage/latest?owner=neko          → 最新一天的完整 payload（含 §4.1 结构）
GET {VPS_BASE}/api/usage/day?owner=neko&date=2026-06-12
GET {VPS_BASE}/api/usage/trend?owner=neko&days=7    → [{ date, totalForegroundMs, unlocks }, ...] 升序
```

读取响应再加一个元信息块，方便网页显示"数据多久前更新的"：

```jsonc
{
  "ok": true,
  "meta": { "owner": "neko", "lastIngestAt": "2026-06-12T16:20:00+08:00", "stale": false },
  "data": { /* §4.1 的 payload */ }
}
```

> `stale` = 最近一次上传距今超过阈值（默认 6h）就为 true，网页据此显示"数据有点旧啦"。

---

## 5. VPS 接收端｜Claude 实现（接进 `server/proxy.mjs`，零依赖）

### 5.1 域名 + HTTPS（一次性，先做这步）

- 已有域名 **`nekopurrs.uk`**，VPS IP **`178.128.127.91`**。规划：
  - `nekopurrs.uk`（或 `www`）→ 网站本体
  - **`api.nekopurrs.uk` → VPS 接口（聊天后端 + 足迹接收，即 `VPS_BASE`）**
- DNS：在域名商后台给 `api` 加一条 **A 记录 → `178.128.127.91`**（先关 Cloudflare 橙云/代理，确认直连通了再说）。
- TLS（VPS 上跑一次，Nginx 反代到本地 Node 端口 `8787`）：
  ```bash
  sudo certbot --nginx -d api.nekopurrs.uk     # 自动签发 + 配置 https + 自动续期
  ```
  Nginx 把 `api.nekopurrs.uk:443` 反代到 `127.0.0.1:8787`。配好后 App/网页统一用 `https://api.nekopurrs.uk`。

### 5.2 接收端实现

- 沿用现有零依赖 Node http 风格，按 path 加分支：`/api/usage/ingest|ping|latest|day|trend`。
- **存储**：零依赖，写 JSON 文件即可。目录 `server/data/usage/<owner>/<date>.json`；另存一个 `latest.json` 指针。`.gitignore` 掉 `server/data/`。
- **鉴权**：`USAGE_BRIDGE_TOKEN`（新增到 `.env` / `.env.example`，留空则 ingest 走"仅本机/拒绝"保护，别裸奔）。
- ingest：校验 token + `schemaVersion` + 必填字段 → 落盘当天文件，`recentDays` 用来补历史空缺（已有则不覆盖真实当天数据）。
- trend：读最近 N 天文件聚合。
- CORS：给网页域放行 GET。

---

## 6. 猫爪足迹网页 UI 规格｜Claude 实现

**路由**：`/paw-trail`（仿 `PurrChannelPage` 起一个 `PawTrailPage.tsx`）。
**风格**：完全沿用首页 v2「仙气浪漫风」token —— 毛玻璃卡片、紫粉雾感渐变、发光、草棵可爱体；移动优先、**单列竖滑**、卡片堆叠，中心列宽 ~ 480–560px（像一台手机）。
**动效**：环填充、柱生长、爪印错峰淡入；全部走现有 `usePrefersReducedMotion` 兜底。
**配色 token**：`--iris #9b7bc8`、`--iris-deep #5d4a7e`、`--sakura #f2a9c4`、`--blueviolet #7b8fe8`、`--glow`、`--cream`、`--card-strong`。
**字体**：标签用 `--cute`(草棵)、英文用 `--serif-en`(Crimson)、大数字用 `--round`(Fredoka)、猫咪点评用 `--chat`(龙珠)。

从上到下模块：

### ① 今日总时长 · 发光爪印活动环（主视觉）
- SVG 径向环：轨道半透明，进度描边走 `iris → sakura` 渐变 + 外发光（drop-shadow `--glow`）。进度 = `totalForegroundMs` 相对一个柔性参考（默认 6h，或取近 7 天个人峰值）。
- 环心：猫咪 mascot 图 + 大数字 `3ʰ12ᵐ`（Fredoka）+ 「今日」(草棵)。
- 环的起点缀一枚小爪印 🐾。
- 环下方一颗对比药丸：`比昨天少 23m`（少=薄荷绿，多=暖琥珀）。
- 入场动画：环从 0 转到目标值（reduced-motion 时直接到位）。

### ② 猫咪点评（v1 接 AI）
- 毛玻璃卡：左猫咪小头像，右语音气泡（龙珠体）。
- 文案来自 AI：网页把当天 `summary`+top apps 拼成上下文，POST 到现有聊天后端（`/api/chat`，带一个"足迹点评猫"人设：高用量→心疼/护眼提醒，深夜→催睡，轻量→夸夸）。**单条短回复，按 `date` 缓存当天**，别每次刷新都重算。
- 加载态：「猫咪正在看你今天的足迹…」配爪印 loader。

### ③ 爪印榜（Top Apps）
- 列表行：App 图标（无图标用爪印占位）+ 名称 + 右侧时长 + 一条爪掌填充条（宽度 = 占榜首百分比，条尾缀爪印）。
- 第一名高亮（更强毛玻璃 + 发光）。默认显示 Top 5，「展开看全部」展开剩余。

### ④ 一天的爪印时间线（24h 带状模块）
- 横轴 0→24h，读 `hourly[24]`：用量越高的时段，爪印越密/小丘越高，连成一条蜿蜒小路。
- 分段轻标注：夜里安静 / 早上刷 / 下午撸 / 晚高峰。
- 点/悬停某小时显示该时段详情。

### ⑤ 这一周的脚步（7 天趋势）
- 7 根圆角柔和柱（读 `/api/usage/trend`），今天高亮；周末用略不同色相；可选平均线。
- 点某天 → 整页切到那天的数据（或先做 tooltip）。

### ⑥ 小指标 chips
- 一排毛玻璃小药丸：`解锁 47 次 🔓`、`第一次拿起 07:14 🌅`、`最后放下 23:58 🌙`、`通知 213 条 🔔`。

### 状态设计（别漏）
- **还没数据**（桥接没连上）：友好插画 +「还没有爪印哦，等小红米第一次报到～」+ 一行接入提示。
- **数据偏旧**（`meta.stale`）：顶部淡淡一条「数据更新于 2 小时前」。
- **加载**：爪印微光骨架屏。
- **隐私一句话**：页脚轻声写「ta 自愿分享的一天 · 只看不扰」。

---

## 7. 里程碑

1. **契约冻结**：本文件 §4。✅（改动需同步 `schemaVersion`）
2. Claude：VPS `/api/usage/*` + 存储（先能 ingest/ping/latest）。
3. Codex：红米桥接采集 + 权限引导 + WorkManager 上传，对 §4 联调通。
4. Claude：猫爪足迹网页 ①–⑥ + 状态态。
5. 联调：真机红米推一天 → 网页出爪印。

> 共享密钥、token、截图都别外发。
