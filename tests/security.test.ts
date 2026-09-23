import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

import {
  configureRemoteSession,
  isAuthUrl,
  isChatOrAuthUrl,
  isChatUrl
} from '../src/main/security'

describe('remote page security', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts only exact HTTPS ChatGPT and approved sign-in host boundaries', () => {
    expect(isChatUrl('https://chatgpt.com/')).toBe(true)
    expect(isChatUrl('https://sub.chatgpt.com/path')).toBe(true)
    expect(isChatUrl('http://chatgpt.com/')).toBe(false)
    expect(isChatUrl('https://chatgpt.com.evil.example/')).toBe(false)
    expect(isAuthUrl('https://accounts.google.com/')).toBe(true)
    expect(isAuthUrl('https://accounts.google.com.evil.example/')).toBe(false)
    expect(isChatOrAuthUrl('file:///tmp/unsafe')).toBe(false)
  })

  it('allows approved capabilities only when the requesting page is ChatGPT', () => {
    type RequestHandler = (
      webContents: { getURL: () => string },
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    type CheckHandler = (
      webContents: unknown,
      permission: string,
      requestingOrigin: string
    ) => boolean
    let requestHandler: RequestHandler | undefined
    let checkHandler: CheckHandler | undefined
    const remoteSession = {
      setPermissionRequestHandler: vi.fn((handler: RequestHandler) => {
        requestHandler = handler
      }),
      setPermissionCheckHandler: vi.fn((handler: CheckHandler) => {
        checkHandler = handler
      })
    }
    configureRemoteSession(remoteSession as never)

    const callback = vi.fn()
    requestHandler?.({ getURL: () => 'https://chatgpt.com/' }, 'media', callback)
    expect(callback).toHaveBeenLastCalledWith(true)
    requestHandler?.({ getURL: () => 'https://accounts.google.com/' }, 'media', callback)
    expect(callback).toHaveBeenLastCalledWith(false)
    requestHandler?.({ getURL: () => 'https://chatgpt.com/' }, 'geolocation', callback)
    expect(callback).toHaveBeenLastCalledWith(false)

    expect(checkHandler?.(undefined, 'notifications', 'https://chatgpt.com/')).toBe(true)
    expect(checkHandler?.(undefined, 'notifications', 'https://evil.example/')).toBe(false)
  })
})
