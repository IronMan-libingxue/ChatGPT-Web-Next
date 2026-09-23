interface WorkPilotViewState {
  ruleVersion: string
  health: 'monitoring' | 'healthy' | 'attention'
  phase: 'idle' | 'pending' | 'confirmed' | 'attention'
  updatedAt: string
  lastConfirmedAt: string | null
  pendingCount: number
  statistics: {
    conversationPosts: number
    ignoredNonWork: number
    matchedWork: number
    confirmedWork: number
    rejectedWork: number
    transportErrors: number
    unmatchedWorkLike: number
    unreadableBodies: number
    streamStatusSuccesses: number
    duplicates: number
  }
  events: Array<{ at: string; kind: string; message: string }>
}

interface PilotResponse {
  ok: boolean
  state?: WorkPilotViewState
  report?: unknown
}

const HOST_ID = 'chatgpt-web-next-work-pilot'

if (!document.getElementById(HOST_ID)) {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.all = 'initial'
  host.style.position = 'fixed'
  host.style.top = '76px'
  host.style.right = '18px'
  host.style.zIndex = '2147483647'
  document.documentElement.append(host)

  const shadow = host.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `${styleMarkup()}${viewMarkup()}`
  const panel = requireElement<HTMLElement>(shadow, '[data-panel]')
  const toggle = requireElement<HTMLButtonElement>(shadow, '[data-toggle]')
  const copy = requireElement<HTMLButtonElement>(shadow, '[data-copy]')
  const reset = requireElement<HTMLButtonElement>(shadow, '[data-reset]')
  const feedback = requireElement<HTMLElement>(shadow, '[data-feedback]')

  toggle.addEventListener('click', () => panel.toggleAttribute('data-expanded'))
  copy.addEventListener('click', () => void runUiAction(() => copyReport(feedback), feedback))
  reset.addEventListener('click', () => void runUiAction(() => resetPilot(feedback), feedback))

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isStateMessage(message)) return
    render(shadow, message.state)
  })

  void requestState().then((state) => render(shadow, state)).catch((error: unknown) => {
    feedback.textContent = `无法读取验证状态：${safeMessage(error)}`
  })
}

async function requestState(): Promise<WorkPilotViewState> {
  const response = (await chrome.runtime.sendMessage({
    type: 'work-pilot:get-state'
  })) as PilotResponse
  if (!response.ok || !response.state) throw new Error('扩展后台没有返回状态')
  return response.state
}

async function copyReport(feedback: HTMLElement): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'work-pilot:get-report'
  })) as PilotResponse
  if (!response.ok || !response.report) throw new Error('匿名报告不可用')
  await navigator.clipboard.writeText(JSON.stringify(response.report, null, 2))
  feedback.textContent = '匿名报告已复制，不包含聊天正文、Cookie 或账号信息。'
}

async function resetPilot(feedback: HTMLElement): Promise<void> {
  if (!window.confirm('确定重置 Work 检测验证记录吗？这不会清除 ChatGPT 登录。')) return
  const response = (await chrome.runtime.sendMessage({
    type: 'work-pilot:reset'
  })) as PilotResponse
  if (!response.ok || !response.state) throw new Error('重置失败')
  feedback.textContent = '验证记录已重置。'
}

async function runUiAction(action: () => Promise<void>, feedback: HTMLElement): Promise<void> {
  try {
    await action()
  } catch (error) {
    feedback.textContent = `操作失败：${safeMessage(error)}`
  }
}

function render(shadow: ShadowRoot, state: WorkPilotViewState): void {
  const presentation = phasePresentation(state)
  const root = requireElement<HTMLElement>(shadow, '[data-root]')
  root.dataset.phase = state.phase
  requireElement<HTMLElement>(shadow, '[data-dot]').setAttribute('aria-label', presentation.label)
  requireElement<HTMLElement>(shadow, '[data-title]').textContent = presentation.label
  requireElement<HTMLElement>(shadow, '[data-detail]').textContent = presentation.detail
  requireElement<HTMLElement>(shadow, '[data-rule]').textContent = state.ruleVersion
  requireElement<HTMLElement>(shadow, '[data-pending]').textContent = String(state.pendingCount)
  requireElement<HTMLElement>(shadow, '[data-matched]').textContent = String(
    state.statistics.matchedWork
  )
  requireElement<HTMLElement>(shadow, '[data-confirmed]').textContent = String(
    state.statistics.confirmedWork
  )
  requireElement<HTMLElement>(shadow, '[data-ignored]').textContent = String(
    state.statistics.ignoredNonWork
  )
  requireElement<HTMLElement>(shadow, '[data-failed]').textContent = String(
    state.statistics.rejectedWork + state.statistics.transportErrors
  )
  requireElement<HTMLElement>(shadow, '[data-last-event]').textContent =
    state.events[0]?.message ?? '尚无事件'
  requireElement<HTMLElement>(shadow, '[data-updated]').textContent = formatTime(state.updatedAt)
}

function phasePresentation(state: WorkPilotViewState): { label: string; detail: string } {
  if (state.phase === 'attention') {
    return { label: 'Work 检测需复核', detail: state.events[0]?.message ?? '发现未知情况' }
  }
  if (state.phase === 'pending') {
    return { label: 'Work 待确认', detail: `${state.pendingCount} 个本机操作等待服务端信号` }
  }
  if (state.phase === 'confirmed') {
    return {
      label: 'Work 已确认',
      detail: state.lastConfirmedAt ? `确认于 ${formatTime(state.lastConfirmedAt)}` : '已确认使用'
    }
  }
  return { label: 'Work 监听已就绪', detail: '等待本机 Chat 或 Work 操作' }
}

function isStateMessage(value: unknown): value is { type: string; state: WorkPilotViewState } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'work-pilot:state-updated' &&
      (value as { state?: unknown }).state
  )
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`缺少验证界面元素：${selector}`)
  return element
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 120)
}

function viewMarkup(): string {
  return `
    <aside class="pilot" data-root data-phase="idle" aria-label="ChatGPT Work 检测验证版">
      <button class="summary" type="button" data-toggle>
        <span class="dot" data-dot></span>
        <span class="summary-copy">
          <strong data-title>Work 监听已就绪</strong>
          <small data-detail>等待本机 Chat 或 Work 操作</small>
        </span>
        <span class="chevron">⌄</span>
      </button>
      <section class="details" data-panel>
        <div class="privacy">仅保存匿名操作标识和检测结果，不保存聊天正文、Cookie 或账号。</div>
        <dl>
          <div><dt>待确认</dt><dd data-pending>0</dd></div>
          <div><dt>识别 Work</dt><dd data-matched>0</dd></div>
          <div><dt>确认成功</dt><dd data-confirmed>0</dd></div>
          <div><dt>忽略非 Work</dt><dd data-ignored>0</dd></div>
          <div><dt>拒绝／网络失败</dt><dd data-failed>0</dd></div>
          <div><dt>最后事件</dt><dd data-last-event>监听已启动</dd></div>
          <div><dt>更新时间</dt><dd data-updated>--</dd></div>
          <div><dt>规则版本</dt><dd class="mono" data-rule>--</dd></div>
        </dl>
        <p class="feedback" data-feedback></p>
        <div class="actions">
          <button type="button" data-copy>复制匿名报告</button>
          <button type="button" data-reset>重置记录</button>
        </div>
      </section>
    </aside>`
}

function styleMarkup(): string {
  return `<style>
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .pilot {
      width: 326px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 16px;
      color: CanvasText;
      background: color-mix(in srgb, Canvas 94%, transparent);
      box-shadow: 0 16px 48px rgba(0,0,0,.18);
      backdrop-filter: blur(20px);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button { font: inherit; }
    .summary {
      display: grid;
      width: 100%;
      grid-template-columns: 12px 1fr 18px;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border: 0;
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #8b949e; }
    [data-phase="pending"] .dot { background: #f0a11a; box-shadow: 0 0 0 4px rgba(240,161,26,.14); }
    [data-phase="confirmed"] .dot { background: #df3038; box-shadow: 0 0 0 4px rgba(223,48,56,.14); }
    [data-phase="attention"] .dot { background: #f07818; box-shadow: 0 0 0 4px rgba(240,120,24,.14); }
    .summary-copy { display: grid; min-width: 0; gap: 2px; }
    .summary-copy strong, .summary-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary-copy strong { font-size: 13px; }
    .summary-copy small { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 11px; }
    .chevron { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 16px; transition: transform .15s ease; }
    .details { display: none; padding: 0 14px 14px; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .details[data-expanded] { display: block; }
    .privacy { margin: 12px 0 8px; padding: 9px 10px; border-radius: 9px; color: #176b57; background: rgba(16,163,127,.11); font-size: 11px; }
    dl { margin: 0; }
    dl > div { display: grid; grid-template-columns: 105px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 9%, transparent); }
    dt { color: color-mix(in srgb, CanvasText 58%, transparent); }
    dd { margin: 0; overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .feedback { min-height: 16px; margin: 9px 0 0; color: #176b57; font-size: 10px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
    .actions button { padding: 8px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 9px; color: inherit; background: color-mix(in srgb, Canvas 85%, CanvasText 5%); cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      .privacy { color: #9ee2cf; background: rgba(34,181,143,.15); }
      .feedback { color: #9ee2cf; }
    }
  </style>`
}
