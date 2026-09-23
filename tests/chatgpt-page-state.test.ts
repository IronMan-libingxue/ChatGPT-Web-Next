import { describe, expect, it } from 'vitest'
import { shouldRefreshNetworkAfterLoginCheck } from '../src/main/chatgpt-page-state'
import type { LoginState } from '../src/shared/types'

describe('ChatGPT login transition network refresh', () => {
  it('refreshes once when a session becomes logged in', () => {
    expect(shouldRefreshNetworkAfterLoginCheck('checking', 'logged-in')).toBe(true)
    expect(shouldRefreshNetworkAfterLoginCheck('logged-out', 'logged-in')).toBe(true)
  })

  it('does not turn periodic logged-in checks into repeated network tests', () => {
    expect(shouldRefreshNetworkAfterLoginCheck('logged-in', 'logged-in')).toBe(false)
  })

  it.each<LoginState>(['checking', 'logged-out'])(
    'does not refresh for a %s result',
    (nextState) => {
      expect(shouldRefreshNetworkAfterLoginCheck('logged-in', nextState)).toBe(false)
    }
  )
})
