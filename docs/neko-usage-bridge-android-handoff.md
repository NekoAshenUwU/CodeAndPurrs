# Neko Usage Bridge V15｜Android / Redmi 端交接清单

这份文档给红米 / MIUI / HyperOS 桥接 App 使用。目标是把手机端实现拆成可落地的最小闭环：权限检测、UsageStats 汇总、payload 组装、WorkManager 上传、手动上传与诊断。

## 1. 最小功能闭环

1. 启动时检测 `PACKAGE_USAGE_STATS` 是否已授权。
2. 未授权时引导打开 `Settings.ACTION_USAGE_ACCESS_SETTINGS`。
3. 已授权时按本地日期读取当天 `UsageStatsManager` 数据。
4. 汇总为 `schemaVersion: 1` payload。
5. 先调用 `POST /api/usage/ping` 验 token 和网络。
6. 再调用 `POST /api/usage/ingest` 上传当天数据。
7. 上传成功后记录 `lastUploadAt` 和 `lastPayloadDate`。
8. WorkManager 每 3～6 小时补传一次；UI 保留「立即上传」。

## 2. Android Manifest 要点

```xml
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

`PACKAGE_USAGE_STATS` 是特殊权限，不能用普通 runtime permission 弹窗申请，必须跳系统 Usage Access 设置页让用户手动开启。

## 3. 本地安全配置

Android 端只保存 bridge 配置，不把 token 暴露给 WebView / 前端页面。

```json
{
  "owner": "neko",
  "timezone": "Asia/Kuching",
  "bridgeBaseUrl": "https://bridge.codeandpurrs.com",
  "tokenHeader": "X-Bridge-Token",
  "tokenValue": "<只保存在 Android 端的长随机密钥>"
}
```

建议 token 放在 Android Keystore 加密后的 SharedPreferences / DataStore 中；调试日志必须打码。

## 4. Kotlin 数据结构草案

```kotlin
data class UsageBridgePayload(
  val schemaVersion: Int = 1,
  val owner: String,
  val date: String,
  val tz: String,
  val generatedAt: String,
  val summary: UsageSummary,
  val apps: List<UsageApp>,
  val hourly: List<Long>
)

data class UsageSummary(
  val totalScreenMs: Long,
  val unlockCount: Int,
  val firstUsedAt: String?,
  val lastUsedAt: String?
)

data class UsageApp(
  val packageName: String,
  val appName: String,
  val foregroundMs: Long,
  val lastUsedAt: String?
)
```

## 5. 采集建议

- `queryUsageStats(INTERVAL_DAILY, startMs, endMs)`：汇总 App 前台时长。
- `queryEvents(startMs, endMs)`：补小时分布、首次/最后使用、解锁次数。
- 小时数组固定 24 个元素，单位毫秒；缺失小时填 `0`。
- 日期使用马来西亚本地口径，亚庇优先 `Asia/Kuching`。
- 上传前按 `foregroundMs` 倒序，只保留有实际使用时长的 App。

## 6. 上传流程草案

```kotlin
suspend fun uploadUsage(payload: UsageBridgePayload, token: String) {
  val client = OkHttpClient()
  val json = moshi.adapter(UsageBridgePayload::class.java).toJson(payload)
  val request = Request.Builder()
    .url("https://bridge.codeandpurrs.com/api/usage/ingest")
    .header("Content-Type", "application/json")
    .header("X-Bridge-Token", token)
    .post(json.toRequestBody("application/json".toMediaType()))
    .build()

  client.newCall(request).execute().use { response ->
    if (!response.isSuccessful) error("Bridge upload failed: ${response.code}")
  }
}
```

## 7. WorkManager 策略

- `ExistingPeriodicWorkPolicy.UPDATE`：避免重复 worker。
- `NetworkType.CONNECTED`：只在有网络时上传。
- 失败后让 WorkManager 指数退避重试。
- Worker 内先检查 Usage Access；没权限直接返回 `Result.failure()` 并让 UI 显示「去开权限」。
- 手动上传按钮可以走同一条 repository 方法，不另写一套上传逻辑。

## 8. MIUI / HyperOS 用户引导文案

- 使用情况访问：允许 CodeAndPurrs Bridge 读取 App 使用情况。
- 自启动：允许桥接 App 开机后恢复定时上传。
- 省电策略：设为无限制，避免 WorkManager 被系统杀掉。
- 最近任务锁定：调试期建议锁定，正式版不强依赖。

## 9. 验收口径

手机端完成后，按下面顺序验收：

1. 点「测试连接」返回 bridge `ping ok`。
2. 点「立即上传」返回 `201`，并显示上传日期。
3. 访问 `https://bridge.codeandpurrs.com/api/usage/latest?owner=neko` 能看到当天 payload。
4. Paw Trail 页面刷新后，今日总时长、Top Apps、24h timeline 和 Bridge Doctor 都正常。
5. 关闭 App，等待 WorkManager 周期上传；如果超过 6 小时未更新，检查自启动和省电策略。
