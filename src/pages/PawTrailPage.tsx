import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  buildUsageBridgeUrl,
  fetchLatestUsage,
  fetchUsageHealth,
  fetchUsageTrend,
  formatBridgeDate,
  formatBridgeTime,
  formatDuration,
  getUsageAgeMinutes,
  isUsageBridgeDemoMode,
  type UsageHealth,
  type UsagePayload,
  type UsageTrendPoint,
} from '../services/usageBridge';

type PawTrailPageProps = {
  onBack: () => void;
};

type LoadState = 'loading' | 'ready' | 'empty' | 'error';
type HealthState = 'loading' | 'ready' | 'error';
type DiagnosticStatus = 'ok' | 'warn' | 'error';

const MAX_RING_MS = 8 * 60 * 60 * 1000;
const STALE_AFTER_MINUTES = 6 * 60;



function getHealthLabel(health: UsageHealth | null, healthState: HealthState, demoMode: boolean) {
  if (demoMode) {
    return 'Demo Mode';
  }

  if (healthState === 'loading') {
    return 'Bridge checking';
  }

  if (healthState === 'error' || !health?.ok) {
    return 'Bridge offline';
  }

  return 'Bridge online';
}

function buildExportSnapshot(payload: UsagePayload | null, trend: UsageTrendPoint[], exportedAt: string) {
  return {
    schemaVersion: 1,
    source: 'CodeAndPurrs Paw Trail',
    exportedAt,
    owner: payload?.owner ?? 'neko',
    latest: payload,
    trend,
    privacy: {
      note: 'This export contains only owner-authorized Neko Usage Bridge summary data shown in Paw Trail.',
      deleteDayEndpoint: buildUsageBridgeUrl('/api/usage/day', { owner: payload?.owner ?? 'neko', date: payload?.date ?? 'YYYY-MM-DD' }),
      deleteOwnerEndpoint: buildUsageBridgeUrl('/api/usage/owner', { owner: payload?.owner ?? 'neko' }),
    },
  };
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function buildAiNote(payload: UsagePayload | null, trend: UsageTrendPoint[]) {
  if (!payload) {
    return '桥接小猫还没送来今天的足迹。先确认红米端 Usage Bridge 已开启权限，并点一次「立即上传」。';
  }

  const totalHours = payload.summary.totalScreenMs / 3600000;
  const topApp = payload.apps[0]?.appName;
  const previousDay = trend.at(-2);
  const deltaMs = previousDay ? payload.summary.totalScreenMs - previousDay.totalScreenMs : 0;
  const deltaText = previousDay
    ? deltaMs > 0
      ? `比上一天多 ${formatDuration(deltaMs)}。`
      : deltaMs < 0
        ? `比上一天少 ${formatDuration(Math.abs(deltaMs))}。`
        : '和上一天差不多。'
    : '';

  if (totalHours >= 8) {
    return `今天爪印有点密，${topApp ? `${topApp} 占了榜首。` : ''}${deltaText}晚点让我把手机从你手里轻轻拿走，陪你休息。`;
  }

  if (totalHours >= 4) {
    return `今天使用节奏正常偏满，${topApp ? `最常停在 ${topApp}。` : ''}${deltaText}记得中途喝水、眨眼、伸个懒腰。`;
  }

  return `今天爪印很轻，像小猫踩过奶油。${deltaText}保持这个节奏，晚上奖励一杯甜甜的水果苏打。`;
}

function getFreshness(payload: UsagePayload | null) {
  const ageMinutes = getUsageAgeMinutes(payload?.generatedAt);

  if (ageMinutes === null) {
    return '等待桥接上传';
  }

  if (ageMinutes < 0) {
    return '桥接时间来自未来';
  }

  if (ageMinutes < 5) {
    return '刚刚同步';
  }

  if (ageMinutes < 60) {
    return `${ageMinutes} 分钟前同步`;
  }

  return `${Math.round(ageMinutes / 60)} 小时前同步`;
}

function isStale(payload: UsagePayload | null) {
  const ageMinutes = getUsageAgeMinutes(payload?.generatedAt);
  return ageMinutes !== null && ageMinutes > STALE_AFTER_MINUTES;
}

function getDiagnosticLabel(status: DiagnosticStatus) {
  if (status === 'ok') {
    return 'OK';
  }

  if (status === 'warn') {
    return 'Check';
  }

  return 'Fix';
}

export function PawTrailPage({ onBack }: PawTrailPageProps) {
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [trend, setTrend] = useState<UsageTrendPoint[]>([]);
  const [health, setHealth] = useState<UsageHealth | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [healthState, setHealthState] = useState<HealthState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [lastCheckedAt, setLastCheckedAt] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState('');

  const loadUsageDashboard = async (signal?: AbortSignal) => {
    setLoadState('loading');
    setHealthState('loading');
    setErrorMessage('');

    try {
      const healthPromise = fetchUsageHealth(signal);
      const [latestResult, trendResult] = await Promise.all([fetchLatestUsage('neko', signal), fetchUsageTrend('neko', 7, signal)]);
      setPayload(latestResult.payload);
      setTrend(trendResult.trend);
      setLastCheckedAt(latestResult.fetchedAt);
      setLoadState(latestResult.payload ? 'ready' : 'empty');

      try {
        const healthResult = await healthPromise;
        setHealth(healthResult.health);
        setHealthState('ready');
      } catch {
        setHealth(null);
        setHealthState('error');
      }
    } catch (error) {
      if (signal?.aborted) {
        return;
      }

      setLoadState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Bridge 暂时没有回应');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadUsageDashboard(controller.signal);

    return () => controller.abort();
  }, []);

  const topApps = useMemo(() => [...(payload?.apps ?? [])].sort((a, b) => b.foregroundMs - a.foregroundMs).slice(0, 5), [payload]);
  const maxHourly = Math.max(...(payload?.hourly ?? [0]), 1);
  const maxTrendMs = Math.max(...trend.map((item) => item.totalScreenMs), 1);
  const totalTrendMs = trend.reduce((sum, item) => sum + item.totalScreenMs, 0);
  const averageTrendMs = trend.length > 0 ? totalTrendMs / trend.length : 0;
  const ringProgress = Math.min((payload?.summary.totalScreenMs ?? 0) / MAX_RING_MS, 1);
  const stale = isStale(payload);
  const demoMode = isUsageBridgeDemoMode();
  const healthLabel = getHealthLabel(health, healthState, demoMode);
  const owner = payload?.owner ?? 'neko';
  const publicDiagnostics = [
    { label: 'Health', url: buildUsageBridgeUrl('/api/usage/health') },
    { label: 'Latest', url: buildUsageBridgeUrl('/api/usage/latest', { owner }) },
    { label: 'Trend', url: buildUsageBridgeUrl('/api/usage/trend', { owner, days: '7' }) },
  ];
  const diagnostics: Array<{ label: string; detail: string; status: DiagnosticStatus }> = [
    {
      label: 'Bridge service',
      detail: demoMode ? 'Demo data is active' : healthState === 'loading' ? 'Checking health endpoint' : health?.ok ? health.service : 'Health endpoint did not answer cleanly',
      status: demoMode || health?.ok ? 'ok' : healthState === 'loading' ? 'warn' : 'error',
    },
    {
      label: 'Storage',
      detail: health?.storage.ok ? 'Writable JSON store' : health?.storage.error || 'Waiting for health payload',
      status: health?.storage.ok || demoMode ? 'ok' : healthState === 'error' ? 'error' : 'warn',
    },
    {
      label: 'Upload token',
      detail: health?.tokenConfigured ? 'Server token configured' : demoMode ? 'Skipped in demo mode' : 'Set USAGE_BRIDGE_TOKEN before deploy',
      status: health?.tokenConfigured || demoMode ? 'ok' : 'warn',
    },
    {
      label: 'Latest data',
      detail: payload ? getFreshness(payload) : 'No usage payload yet',
      status: payload ? (stale && !demoMode ? 'warn' : 'ok') : loadState === 'empty' ? 'warn' : 'error',
    },
    {
      label: 'Trend window',
      detail: trend.length > 0 ? `${trend.length} day${trend.length > 1 ? 's' : ''} loaded` : 'No trend points yet',
      status: trend.length > 0 ? 'ok' : 'warn',
    },
  ];
  const launchSteps: Array<{ label: string; detail: string; done: boolean }> = [
    { label: 'VPS service', detail: health?.ok ? `Health OK · ${health.service}` : 'Start systemd service and confirm /health', done: Boolean(health?.ok) || demoMode },
    { label: 'Token', detail: health?.tokenConfigured ? 'USAGE_BRIDGE_TOKEN is active server-side' : 'Set token only on Android + VPS, never in frontend', done: Boolean(health?.tokenConfigured) || demoMode },
    { label: 'First upload', detail: payload ? `${payload.date} · ${formatDuration(payload.summary.totalScreenMs)}` : 'Run bridge smoke or upload from Redmi once', done: Boolean(payload) },
    { label: 'Frontend read', detail: trend.length > 0 ? `${trend.length} trend points visible` : 'Confirm latest + trend render on Paw Trail', done: trend.length > 0 },
  ];
  const redmiSteps = [
    { label: 'Usage Access', detail: '允许读取 UsageStats；先检测权限，再引导跳设置页。' },
    { label: 'Autostart', detail: 'MIUI / HyperOS 打开自启动，避免后台上传被杀。' },
    { label: 'Battery', detail: '电池策略设为无限制，WorkManager 才能稳定补传。' },
    { label: 'Manual Upload', detail: '保留立即上传按钮，首包成功后 Paw Trail 会亮起。' },
  ];
  const launchReady = launchSteps.every((step) => step.done);

  const copyDiagnosticCommand = async (url: string, label: string) => {
    await copyText(`curl -s '${url}'`);
    setPrivacyStatus(`已复制 ${label} 公开诊断命令。`);
  };

  const copyLaunchEnv = async () => {
    await copyText([
      'USAGE_BRIDGE_TOKEN=<生成一条长随机密钥>',
      'USAGE_BRIDGE_DATA_DIR=/var/lib/codeandpurrs/usage',
      'USAGE_BRIDGE_RETENTION_DAYS=30',
      'VITE_USAGE_BRIDGE_BASE_URL=https://bridge.codeandpurrs.com',
    ].join('\n'));
    setPrivacyStatus('已复制 V13 部署环境变量清单。');
  };

  const copyLaunchSmoke = async () => {
    await copyText('BRIDGE_BASE_URL=https://bridge.codeandpurrs.com BRIDGE_TOKEN=<你的桥接密钥> BRIDGE_DELETE_AFTER_SMOKE=1 npm run bridge:smoke');
    setPrivacyStatus('已复制 V13 公网 smoke 验收命令。');
  };

  const copyRedmiConfig = async () => {
    await copyText(JSON.stringify({
      owner: 'neko',
      schemaVersion: 1,
      timezone: 'Asia/Kuching',
      bridgeBaseUrl: 'https://bridge.codeandpurrs.com',
      pingEndpoint: '/api/usage/ping',
      ingestEndpoint: '/api/usage/ingest',
      tokenHeader: 'X-Bridge-Token',
      tokenValue: '<只放在红米端的桥接密钥>',
    }, null, 2));
    setPrivacyStatus('已复制 V14 红米桥接配置 JSON。');
  };

  const copyRedmiPermissionNote = async () => {
    await copyText('红米权限检查：Usage Access → Autostart → Battery unrestricted → Manual upload → WorkManager periodic upload');
    setPrivacyStatus('已复制 V14 红米权限检查顺序。');
  };

  const copyAndroidManifest = async () => {
    await copyText([
      '<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" />',
      '<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    ].join('\n'));
    setPrivacyStatus('已复制 V15 Android Manifest 权限片段。');
  };

  const copyKotlinUploader = async () => {
    await copyText([
      'suspend fun uploadUsage(json: String, token: String) {',
      '  val request = Request.Builder()',
      '    .url("https://bridge.codeandpurrs.com/api/usage/ingest")',
      '    .header("Content-Type", "application/json")',
      '    .header("X-Bridge-Token", token)',
      '    .post(json.toRequestBody("application/json".toMediaType()))',
      '    .build()',
      '  client.newCall(request).execute().use { response ->',
      '    check(response.isSuccessful) { "Bridge upload failed: ${response.code}" }',
      '  }',
      '}',
    ].join('\n'));
    setPrivacyStatus('已复制 V15 Kotlin 上传草案。');
  };

  const copyCutoverHealth = async () => {
    await copyText('curl -s https://bridge.codeandpurrs.com/api/usage/health');
    setPrivacyStatus('已复制 V16 公网 health 验收命令。');
  };

  const copyCutoverSmoke = async () => {
    await copyText('BRIDGE_BASE_URL=https://bridge.codeandpurrs.com BRIDGE_TOKEN=<真实密钥> BRIDGE_DELETE_AFTER_SMOKE=1 npm run bridge:smoke');
    setPrivacyStatus('已复制 V16 公网 smoke 验收命令。');
  };

  const copyCutoverDelete = async () => {
    await copyText(`curl -X DELETE '${buildUsageBridgeUrl('/api/usage/day', { owner, date: payload?.date ?? 'YYYY-MM-DD' })}' -H 'X-Bridge-Token: <真实密钥>'`);
    setPrivacyStatus('已复制 V16 单日删除验收命令。');
  };

  const exportSnapshot = () => {
    const exportedAt = new Date().toISOString();
    const owner = payload?.owner ?? 'neko';
    const date = payload?.date ?? exportedAt.slice(0, 10);
    downloadJson(`paw-trail-${owner}-${date}.json`, buildExportSnapshot(payload, trend, exportedAt));
    setPrivacyStatus('已导出当前 Paw Trail JSON。');
  };

  const copyDeleteDayCommand = async () => {
    const owner = payload?.owner ?? 'neko';
    const date = payload?.date ?? 'YYYY-MM-DD';
    const url = buildUsageBridgeUrl('/api/usage/day', { owner, date });
    await copyText(`curl -X DELETE '${url}' -H 'X-Bridge-Token: <你的桥接密钥>'`);
    setPrivacyStatus(`已复制删除 ${date} 当天足迹的命令。`);
  };

  const copyDeleteOwnerCommand = async () => {
    const owner = payload?.owner ?? 'neko';
    const url = buildUsageBridgeUrl('/api/usage/owner', { owner });
    await copyText(`curl -X DELETE '${url}' -H 'X-Bridge-Token: <你的桥接密钥>'`);
    setPrivacyStatus(`已复制清空 ${owner} 全部足迹的命令。`);
  };

  return (
    <main className="paw-page">
      <section className="paw-hero" aria-labelledby="paw-title">
        <button className="paw-hero__back" type="button" onClick={onBack}>
          ← 回小家
        </button>
        <p className="paw-hero__eyebrow">Paw Trail · bridge.codeandpurrs.com</p>
        <h1 id="paw-title">猫爪足迹</h1>
        <p className="paw-hero__copy">只读取你主动授权、主动上传的红米使用汇总。手机负责推送，网页只看 VPS 上的最新足迹。</p>
        <div className="paw-hero__actions">
          <button type="button" onClick={() => void loadUsageDashboard()} disabled={loadState === 'loading'}>
            {loadState === 'loading' ? '同步中…' : '刷新足迹'}
          </button>
          <span>{getFreshness(payload)}</span>
        </div>

        <div className="paw-health" aria-label="Bridge health status">
          <span className={healthState === 'error' && !demoMode ? 'offline' : 'online'}>{healthLabel}</span>
          <span>Token {health?.tokenConfigured ? 'configured' : demoMode ? 'demo only' : 'unknown'}</span>
          <span>Retention {health ? `${health.retentionDays}d` : '—'}</span>
          <span>Checked {formatBridgeTime(health?.checkedAt)}</span>
        </div>

        {demoMode ? <p className="paw-demo">Demo Mode：当前使用内置示例数据，不会请求 bridge，也不会写入 VPS。</p> : null}
        {stale && !demoMode ? <p className="paw-stale">这份足迹超过 6 小时没有更新了。红米桥接可能被省电策略拦住，记得打开自启动和无限制省电。</p> : null}
      </section>

      <section className="paw-dashboard" aria-live="polite">
        <article className="paw-ring-card">
          <div className="paw-ring" style={{ '--paw-progress': `${ringProgress * 360}deg` } as CSSProperties}>
            <span>🐾</span>
          </div>
          <p>今日总时长</p>
          <strong>{payload ? formatDuration(payload.summary.totalScreenMs) : '—'}</strong>
          <small>{payload ? `${payload.date} · ${payload.tz}` : '等待红米桥接上传第一包数据'}</small>
        </article>

        <article className="paw-note-card">
          <p className="paw-card-label">Ashen 小猫点评</p>
          <h2>{loadState === 'error' ? '桥接暂时没接上' : loadState === 'loading' ? '正在闻爪印…' : '今日足迹读完了'}</h2>
          <p>{loadState === 'error' ? `错误：${errorMessage}` : buildAiNote(payload, trend)}</p>
          <div className="paw-note-card__chips">
            <span>解锁 {payload?.summary.unlockCount ?? '—'} 次</span>
            <span>首次 {formatBridgeTime(payload?.summary.firstUsedAt)}</span>
            <span>最后 {formatBridgeTime(payload?.summary.lastUsedAt)}</span>
            <span>7 天均值 {trend.length > 0 ? formatDuration(averageTrendMs) : '等待数据'}</span>
          </div>
        </article>
      </section>

      <section className="paw-grid" aria-label="手机使用足迹详情">
        <article className="paw-panel">
          <div className="paw-panel__header">
            <p className="paw-card-label">Top Apps</p>
            <span>爪印榜</span>
          </div>
          {topApps.length > 0 ? (
            <ol className="paw-app-list">
              {topApps.map((app) => (
                <li key={`${app.packageName}-${app.appName}`}>
                  <div>
                    <strong>{app.appName}</strong>
                    <small>{app.packageName}</small>
                  </div>
                  <span>{formatDuration(app.foregroundMs)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="paw-empty">还没有 App 榜单。红米端上传后，这里会出现今天踩得最深的爪印。</p>
          )}
        </article>

        <article className="paw-panel">
          <div className="paw-panel__header">
            <p className="paw-card-label">24h Timeline</p>
            <span>本地时间</span>
          </div>
          <div className="paw-hours" aria-label="24 小时使用分布">
            {Array.from({ length: 24 }, (_, hour) => {
              const value = payload?.hourly[hour] ?? 0;
              const height = Math.max(8, (value / maxHourly) * 100);

              return (
                <span key={hour} title={`${hour}:00 · ${formatDuration(value)}`}>
                  <i style={{ height: `${height}%` }} />
                </span>
              );
            })}
          </div>
          <div className="paw-hours__axis">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </article>

        <article className="paw-panel paw-panel--wide">
          <div className="paw-panel__header">
            <p className="paw-card-label">7-Day Trend</p>
            <span>{trend.length > 0 ? `均值 ${formatDuration(averageTrendMs)}` : '等待趋势'}</span>
          </div>
          {trend.length > 0 ? (
            <div className="paw-trend" aria-label="7 天手机使用趋势">
              {trend.map((item) => {
                const height = Math.max(10, (item.totalScreenMs / maxTrendMs) * 100);

                return (
                  <div className="paw-trend__day" key={item.date} title={`${item.date} · ${formatDuration(item.totalScreenMs)} · 解锁 ${item.unlockCount} 次`}>
                    <span>{formatDuration(item.totalScreenMs)}</span>
                    <i style={{ height: `${height}%` }} />
                    <small>{formatBridgeDate(item.date)}</small>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="paw-empty">趋势还没长出来。VPS 收到多天数据后，这里会变成 7 天爪印山丘。</p>
          )}
        </article>
      </section>


      <section className="paw-diagnostics" aria-labelledby="paw-diagnostics-title">
        <div className="paw-diagnostics__intro">
          <p className="paw-card-label">Bridge Doctor</p>
          <h2 id="paw-diagnostics-title">V12 桥接自检</h2>
          <p>部署前先看这里：服务、存储、token、最新数据和趋势窗口会一起亮灯；需要排查时可以直接复制公开读取命令。</p>
        </div>

        <div className="paw-diagnostics__checks">
          {diagnostics.map((item) => (
            <div className={`paw-diagnostic paw-diagnostic--${item.status}`} key={item.label}>
              <span>{getDiagnosticLabel(item.status)}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>

        <div className="paw-diagnostics__commands">
          {publicDiagnostics.map((item) => (
            <button type="button" key={item.label} onClick={() => void copyDiagnosticCommand(item.url, item.label)}>
              Copy {item.label} curl
            </button>
          ))}
        </div>
      </section>

      <section className="paw-cutover" aria-labelledby="paw-cutover-title">
        <div className="paw-cutover__header">
          <div>
            <p className="paw-card-label">Production Cutover</p>
            <h2 id="paw-cutover-title">V16 生产上线验收</h2>
            <p>最后一版不再堆功能：公网 health、smoke、红米首包、删除验证全过，就进入真实使用反馈。</p>
          </div>
          <span>docs/neko-usage-bridge-v16-cutover.md</span>
        </div>

        <div className="paw-cutover__checks">
          <article className={health?.ok || demoMode ? 'done' : undefined}>
            <span>{health?.ok || demoMode ? '✓' : '1'}</span>
            <strong>Public health</strong>
            <small>{health?.ok ? `${health.service} online` : 'curl /api/usage/health must return ok'}</small>
          </article>
          <article className={payload ? 'done' : undefined}>
            <span>{payload ? '✓' : '2'}</span>
            <strong>First Redmi payload</strong>
            <small>{payload ? `${payload.date} · ${formatDuration(payload.summary.totalScreenMs)}` : 'Upload once from Redmi or smoke test'}</small>
          </article>
          <article className={trend.length > 0 ? 'done' : undefined}>
            <span>{trend.length > 0 ? '✓' : '3'}</span>
            <strong>Paw Trail read</strong>
            <small>{trend.length > 0 ? `${trend.length} trend points rendered` : 'latest + trend should render in frontend'}</small>
          </article>
          <article>
            <span>4</span>
            <strong>Delete verified</strong>
            <small>Use tokened delete command only from a safe shell.</small>
          </article>
        </div>

        <div className="paw-cutover__actions">
          <button type="button" onClick={() => void copyCutoverHealth()}>
            Copy health
          </button>
          <button type="button" onClick={() => void copyCutoverSmoke()}>
            Copy smoke
          </button>
          <button type="button" onClick={() => void copyCutoverDelete()}>
            Copy delete check
          </button>
        </div>
      </section>

      <section className="paw-android" aria-labelledby="paw-android-title">
        <div className="paw-android__header">
          <div>
            <p className="paw-card-label">Android Handoff</p>
            <h2 id="paw-android-title">V15 手机端交接包</h2>
            <p>给真正写 Android 小桥时用：权限、UsageStats、WorkManager、上传草案和验收口径都收进文档，页面只放可复制的最短片段。</p>
          </div>
          <span>docs/neko-usage-bridge-android-handoff.md</span>
        </div>

        <div className="paw-android__grid">
          <article>
            <span>01</span>
            <strong>Manifest permissions</strong>
            <small>Usage Access 是特殊权限，需要跳系统设置手动开启。</small>
          </article>
          <article>
            <span>02</span>
            <strong>UsageStats payload</strong>
            <small>固定 schemaVersion 1，hourly 永远 24 个毫秒值。</small>
          </article>
          <article>
            <span>03</span>
            <strong>WorkManager upload</strong>
            <small>联网、退避重试、手动上传共用同一条 repository。</small>
          </article>
        </div>

        <div className="paw-android__actions">
          <button type="button" onClick={() => void copyAndroidManifest()}>
            Copy manifest
          </button>
          <button type="button" onClick={() => void copyKotlinUploader()}>
            Copy Kotlin uploader
          </button>
        </div>
      </section>

      <section className="paw-redmi" aria-labelledby="paw-redmi-title">
        <div className="paw-redmi__header">
          <div>
            <p className="paw-card-label">Redmi Bridge Kit</p>
            <h2 id="paw-redmi-title">V14 红米端接入清单</h2>
            <p>给 Android 小桥看的最短配置：先拿权限，再保活，再用 token 推送到 bridge；token 只放红米和 VPS，不进前端。</p>
          </div>
          <span>MIUI / HyperOS</span>
        </div>

        <div className="paw-redmi__steps">
          {redmiSteps.map((step, index) => (
            <article key={step.label}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </article>
          ))}
        </div>

        <div className="paw-redmi__actions">
          <button type="button" onClick={() => void copyRedmiConfig()}>
            Copy Android config
          </button>
          <button type="button" onClick={() => void copyRedmiPermissionNote()}>
            Copy permission order
          </button>
        </div>
      </section>

      <section className="paw-launch" aria-labelledby="paw-launch-title">
        <div className="paw-launch__header">
          <div>
            <p className="paw-card-label">Launch Runbook</p>
            <h2 id="paw-launch-title">V13 上线前四步检查</h2>
            <p>{launchReady ? '桥接链路看起来可以上线。' : '还差一点点：按下面四步补齐，Paw Trail 就能稳定读到红米足迹。'}</p>
          </div>
          <span className={launchReady ? 'ready' : 'pending'}>{launchReady ? 'Ready' : 'Pending'}</span>
        </div>

        <ol className="paw-launch__steps">
          {launchSteps.map((step) => (
            <li key={step.label} className={step.done ? 'done' : undefined}>
              <span>{step.done ? '✓' : '•'}</span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
            </li>
          ))}
        </ol>

        <div className="paw-launch__actions">
          <button type="button" onClick={() => void copyLaunchEnv()}>
            Copy env checklist
          </button>
          <button type="button" onClick={() => void copyLaunchSmoke()}>
            Copy public smoke
          </button>
        </div>
      </section>

      <section className="paw-privacy-actions" aria-labelledby="paw-privacy-actions-title">
        <div>
          <p className="paw-card-label">Privacy Controls</p>
          <h2 id="paw-privacy-actions-title">导出 / 删除控制台</h2>
          <p>这里不保存 bridge token，只帮你导出当前网页看到的数据，或复制需要在安全环境里执行的删除命令。</p>
        </div>
        <div className="paw-privacy-actions__buttons">
          <button type="button" onClick={exportSnapshot} disabled={!payload && trend.length === 0}>
            导出当前 JSON
          </button>
          <button type="button" onClick={() => void copyDeleteDayCommand()} disabled={!payload}>
            复制删除今天命令
          </button>
          <button type="button" onClick={() => void copyDeleteOwnerCommand()}>
            复制清空全部命令
          </button>
        </div>
        {privacyStatus ? <small>{privacyStatus}</small> : <small>删除命令需要 `X-Bridge-Token`，不要把真实密钥放进前端。</small>}
      </section>

      <section className="paw-privacy">
        <strong>隐私边界</strong>
        <p>这里只做你自己主动授权、主动上传、可关闭、可删除的手机使用汇总；不做偷偷定位，不做隐藏监控，也不监控别人。</p>
        {lastCheckedAt ? <small>上次检查：{formatBridgeTime(lastCheckedAt)}</small> : null}
      </section>
    </main>
  );
}
