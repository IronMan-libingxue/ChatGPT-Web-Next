import type { Session, WebContents } from 'electron'
import type { LoginState } from '../shared/types'
import type { WorkUsageMetadata } from './work-usage-store'

interface AuthSessionPayload {
  user?: { name?: unknown }
}

export function shouldRefreshNetworkAfterLoginCheck(
  previousState: LoginState,
  nextState: LoginState
): boolean {
  return previousState !== 'logged-in' && nextState === 'logged-in'
}

export async function detectLoginState(
  remoteSession: Session,
  pageUrl: string,
  rootUrl: string
): Promise<{ state: LoginState; accountName: string }> {
  try {
    const endpoint = new URL('/api/auth/session', rootUrl)
    const response = await remoteSession.fetch(endpoint.toString(), {
      cache: 'no-store',
      credentials: 'include'
    })
    if (response.status === 401 || response.status === 403) {
      return { state: 'logged-out', accountName: '未识别账号' }
    }
    if (!response.ok) return { state: 'checking', accountName: '未识别账号' }
    const data = (await response.json()) as AuthSessionPayload
    const accountName = safeAccountName(data.user?.name)
    return data.user
      ? { state: 'logged-in', accountName }
      : { state: 'logged-out', accountName: '未识别账号' }
  } catch {
    try {
      const page = new URL(pageUrl)
      const root = new URL(rootUrl)
      if (page.origin !== root.origin) return { state: 'checking', accountName: '未识别账号' }
    } catch {
      // A malformed or unavailable page URL does not prove logout.
    }
    return { state: 'checking', accountName: '未识别账号' }
  }
}

export async function readWorkUsageMetadata(
  contents: WebContents,
  knownAccountName: string
): Promise<WorkUsageMetadata> {
  if (contents.isDestroyed()) return fallbackMetadata(knownAccountName)
  try {
    const result = (await contents.executeJavaScript(`(() => {
      const clean = (value) => typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim().slice(0, 160) : '';
      const visible = (element) => element && element instanceof HTMLElement && element.offsetParent !== null;
      const text = (selectors) => {
        for (const selector of selectors) {
          const element = [...document.querySelectorAll(selector)].find(visible);
          const value = clean(element?.textContent || element?.getAttribute?.('aria-label') || '');
          if (value) return value;
        }
        return '';
      };
      const test = globalThis.__CHATGPT_WEB_NEXT_TEST_METADATA__ || {};
      const accountName = clean(test.accountName) || text([
        '[data-testid="profile-button"] [data-testid="account-name"]',
        '[data-testid="account-name"]',
        'button[aria-label*="Profile"] span',
        'button[aria-label*="个人资料"] span'
      ]);
      const projectName = clean(test.projectName) || text([
        '[data-testid="project-name"]',
        'nav a[aria-current="page"][href*="/g/"]',
        'aside a[aria-current="page"][href*="/g/"]'
      ]);
      let chatName = clean(test.chatName) || text([
        '[data-testid="conversation-title"]',
        'nav a[aria-current="page"][href*="/c/"]',
        'aside a[aria-current="page"][href*="/c/"]',
        'header h1'
      ]);
      if (!chatName) {
        const title = clean(document.title).replace(/\\s*[|–—-]\\s*ChatGPT\\s*$/i, '');
        if (title && title.toLowerCase() !== 'chatgpt') chatName = title;
      }
      return { accountName, projectName, chatName };
    })()`, true)) as Partial<WorkUsageMetadata>
    return {
      accountName: safeAccountName(result.accountName || knownAccountName),
      projectName: safeLabel(result.projectName, '未归入项目'),
      chatName: safeLabel(result.chatName, '未命名对话')
    }
  } catch {
    return fallbackMetadata(knownAccountName)
  }
}

function fallbackMetadata(accountName: string): WorkUsageMetadata {
  return {
    accountName: safeAccountName(accountName),
    projectName: '未归入项目',
    chatName: '未命名对话'
  }
}

function safeAccountName(value: unknown): string {
  const label = safeLabel(value, '未识别账号')
  return label.includes('@') ? '未识别账号' : label
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const label = value.replaceAll(/\s+/gu, ' ').trim().slice(0, 160)
  return label || fallback
}
