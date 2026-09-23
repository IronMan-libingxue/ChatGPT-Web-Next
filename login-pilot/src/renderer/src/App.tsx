import { useEffect, useState } from 'react'
import type { PilotBrowserId, PilotState } from '../../shared/types'

export function App(): React.JSX.Element {
  const [state, setState] = useState<PilotState | null>(null)

  useEffect(() => {
    void window.chatgptLoginPilot.getState().then(setState)
    return window.chatgptLoginPilot.onState(setState)
  }, [])

  if (!state) return <main className="loading">正在检查真实浏览器…</main>

  const selected = state.browsers.find((browser) => browser.id === state.selectedBrowser)
  const busy = state.activity !== 'idle'
  const running = state.runningProcessCount > 0

  return (
    <main className="page">
      <header className="hero">
        <div className="brand-mark">N</div>
        <div>
          <p className="eyebrow">CHATGPT WEB NEXT</p>
          <h1>Chrome Work 检测验证</h1>
          <p className="subtitle">在已验证可登录的独立 Chrome 中，核对 Work 成功提交证据。</p>
        </div>
        <span className="pilot-badge">独立验证版</span>
      </header>

      <section className="card">
        <div className="section-heading">
          <div>
            <h2>选择真实浏览器</h2>
            <p>使用单独资料目录，不读取或改动你日常使用的浏览器账号。</p>
          </div>
          <span className={`status-pill ${running ? 'running' : ''}`}>
            <span className="dot" />{running ? '验证环境运行中' : '验证环境未运行'}
          </span>
        </div>

        <div className="browser-grid">
          {state.browsers.map((browser) => (
            <button
              key={browser.id}
              className={`browser-option ${state.selectedBrowser === browser.id ? 'selected' : ''}`}
              disabled={busy || !browser.available}
              onClick={() => void selectBrowser(browser.id, setState)}
              data-testid={`browser-${browser.id}`}
            >
              <span className="browser-name">{browser.name}</span>
              <span className="browser-version">
                {browser.available ? browser.version ?? '已安装' : '未安装'}
              </span>
            </button>
          ))}
        </div>

        <dl className="environment-details">
          <Detail label="当前选择" value={selected?.name ?? '不可用'} />
          <Detail label="资料状态" value={state.profileExists ? '独立资料已建立' : '尚未建立'} />
          <Detail label="运行进程" value={String(state.runningProcessCount)} />
          <Detail label="独立目录" value={state.profilePath} mono />
          <Detail
            label="检测扩展"
            value={state.workExtensionSourceReady ? '验证文件已就绪' : '验证文件缺失'}
          />
          <Detail label="扩展目录" value={state.workExtensionPath} mono />
        </dl>

        <div className="action-row">
          <button
            className="extension-button"
            disabled={busy || state.selectedBrowser !== 'chrome' || !state.workExtensionSourceReady}
            onClick={() => void runAction(window.chatgptLoginPilot.prepareWorkExtension, setState)}
            data-testid="prepare-work-extension"
          >
            {state.activity === 'preparing-extension'
              ? '正在准备…'
              : '1. 安装／检查 Work 检测扩展'}
          </button>
          <button
            className="primary-button"
            disabled={busy || !selected?.available}
            onClick={() => void runAction(window.chatgptLoginPilot.launch, setState)}
            data-testid="launch"
          >
            {state.activity === 'launching' ? '正在打开…' : `2. 打开 ChatGPT（${shortName(state.selectedBrowser)}）`}
          </button>
          <button
            className="danger-button"
            disabled={busy || !selected?.available}
            onClick={() => void runAction(window.chatgptLoginPilot.clearAndRelaunch, setState)}
            data-testid="clear-and-relaunch"
          >
            {state.activity === 'clearing' ? '正在清除…' : '清除并打开全新环境'}
          </button>
        </div>

        <div className={`result ${state.error ? 'error' : ''}`} role="status" data-testid="result">
          <span className="result-icon">{state.error ? '!' : '✓'}</span>
          <div>
            <strong>{state.message}</strong>
            {state.error && <p>{state.error}</p>}
            {state.lastActionAt && <small>最近操作：{formatTime(state.lastActionAt)}</small>}
          </div>
        </div>
      </section>

      <section className="card steps-card">
        <h2>本次 Work 验证顺序</h2>
        <ol>
          <li><span>1</span><p>点击“安装／检查”，在 Chrome 扩展页开启开发者模式并加载已复制的目录。</p></li>
          <li><span>2</span><p>打开或刷新 ChatGPT，确认右上角出现“Work 监听已就绪”。</p></li>
          <li><span>3</span><p>发送一条普通聊天：只增加“忽略非 Work”，不能显示已确认。</p></li>
          <li><span>4</span><p>手动发送 Work 新任务和后续指令：应先待确认，再由服务端信号转为已确认。</p></li>
          <li><span>5</span><p>只查看 Work 历史不应变化；明确失败或断网提交不能确认成功。</p></li>
        </ol>
      </section>

      <footer>
        <p><strong>边界：</strong>不复制 Cookie，不读取聊天正文，不关闭 Google 安全保护，不启用自动化或远程调试。</p>
        <p>清除操作只处理上方显示的独立目录；日常 Chrome/Edge 不会被关闭或清除。</p>
      </footer>
    </main>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  )
}

async function selectBrowser(
  browserId: PilotBrowserId,
  setState: (state: PilotState) => void
): Promise<void> {
  setState(await window.chatgptLoginPilot.selectBrowser(browserId))
}

async function runAction(
  action: () => Promise<PilotState>,
  setState: (state: PilotState) => void
): Promise<void> {
  setState(await action())
}

function shortName(browserId: PilotBrowserId): string {
  return browserId === 'chrome' ? 'Chrome' : 'Edge'
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}
