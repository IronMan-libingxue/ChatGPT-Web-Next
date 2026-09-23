import { dialog, shell, type BrowserWindow, type Session, type WebContents } from 'electron'
import { isAllowedNativeLoginUrl } from './native-popup-policy'

const CHAT_HOSTS = ['chatgpt.com', 'openai.com']
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.googleusercontent.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com'
]
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
  'notifications'
])

export function configureRemoteSession(remoteSession: Session): void {
  remoteSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed =
      ALLOWED_PERMISSIONS.has(permission) && isChatUrl(webContents.getURL())
    callback(allowed)
  })
  remoteSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isChatUrl(requestingOrigin)
  )
}

export function guardNavigation(
  webContents: WebContents,
  parent: BrowserWindow,
  testAllowedOrigins: ReadonlySet<string> = new Set()
): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (isAllowedNativeLoginUrl(url, testAllowedOrigins)) return
    event.preventDefault()
    void confirmExternalNavigation(parent, url)
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}

export async function confirmExternalNavigation(
  parent: BrowserWindow,
  value: string
): Promise<void> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  if (url.protocol !== 'https:') return

  const result = await dialog.showMessageBox(parent, {
    type: 'question',
    title: '在默认浏览器中打开？',
    message: '此链接将离开 ChatGPT Web Next。',
    detail: `${url.hostname}${url.pathname}`,
    buttons: ['取消', '打开'],
    defaultId: 0,
    cancelId: 0
  })
  if (result.response === 1) await shell.openExternal(url.toString())
}

export function isChatUrl(value: string): boolean {
  return hasAllowedHost(value, CHAT_HOSTS)
}

export function isChatOrAuthUrl(value: string): boolean {
  return isAllowedNativeLoginUrl(value)
}

export function isAuthUrl(value: string): boolean {
  return hasAllowedHost(value, AUTH_HOSTS)
}

function hasAllowedHost(value: string, allowed: string[]): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}
