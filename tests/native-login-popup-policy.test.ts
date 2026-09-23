import { describe, expect, it } from 'vitest'
import {
  isAuthenticationPageUrl,
  isChatGptPageUrl,
  isIdentityProviderUrl,
  isAllowedNativeLoginUrl,
  safeHost
} from '../src/main/native-popup-policy'

describe('Electron native login popup policy', () => {
  it('allows ChatGPT, OpenAI and precise identity-provider hosts', () => {
    expect(isAllowedNativeLoginUrl('https://chatgpt.com/auth/login')).toBe(true)
    expect(isAllowedNativeLoginUrl('https://auth.openai.com/authorize')).toBe(true)
    expect(isAllowedNativeLoginUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true)
    expect(isAllowedNativeLoginUrl('https://appleid.apple.com/auth/authorize')).toBe(true)
    expect(isAllowedNativeLoginUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe(true)
  })

  it('does not allow lookalike, insecure or unrelated hosts', () => {
    expect(isAllowedNativeLoginUrl('https://accounts.google.com.example.test/login')).toBe(false)
    expect(isAllowedNativeLoginUrl('http://accounts.google.com/login')).toBe(false)
    expect(isAllowedNativeLoginUrl('https://google.com/')).toBe(false)
    expect(isAllowedNativeLoginUrl('https://example.com/')).toBe(false)
    expect(isAllowedNativeLoginUrl('file:///tmp/login.html')).toBe(false)
  })

  it('only permits about:blank when the native popup path explicitly requests it', () => {
    expect(isAllowedNativeLoginUrl('about:blank')).toBe(false)
    expect(isAllowedNativeLoginUrl('about:blank', new Set(), true)).toBe(true)
  })

  it('supports isolated local origins only when supplied by the test harness', () => {
    const origins = new Set(['http://127.0.0.1:43123', 'http://localhost:43124'])
    expect(isAllowedNativeLoginUrl('http://127.0.0.1:43123/start', origins)).toBe(true)
    expect(isAllowedNativeLoginUrl('http://localhost:43124/auth', origins)).toBe(true)
    expect(isAllowedNativeLoginUrl('http://127.0.0.1:43125/start', origins)).toBe(false)
  })

  it('exposes only a host for status reporting', () => {
    expect(safeHost('https://accounts.google.com/login?secret=value')).toBe('accounts.google.com')
    expect(safeHost('about:blank')).toBe('about:blank')
    expect(safeHost('not a url')).toBeNull()
  })

  it('distinguishes the ChatGPT page from an identity-provider page', () => {
    expect(isChatGptPageUrl('https://chatgpt.com/auth/login')).toBe(true)
    expect(isChatGptPageUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(false)
    expect(isIdentityProviderUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true)
    expect(isIdentityProviderUrl('https://chatgpt.com/auth/login')).toBe(false)
  })

  it('identifies authentication pages without treating ordinary OpenAI pages as login', () => {
    expect(isAuthenticationPageUrl('https://chatgpt.com/auth/login')).toBe(true)
    expect(isAuthenticationPageUrl('https://auth.openai.com/authorize')).toBe(true)
    expect(isAuthenticationPageUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true)
    expect(isAuthenticationPageUrl('https://chatgpt.com/')).toBe(false)
    expect(isAuthenticationPageUrl('https://openai.com/policies/privacy-policy/')).toBe(false)
    expect(
      isAuthenticationPageUrl(
        'http://127.0.0.1:43124/auth',
        new Set(['http://127.0.0.1:43124'])
      )
    ).toBe(true)
  })
})
