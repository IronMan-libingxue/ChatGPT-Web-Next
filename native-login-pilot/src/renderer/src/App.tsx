import { useEffect, useState } from 'react'
import type { NativeLoginPilotState } from '../../shared/types'

export function App(): React.JSX.Element {
  const [state, setState] = useState<NativeLoginPilotState | null>(null)

  useEffect(() => {
    void window.chatgptNativeLoginPilot.getState().then(setState)
    return window.chatgptNativeLoginPilot.onState(setState)
  }, [])

  const busy = state?.activity !== 'idle'
  const statusClass = state?.error ? 'error' : state?.popupStatus === 'created' ? 'active' : ''

  return (
    <header className="toolbar">
      <div className="brand" aria-label="ChatGPT Web Next">N</div>
      <div className="title-block">
        <strong>Electron 原生登录验证</strong>
        <span>原生弹窗 · 独立会话 · 不复制账号数据</span>
      </div>
      <div
        className={`status ${statusClass}`}
        data-testid="popup-status"
        title={state?.error ?? state?.message}
      >
        <span className="status-dot" />
        <span>{statusLabel(state)}</span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(window.chatgptNativeLoginPilot.refresh, setState)}
        data-testid="refresh"
        title="刷新 ChatGPT"
      >
        刷新
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(window.chatgptNativeLoginPilot.hardRefresh, setState)}
        data-testid="hard-refresh"
        title="忽略缓存重新加载"
      >
        强制刷新
      </button>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => void run(window.chatgptNativeLoginPilot.clearWebData, setState)}
        data-testid="clear-web-data"
        title="清除本验证版的登录及网页数据"
      >
        {busy ? '正在清除…' : '清除登录数据'}
      </button>
    </header>
  )
}

function statusLabel(state: NativeLoginPilotState | null): string {
  if (!state) return '正在初始化'
  if (state.error) return '需要检查'
  if (state.popupStatus === 'created') return `登录弹窗已连接 ${state.activePopupCount}`
  if (state.pageStage === 'authentication') return '登录正在当前页面进行'
  if (state.popupStatus === 'closed') return '登录弹窗已关闭'
  return '等待 Google 登录弹窗'
}

async function run(
  action: () => Promise<NativeLoginPilotState>,
  setState: (state: NativeLoginPilotState) => void
): Promise<void> {
  setState(await action())
}
