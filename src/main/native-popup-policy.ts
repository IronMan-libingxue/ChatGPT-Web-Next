import type { BrowserWindow, Session, WebContents } from 'electron'

const CHAT_HOSTS = ['chatgpt.com', 'openai.com']
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.googleusercontent.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com'
]
const AUTH_BROKER_HOSTS = ['auth.openai.com', 'auth0.openai.com']

export interface NativePopupEvent {
  type:
    | 'authentication'
    | 'created'
    | 'closed'
    | 'blocked'
    | 'session-mismatch'
    | 'load-failed'
  host: string | null
  url?: string
  window?: BrowserWindow
}

export interface NativePopupPolicyOptions {
  ownerWindow: BrowserWindow
  partition: string
  expectedSession: Session
  showWindows: boolean
  testAllowedOrigins?: ReadonlySet<string>
  testAuthenticationOrigins?: ReadonlySet<string>
  onEvent: (event: NativePopupEvent) => void
}

export function installNativePopupPolicy(
  opener: WebContents,
  options: NativePopupPolicyOptions
): void {
  opener.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNativeLoginUrl(url, options.testAllowedOrigins, true)) {
      queueMicrotask(() =>
        options.onEvent({ type: 'blocked', host: safeHost(url), url })
      )
      return { action: 'deny' }
    }
    if (isAuthenticationPageUrl(url, options.testAuthenticationOrigins)) {
      options.onEvent({ type: 'authentication', host: safeHost(url) })
    }

    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        width: 620,
        height: 780,
        minWidth: 420,
        minHeight: 560,
        parent: options.ownerWindow,
        show: options.showWindows,
        autoHideMenuBar: true,
        title: 'ChatGPT 安全登录',
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: options.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false,
          spellcheck: true
        }
      }
    }
  })

  opener.on('did-create-window', (window, details) => {
    const initialHost = safeHost(details.url)
    if (window.webContents.session !== options.expectedSession) {
      options.onEvent({
        type: 'session-mismatch',
        host: initialHost,
        url: details.url,
        window
      })
      window.destroy()
      return
    }

    options.onEvent({ type: 'created', host: initialHost, url: details.url, window })
    guardPopupNavigation(window.webContents, options)
    installNativePopupPolicy(window.webContents, options)

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, _description, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        options.onEvent({
          type: 'load-failed',
          host: safeHost(validatedUrl),
          url: validatedUrl,
          window
        })
      }
    )
    window.once('closed', () => {
      options.onEvent({ type: 'closed', host: initialHost, url: details.url, window })
    })
  })
}

export function guardPopupNavigation(
  contents: WebContents,
  options: NativePopupPolicyOptions
): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (isAllowedNativeLoginUrl(url, options.testAllowedOrigins, true)) {
      if (isAuthenticationPageUrl(url, options.testAuthenticationOrigins)) {
        options.onEvent({ type: 'authentication', host: safeHost(url) })
      }
      return
    }
    event.preventDefault()
    options.onEvent({ type: 'blocked', host: safeHost(url), url })
  }

  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
}

export function isAllowedNativeLoginUrl(
  value: string,
  testAllowedOrigins: ReadonlySet<string> = new Set(),
  allowBlank = false
): boolean {
  if (allowBlank && value === 'about:blank') return true

  try {
    const url = new URL(value)
    if (testAllowedOrigins.has(url.origin)) return true
    if (url.protocol !== 'https:') return false
    return [...CHAT_HOSTS, ...AUTH_HOSTS].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  } catch {
    return false
  }
}

export function safeHost(value: string): string | null {
  if (value === 'about:blank') return 'about:blank'
  try {
    return new URL(value).hostname || null
  } catch {
    return null
  }
}

export function isIdentityProviderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
    return AUTH_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

export function isAuthenticationPageUrl(
  value: string,
  testAuthenticationOrigins: ReadonlySet<string> = new Set()
): boolean {
  try {
    const url = new URL(value)
    if (testAuthenticationOrigins.has(url.origin)) return true
    if (url.protocol !== 'https:') return false
    if (
      (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
      (url.pathname === '/auth' ||
        url.pathname.startsWith('/auth/') ||
        url.pathname === '/login' ||
        url.pathname === '/log-in')
    ) {
      return true
    }
    return [...AUTH_BROKER_HOSTS, ...AUTH_HOSTS].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  } catch {
    return false
  }
}

export function isChatGptPageUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
  } catch {
    return false
  }
}
