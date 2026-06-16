# Codex 施工说明书｜Neko Usage Bridge（红米 / HyperOS 原生安卓 App）

> 给 **Codex** 的任务单。**唯一目标**：做一个红米手机上的原生安卓 App，
> 安静地把"今天用了多久手机、用了哪些 App、几点解锁"按契约推到 VPS。
> 网页展示端（猫爪足迹）和 VPS 接收端**都已经做好了**，你**只做这个安卓 App**。
>
> ⚠️ 三条铁律（违反即作废）：
> 1. **不准改契约**：数据格式以 `docs/neko-usage-bridge-spec.md` §4 为**唯一真相**。要改必须先和机主确认并同步 `schemaVersion`。
> 2. **不准碰网页仓库的任何前端/后端代码**（`src/`、`server/`、`public/` 等一律不动）。
> 3. **不准把密钥写进提交的源码**（token 走 `local.properties` / GitHub Secret，见 §6）。

---

## 🐾 给机主的 5 步操作清单（Neko 照着点就行）

> 这几步是**你**做的；中间写代码、出 APK 是 Codex 做的。

1. **新建空仓库**：GitHub 上 New repository → 名字填 `neko-usage-bridge` → 设为 Private → Create（**不要**勾 README/.gitignore，留空）。
2. **把任务丢给 Codex**：让 Codex 读这两份文件——本文件 `docs/codex-usage-bridge-android-task.md` ＋ 契约 `docs/neko-usage-bridge-spec.md`，按里面做，并推到 `neko-usage-bridge` 仓库的 `codex/redmi-bridge-v1` 分支。
3. **建一个密钥 Secret**：进 `neko-usage-bridge` 仓库 → Settings → Secrets and variables → Actions → New repository secret → 名字 `BRIDGE_TOKEN`，值＝你和 VPS 上 `USAGE_BRIDGE_TOKEN` **一模一样**的那串密钥。
   - （这串密钥就是 VPS `.env` 里的 `USAGE_BRIDGE_TOKEN`；不记得就先在 VPS 看一眼，App 和 VPS 必须同一串。）
4. **下载 APK**：Codex 推上去后，进仓库 **Actions** 标签 → 点最新那次 `build-apk` 运行 → 拉到底 **Artifacts** → 下载 `neko-usage-bridge-debug-apk` → 解压得到 `.apk`，传到红米安装（装时若拦截，允许"未知来源"）。
5. **装机授权 + 测试**：打开 App →
   ① 按提示开「使用情况访问」权限；
   ② 按提示设自启动 / 电池「无限制」；
   ③ 点「测试连接」应显示 VPS 正常返回；
   ④ 点「立即上传」一次。
   然后无痕打开 `nekopurrs.uk` 的**猫爪足迹**页，就能看到今天的爪印啦 🐾

> 卡在任何一步（CI 报红、APK 装不上、上传 401、页面没数据），把那一步的截图发我，我帮你看。

---

## 0. 边界：谁做什么（先看清再动手）

| 部分 | 状态 | 说明 |
|---|---|---|
| 猫爪足迹**网页展示界面** | ✅ 已完成（昨天定稿，**不要重做**） | 在主仓库 `src/pages/PawTrailPage.tsx`，读 VPS 数据画图。 |
| **VPS 接收端**（`/api/usage/ingest\|ping\|latest\|day\|trend`） | ✅ 已完成 | 在主仓库 `server/usageBridgeServer.mjs`，已能收数据存盘。 |
| **红米桥接 App（原生安卓，采集+上传）** | ❌ **这就是你的任务** | 见本文件全部章节。 |

你的 App 唯一的对外职责：**按 §4 契约，定时 HTTPS POST 到 `https://api.nekopurrs.uk/api/usage/ingest`**。
其余一切（网页长什么样、VPS 怎么存）与你无关，按契约走就能对接上。

---

## 1. 交付物 & 仓库 / 路径（钉死，不要自由发挥）

### 1.1 用一个**独立新仓库**（推荐，别塞进网页仓库）

- 仓库名：**`nekoashenuwu/neko-usage-bridge`**（机主在 GitHub 新建空仓库，Codex 推上去）。
- 原因：安卓是 Gradle 工程，混进 Vite 网页仓库会污染构建。独立仓库最干净，CI 也好配。
- 默认分支：`main`。开发分支：`codex/redmi-bridge-v1`，做完发 PR 给机主。

> 备选（机主若坚持单仓库）：放到主仓库子目录 `android-bridge/`，且必须在主仓库
> `tsconfig.app.json` 的 `exclude` 和 `.gitignore` 里隔离，**确保不影响网页 `npm run build`**。
> 默认走独立仓库，除非机主明确说要单仓库。

### 1.2 完整目录树（**严格按这个路径建文件，不要改名、不要乱放**）

```
neko-usage-bridge/
├─ settings.gradle.kts
├─ build.gradle.kts                      # 根 build（plugins 版本声明）
├─ gradle.properties
├─ gradle/
│  └─ wrapper/
│     ├─ gradle-wrapper.properties        # Gradle 8.7+
│     └─ gradle-wrapper.jar
├─ gradlew
├─ gradlew.bat
├─ local.properties.example              # 示例（真 local.properties 不提交，见 §6）
├─ .gitignore                            # 必含 local.properties / *.keystore / build/ / .idea/
├─ README.md                             # 装机 + 权限 + 排错说明（中文，给机主看）
├─ .github/
│  └─ workflows/
│     └─ build-apk.yml                    # CI 自动出 APK（见 §7）
└─ app/
   ├─ build.gradle.kts                   # 模块 build（依赖、BuildConfig、签名）
   ├─ proguard-rules.pro
   └─ src/
      └─ main/
         ├─ AndroidManifest.xml
         ├─ res/
         │  ├─ values/strings.xml         # App 名「Neko Usage Bridge」
         │  ├─ values/themes.xml
         │  ├─ mipmap-*/ic_launcher.*     # 用占位图标即可，别花时间
         │  └─ xml/
         │     └─ network_security_config.xml   # 仅 api.nekopurrs.uk 兜底，TLS 上线后删（§5.5）
         └─ java/uk/nekopurrs/usagebridge/
            ├─ MainActivity.kt            # §2.6 极简状态页（连上没/权限/手动上传/测试连接）
            ├─ ui/StatusScreen.kt         # 状态 UI（Compose 或 XML 都行，极简）
            ├─ collect/UsageCollector.kt  # UsageStatsManager 采集 → 组装 §4 的 payload
            ├─ collect/PermissionGuide.kt # 检测/引导 PACKAGE_USAGE_STATS + 保活引导
            ├─ net/UsageUploader.kt       # POST ingest / ping，带 X-Bridge-Token
            ├─ work/UploadWorker.kt       # WorkManager 周期 + 重试 + 网络恢复补传
            ├─ work/UploadScheduler.kt    # 注册周期任务 / 一次性 expedited 补传
            ├─ data/Payload.kt            # §4 契约的数据类（kotlinx.serialization）
            ├─ data/LocalStore.kt         # 当日 payload 本地兜底（DataStore 或单文件）
            └─ BridgeApp.kt               # Application：初始化 WorkManager 调度
```

**包名固定：`uk.nekopurrs.usagebridge`**。`applicationId` 同此。不要用别的包名。

---

## 2. 技术栈 & 版本（别用过时/魔改写法）

| 项 | 值 |
|---|---|
| 语言 | Kotlin |
| 构建 | Gradle Kotlin DSL（`.kts`），Gradle 8.7+，AGP 8.5+ |
| `minSdk` | **26**（KEYGUARD_HIDDEN 需要 API 26+） |
| `targetSdk` / `compileSdk` | **35**（Android 15 / HyperOS 2） |
| 后台任务 | **WorkManager**（`androidx.work:work-runtime-ktx`），**禁止裸前台服务轮询** |
| 网络 | **OkHttp**（`com.squareup.okhttp3:okhttp`），超时连接 10s / 读 15s |
| 序列化 | **kotlinx.serialization**（payload JSON） |
| 本地存储 | DataStore Preferences 或单个 JSON 文件（当日兜底，按 `date` 覆盖） |
| UI | Jetpack Compose 或 XML 皆可，**极简 1–2 屏**，别花哨 |

依赖尽量少。能用标准库/AndroidX 就别引第三方花活。

---

## 3. 采集逻辑（照 spec §2.1 + §3，别自己发明字段）

> **完整字段语义见 `docs/neko-usage-bridge-spec.md` §3，数据契约见 §4。本节只点关键，不重复契约。**

- **每 App 前台时长**：`UsageStatsManager.queryUsageStats(INTERVAL_DAILY, start, end)` →
  `packageName` / `totalTimeInForeground` / `firstTimeStamp` / `lastTimeStamp` / `lastTimeUsed`。
- **App 名称**：`PackageManager.getApplicationLabel(...)`，中文名优先。
- **解锁次数 / 按小时 / 会话**：`UsageStatsManager.queryEvents(start, end)`：
  - `unlocks` = 数 `KEYGUARD_HIDDEN`（拿不到退化成数屏幕点亮）。
  - `hourly[24]` = 用 `ACTIVITY_RESUMED`/`ACTIVITY_PAUSED` 配对成会话，按**本地小时**切片累加（单位：分钟，index0 = 00:00–01:00）。
  - `sessions[]`（强烈建议）= 同样由 RESUMED/PAUSED 配对，合并 <60s 碎片、只留 ≥30s，带 `category`。
- **`notifications`**：嫌麻烦 v1 直接传 `null`。
- **`category`**：`social|work|entertainment|reading|tool|other`，拿不到给 `null`。

### 时区 / "一天"口径（务必照 spec §4.0）
- 机主时区固定 **`Asia/Kuching`（UTC+8）**，这是切"一天"的唯一基准。
- 所有时间字段用**带时区偏移的 ISO8601**（如 `2026-06-12T23:58:00+08:00`），**不准发裸时间戳**。
- `date` = 机主本地零点切的日期；`[本地 00:00, 次日 00:00)` 内算这天。

---

## 4. 数据契约（**唯一真相在 spec §4，不要在这里另写一份**）

- 上传：`POST https://api.nekopurrs.uk/api/usage/ingest`
  - Header：`Content-Type: application/json`、`X-Bridge-Token: <共享密钥>`
  - Body：**严格按 `docs/neko-usage-bridge-spec.md` §4.1 的 JSON 结构**，`schemaVersion: 1`。
  - `device.owner` = `"neko"`；`device.id` = `"redmi-<稳定唯一串>"`（同机固定，别用会变的东西）。
  - 成功 `200 { ok:true, stored:"<date>" }`；鉴权失败 `401`；体不合法 `400`。
- 连通测试：`POST https://api.nekopurrs.uk/api/usage/ping` → `200 { ok:true, ... }`。

> Codex 实现前**先打开 spec §4** 对照字段，逐字段对齐。`Payload.kt` 的数据类必须和 §4 一一对应。

---

## 5. 权限 / 保活 / 网络（红米最容易翻车的地方，照 spec §2.2–2.5）

1. **`PACKAGE_USAGE_STATS`**（特殊权限）：manifest 声明 `tools:ignore="ProtectedPermissions"`；
   App 内用 `AppOpsManager.checkOpNoThrow(OPSTR_GET_USAGE_STATS, ...)` 检测，没授权显示"去开启"按钮跳
   `Settings.ACTION_USAGE_ACCESS_SETTINGS`。**没权限时不要硬读，否则空数据/崩溃。**
2. `INTERNET` 权限。可选 `RECEIVE_BOOT_COMPLETED`（开机补传）、`POST_NOTIFICATIONS`。
3. **MIUI / HyperOS 保活引导**（首启引导页，跳设置 + 图文步骤）：自启动允许、电池策略设「无限制」、最近任务里锁定 App。
4. **上传调度**（WorkManager）：周期 ~1–2h，约束 `NetworkType.CONNECTED`；失败 `Result.retry()`；
   网络恢复用一次性 expedited 补传；**离线兜底**：当日 payload 先写本地，POST 成功才标记已传。
5. **网络安全**：只走 `https://api.nekopurrs.uk`，**不准用裸 IP、不准明文**。
   `network_security_config.xml` 仅在 TLS 没配好时对该单域临时放行，**TLS 上线立即删**。

---

## 6. 配置 & 密钥（**绝不硬编码，绝不提交**）

- `local.properties`（**不提交**，加进 `.gitignore`）：
  ```
  BRIDGE_TOKEN=<机主给的共享密钥，和 VPS 的 USAGE_BRIDGE_TOKEN 一致>
  VPS_BASE=https://api.nekopurrs.uk
  ```
- `app/build.gradle.kts` 把它们读进 **BuildConfig**：`BuildConfig.BRIDGE_TOKEN`、`BuildConfig.VPS_BASE`。
- 提交一份 `local.properties.example` 占位（值留空），告诉机主怎么填。
- CI 里 `BRIDGE_TOKEN` 用 **GitHub Secret**（仓库 Settings → Secrets → `BRIDGE_TOKEN`），见 §7。
- **token、keystore、任何截图都不准外发或提交。**

---

## 7. APK 怎么出（机主不装开发环境也能拿到包）

在 `.github/workflows/build-apk.yml` 配 GitHub Actions：push 到 `codex/redmi-bridge-v1` 或手动触发时，
**自动构建 debug APK 并作为 artifact 上传**，机主在 Actions 运行页直接下载安装。骨架如下（Codex 按需补全）：

```yaml
name: build-apk
on:
  workflow_dispatch:
  push:
    branches: [ codex/redmi-bridge-v1, main ]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - name: Write local.properties
        run: |
          echo "BRIDGE_TOKEN=${{ secrets.BRIDGE_TOKEN }}" >> local.properties
          echo "VPS_BASE=https://api.nekopurrs.uk" >> local.properties
      - run: chmod +x ./gradlew && ./gradlew assembleDebug --stacktrace
      - uses: actions/upload-artifact@v4
        with:
          name: neko-usage-bridge-debug-apk
          path: app/build/outputs/apk/debug/*.apk
```

> debug APK 够机主自己装。要长期用可后续加签名 release（keystore 走 Secret），v1 先 debug。

---

## 8. 验收标准（照 spec §2.7，逐条自测过才算完成）

- [ ] 未授权时显示"去开启"，**不崩、不传空**。
- [ ] 授权后，手动"立即上传"→ VPS 收到一条符合 **§4 契约**的 JSON（`schemaVersion=1`）。
- [ ] "测试连接"按钮打 `POST /api/usage/ping`，把 VPS 返回**原文显示**出来。
- [ ] 息屏放置 ≥2h 后，WorkManager 仍能自动补传当天数据（可放宽到"充电+WiFi 必传"）。
- [ ] 杀进程 / 重启手机后，下次任务能恢复，**不丢当天数据**。
- [ ] CI（§7）能跑绿、产出可下载的 debug APK。
- [ ] `local.properties`、keystore、token **没有**进入 git 历史。

---

## 9. 给 Codex 的最后叮嘱

1. 先读 `docs/neko-usage-bridge-spec.md` §2、§3、§4 全文，再开工——**那是契约,本文件是施工路径**。
2. 严格按 §1.2 的目录树建文件，**路径/包名/文件名不要自创**。
3. 任何要改契约（§4 字段）的念头，**先停下问机主**，别擅自改。
4. 完成后在 `codex/redmi-bridge-v1` 分支发 PR，PR 描述里贴：CI 构建链接、ping 测试截图（打码 token）、一条真机上传成功的 VPS 返回。
5. 不确定的地方**问机主**，不要猜着乱写。
</content>
</invoke>
