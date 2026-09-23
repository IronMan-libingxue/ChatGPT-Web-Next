import { useEffect, useMemo, useState } from 'react'
import type {
  DownloadRecord,
  LogoId,
  ToolbarState,
  WorkLight
} from '../../shared/types'
import { formatZonedTime } from '../../shared/time'
import logo043714 from './assets/logo-043714.png'
import logo121805 from './assets/logo-121805.png'
import logo122825 from './assets/logo-122825.png'
import logo123336 from './assets/logo-123336.png'
import logo124106 from './assets/logo-124106.png'

const view = new URLSearchParams(window.location.search).get('view') ?? 'toolbar'
document.documentElement.dataset.view = view
const logoSources: Record<LogoId, string> = {
  'logo-043714': logo043714,
  'logo-121805': logo121805,
  'logo-122825': logo122825,
  'logo-123336': logo123336,
  'logo-124106': logo124106
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<ToolbarState | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    void window.chatgptWebNext.getState().then(setState)
    return window.chatgptWebNext.onState(setState)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 250)
    return () => window.clearInterval(timer)
  }, [])

  if (!state) return <div className="loading">正在准备客户端…</div>
  if (view === 'settings') return <Settings state={state} now={now} />
  if (view === 'downloads') return <DownloadsPanel state={state} />
  return <Toolbar state={state} now={now} />
}

function Toolbar({ state, now }: { state: ToolbarState; now: Date }): React.JSX.Element {
  const location = [state.network.country, state.network.city].filter(Boolean).join(' · ')
  const currentTime = formatZonedTime(now, state.network.timezone)
  const networkClass = `freshness-${state.network.freshness}`
  const remaining = currentWorkRemaining(state, now)
  const safetyRemaining = currentSafetyRemaining(state)

  return (
    <main className="app-shell" data-window-kind={state.windowKind}>
      <div className="toolbar">
        <div className="toolbar-left">
          <img
            className="app-mark"
            src={logoSources[state.preferences.selectedLogoId]}
            aria-label="ChatGPT Web Next"
          />
          <button
            className="icon-button"
            onClick={() => void window.chatgptWebNext.refresh()}
            title="刷新 ChatGPT 页面（⌘R）"
          >
            ↻
          </button>
          <button
            className="text-button"
            onClick={() => void window.chatgptWebNext.newIncognito()}
            title="打开独立无痕窗口"
          >
            ◌ 无痕
          </button>
          <button
            className="icon-button"
            onClick={() => void window.chatgptWebNext.openSettings()}
            title="设置与详细状态"
          >
            ⚙
          </button>
          {state.windowKind === 'incognito' && <span className="incognito-badge">独立无痕</span>}
        </div>

        <div className="toolbar-statuses">
          {state.safety.phase !== 'none' && (
            <button
              className="safety-chip"
              onClick={() => void window.chatgptWebNext.openSettings()}
              title="此安全倒计时不可取消或延后"
            >
              {state.safety.phase === 'cleared'
                ? `${safetyRemaining.quit}s 后退出`
                : `${safetyRemaining.clear}s 后清理 · ${safetyRemaining.quit}s 后退出`}
            </button>
          )}

          <button
            className={`status-chip work-chip light-${state.work.light}`}
            onClick={() => void window.chatgptWebNext.openSettings()}
            title={state.work.message}
          >
            <span className="status-dot" />
            <span>工作状态</span>
            {state.work.light === 'active' && <span className="subtle">{formatRemaining(remaining)}</span>}
          </button>

          <button
            className="download-button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              void window.chatgptWebNext.toggleDownloads({
                right: rect.right,
                bottom: rect.bottom
              })
            }}
            title="下载管理"
            aria-haspopup="dialog"
          >
            ⇩
            {state.downloads.totalCount > 0 && <span>{state.downloads.totalCount}</span>}
          </button>

          <button
            className={`status-chip latency-chip ${networkClass}`}
            onClick={() => void window.chatgptWebNext.refreshNetwork()}
            title="ChatGPT 响应延迟；点击后连续检测三次"
          >
            {state.network.latencyMs === null
              ? (state.network.checking ? '检测中' : '-- ms')
              : `${state.network.latencyMs} ms`}
          </button>

          <button
            className={`status-chip network-chip ${networkClass}`}
            onClick={() => void window.chatgptWebNext.refreshNetwork()}
            title={networkTitle(state)}
          >
            <span className="ip-value">{state.network.ip ?? 'IP 无法确认'}</span>
            {state.network.freshness !== 'live' && <span className="warning-mark">!</span>}
          </button>

          <div className="location-block" title={state.network.locationError ?? 'IP 估计位置与时区'}>
            <span className="location-value">{location || '位置未知'}</span>
            <span className="subtle">{state.network.timezone ?? '时区未知'}{state.network.locationError ? ' !' : ''}</span>
          </div>
          <div className="clock" aria-label="IP 时区当前时间">{currentTime}</div>
        </div>
      </div>

      {state.safety.loginBlocked && (
        <section className="blocked-page" role="alert">
          <img src={logoSources[state.preferences.selectedLogoId]} alt="" />
          <h1>账号状态异常，请稍后重试</h1>
          <p>APP 将在 {safetyRemaining.quit} 秒后自动退出。</p>
        </section>
      )}
    </main>
  )
}

function DownloadsPanel({ state }: { state: ToolbarState }): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null)
  const reveal = async (id: string): Promise<void> => {
    const result = await window.chatgptWebNext.revealDownload(id)
    if (result === 'missing') setMessage('文件不存在，可能已被移动或删除。')
  }
  const openAll = async (): Promise<void> => {
    await window.chatgptWebNext.openSettings()
    await window.chatgptWebNext.closeDownloads()
  }

  return (
    <main className="downloads-panel" role="dialog" aria-label="下载管理">
      <header>
        <h2>最近的下载记录</h2>
        <button
          className="icon-button"
          onClick={() => void window.chatgptWebNext.closeDownloads()}
          aria-label="关闭下载管理"
        >
          ×
        </button>
      </header>
      {message && <p className="inline-error">{message}</p>}
      {state.downloads.recent.length === 0 ? (
        <p className="empty-state">暂无下载记录</p>
      ) : (
        <div className="download-list compact-list">
          {state.downloads.recent.map((record) => (
            <DownloadRow key={record.id} record={record} compact onReveal={reveal} />
          ))}
        </div>
      )}
      <button className="link-button" onClick={() => void openAll()}>
        完整的下载记录
      </button>
    </main>
  )
}

function Settings({ state, now }: { state: ToolbarState; now: Date }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const remaining = currentWorkRemaining(state, now)
  const expiresDescription = useMemo(() => {
    if (!state.work.lastAcceptedAt || remaining <= 0) return '暂无'
    if (!state.work.timerRunning) return `已暂停（剩余 ${formatRemaining(remaining)}）`
    return `${formatDateTimeWithZone(new Date(now.getTime() + remaining).toISOString())}（剩余 ${formatRemaining(remaining)}）`
  }, [state.work.lastAcceptedAt, state.work.timerRunning, remaining, now])

  const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    setMessage(null)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  const reveal = async (id: string): Promise<void> => {
    const result = await window.chatgptWebNext.revealDownload(id)
    if (result === 'missing') setMessage('文件不存在，可能已被移动或删除。')
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <div>
          <p className="eyebrow">CHATGPT WEB NEXT</p>
          <h1>设置与状态</h1>
        </div>
        <span className="build-label">本机测试版</span>
      </header>

      {state.safety.phase !== 'none' && (
        <div className="notice safety-notice">
          安全倒计时不可取消：第 10 秒清除登录数据，第 30 秒退出 APP。
        </div>
      )}
      {state.storageStatus === 'initializing' && <div className="notice">正在准备本机加密记录…</div>}
      {state.storageWarning && <div className="notice error-notice">{state.storageWarning}</div>}
      {message && <div className="notice error-notice">{message}</div>}

      <section className="card">
        <div className="section-title-row">
          <h2>工作状态</h2>
          <span className={`pill light-${state.work.light}`}>
            <span className="status-dot" />{workLightLabel(state.work.light)}
          </span>
        </div>
        <dl>
          <Detail label="说明" value={state.work.message} />
          <Detail label="最后确认" value={formatDateTimeWithZone(state.work.lastAcceptedAt)} />
          <Detail label="预计熄灭" value={expiresDescription} />
          <Detail label="计时状态" value={state.work.timerRunning ? '登录期间计时中' : '已暂停'} />
          <Detail label="检测状态" value={detectorLabel(state.work.detectorHealth)} />
          <Detail label="待确认操作" value={String(state.work.pendingCount)} />
          <Detail label="设备 ID" value={state.maskedDeviceId} mono />
        </dl>

        <h3>状态检测记录</h3>
        {state.workRecords.length === 0 ? (
          <p className="empty-state">最近 7 天没有本机已确认的状态检测记录。</p>
        ) : (
          <div className="work-records">
            {state.workRecords.map((record) => (
              <article key={record.id} className="record-card">
                <strong>{record.chatName}</strong>
                <span>{record.projectName} · {record.accountName}</span>
                <time>{formatDateTimeWithZone(record.triggeredAt)}</time>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title-row">
          <h2>ChatGPT 出口网络</h2>
          <button
            className="small-button"
            disabled={busy === 'network' || state.network.checking}
            onClick={() => void run('network', window.chatgptWebNext.refreshNetwork)}
          >
            立即检测（三次）
          </button>
        </div>
        <dl>
          <Detail label="出口 IP" value={state.network.ip ?? '无法确认'} mono />
          <Detail label="估计位置" value={[state.network.country, state.network.city].filter(Boolean).join(' · ') || '未知'} />
          <Detail label="时区" value={state.network.timezone ?? '未知'} />
          <Detail label="当地时间" value={formatZonedTime(now, state.network.timezone)} />
          <Detail label="IP 检测时间" value={formatDateTime(state.network.observedAt)} />
          <Detail label="新鲜度" value={freshnessLabel(state.network.freshness)} />
          <Detail label="ChatGPT 响应延迟" value={state.network.latencyMs === null ? '无法确认' : `${state.network.latencyMs} ms`} />
          <Detail label="延迟样本" value={state.network.latencySampleCount ? `${state.network.latencySampleCount} 次有效样本` : '暂无'} />
          <Detail label="延迟检测时间" value={formatDateTime(state.network.latencyObservedAt)} />
        </dl>
        <p className="supporting">响应延迟每 20 分钟自动更新；检测期间继续显示上次结果。手动检测固定三次，每次最多等待 8 秒。它不是物理 Ping 或带宽。</p>
        {state.network.error && <p className="inline-error">{state.network.error}</p>}
        {state.network.locationError && <p className="inline-error">{state.network.locationError}</p>}
        {state.network.latencyError && state.network.latencyError !== state.network.error && (
          <p className="inline-error">{state.network.latencyError}</p>
        )}
      </section>

      <section className="card">
        <div className="section-title-row">
          <h2>下载管理</h2>
          <button
            className="small-button danger-button"
            disabled={busy !== null}
            onClick={() => void run('downloads', window.chatgptWebNext.clearDownloadRecords)}
          >
            清除下载记录
          </button>
        </div>
        <p className="supporting">最多保留 50 项、每项 7 天；清除列表不会删除文件。</p>
        {state.downloads.all.length === 0 ? (
          <p className="empty-state">暂无下载记录。</p>
        ) : (
          <div className="download-list">
            {state.downloads.all.map((record) => (
              <DownloadRow key={record.id} record={record} onReveal={reveal} />
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>APP Logo</h2>
        <p className="supporting">切换后立即应用到顶栏和 macOS Dock，重启后保持。</p>
        <div className="logo-grid">
          {state.preferences.logos.map((logo) => (
            <button
              key={logo.id}
              className={state.preferences.selectedLogoId === logo.id ? 'logo-choice selected' : 'logo-choice'}
              onClick={() => void run(`logo-${logo.id}`, () => window.chatgptWebNext.selectLogo(logo.id))}
            >
              <img src={logoSources[logo.id]} alt="" />
              <span>{logo.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>网页与刷新</h2>
        <p className="supporting">清理只处理当前窗口网页环境，不删除设备、Work、下载或 Logo 记录。</p>
        <div className="action-row wrap-actions">
          <button disabled={busy !== null} onClick={() => void window.chatgptWebNext.hardRefresh()}>
            忽略缓存并强制刷新
          </button>
          <button disabled={busy !== null} onClick={() => void run('cache', window.chatgptWebNext.clearCache)}>清缓存</button>
          <button className="danger-button" disabled={busy !== null} onClick={() => void run('web', window.chatgptWebNext.clearWebData)}>
            清除登录及网页数据
          </button>
        </div>
      </section>

      <footer>位置仅为 IP 推测；96 小时为本机提醒规则，并非官方额度时间。关闭本机 APP 不会停止云端 Work。</footer>
    </main>
  )
}

function DownloadRow({
  record,
  compact = false,
  onReveal
}: {
  record: DownloadRecord
  compact?: boolean
  onReveal?: (id: string) => void | Promise<void>
}): React.JSX.Element {
  const progress = record.totalBytes && record.totalBytes > 0
    ? Math.min(100, Math.round((record.receivedBytes / record.totalBytes) * 100))
    : null
  return (
    <article className="download-row">
      <div className="download-file">
        <strong title={record.savePath}>{record.fileName}</strong>
        <span>{formatBytes(record.receivedBytes)}{record.totalBytes ? ` / ${formatBytes(record.totalBytes)}` : ''} · {downloadStatusLabel(record.status)}</span>
        {!compact && <small>{record.savePath}</small>}
        {record.status === 'progressing' && progress !== null && (
          <progress max="100" value={progress}>{progress}%</progress>
        )}
      </div>
      {onReveal && record.status === 'completed' && (
        <button className="small-button" onClick={() => void onReveal(record.id)} title="在 Finder 或文件资源管理器中显示">
          显示位置
        </button>
      )}
    </article>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  )
}

function currentWorkRemaining(state: ToolbarState, now: Date): number {
  if (state.work.timerRunning && state.work.expiresAt) {
    return Math.max(0, Date.parse(state.work.expiresAt) - now.getTime())
  }
  return state.work.remainingMs
}

function currentSafetyRemaining(state: ToolbarState): { clear: number; quit: number } {
  return {
    clear: Math.max(0, Math.ceil(state.safety.clearRemainingMs / 1000)),
    quit: Math.max(0, Math.ceil(state.safety.quitRemainingMs / 1000))
  }
}

function workLightLabel(light: WorkLight): string {
  return { inactive: '未使用', active: '已使用', pending: '待确认', error: '检测异常' }[light]
}

function detectorLabel(value: ToolbarState['work']['detectorHealth']): string {
  return { unverified: '待真实校准', healthy: '正常', degraded: '异常' }[value]
}

function freshnessLabel(value: ToolbarState['network']['freshness']): string {
  return { live: '实时', stale: '已过期', unavailable: '无法确认' }[value]
}

function downloadStatusLabel(value: DownloadRecord['status']): string {
  return {
    progressing: '下载中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断'
  }[value]
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0小时'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${hours}小时${minutes}分`
}

function formatDateTime(value: string | null): string {
  if (!value) return '暂无'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '时间无效'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(parsed)
}

function formatDateTimeWithZone(value: string | null): string {
  if (!value) return '暂无'
  const formatted = formatDateTime(value)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区'
  return `${formatted}（${zone}）`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function networkTitle(state: ToolbarState): string {
  const lines = ['当前访问 ChatGPT 的出口 IP']
  if (state.network.observedAt) lines.push(`最后检测：${formatDateTime(state.network.observedAt)}`)
  if (state.network.error) lines.push(state.network.error)
  return lines.join('\n')
}
