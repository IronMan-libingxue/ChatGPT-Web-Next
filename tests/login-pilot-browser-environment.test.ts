import { describe, expect, it } from 'vitest'
import {
  assertDedicatedProfilePath,
  browserSpecsForPlatform,
  buildBrowserLaunchArguments,
  buildBrowserPageArguments,
  findDedicatedProcessIds,
  profilePathForBrowser
} from '../login-pilot/src/main/browser-environment'

describe('login pilot browser environment', () => {
  it('uses real Chrome and Edge application executables on macOS', () => {
    const specs = browserSpecsForPlatform('darwin')
    expect(specs.map((spec) => spec.id)).toEqual(['chrome', 'edge'])
    expect(specs[0]?.executablePath).toContain('Google Chrome.app')
    expect(specs[1]?.executablePath).toContain('Microsoft Edge.app')
  })

  it('opens the Chrome extensions page without debugging or automation flags', () => {
    const argumentsList = buildBrowserPageArguments(
      '/tmp/pilot/BrowserProfiles/chrome',
      'chrome://extensions/'
    )
    expect(argumentsList).toContain('chrome://extensions/')
    expect(argumentsList.some((value) => value.includes('remote-debugging'))).toBe(false)
    expect(argumentsList.some((value) => value.includes('load-extension'))).toBe(false)
    expect(argumentsList.some((value) => value.includes('automation'))).toBe(false)
  })

  it('builds a client-like launch without automation or remote debugging flags', () => {
    const argumentsList = buildBrowserLaunchArguments(
      '/tmp/pilot/BrowserProfiles/chrome',
      'https://chatgpt.com/'
    )
    expect(argumentsList).toContain('--user-data-dir=/tmp/pilot/BrowserProfiles/chrome')
    expect(argumentsList).toContain('--app=https://chatgpt.com/')
    expect(argumentsList.some((value) => value.includes('automation'))).toBe(false)
    expect(argumentsList.some((value) => value.includes('remote-debugging'))).toBe(false)
    expect(argumentsList.some((value) => value.includes('user-agent'))).toBe(false)
  })

  it('only accepts the exact dedicated profile directory', () => {
    const root = '/tmp/pilot/BrowserProfiles'
    const expected = profilePathForBrowser(root, 'chrome')
    expect(() => assertDedicatedProfilePath(root, expected, 'chrome')).not.toThrow()
    expect(() => assertDedicatedProfilePath(root, '/tmp/pilot', 'chrome')).toThrow()
    expect(() => assertDedicatedProfilePath(root, `${expected}-other`, 'chrome')).toThrow()
    expect(() => assertDedicatedProfilePath(root, profilePathForBrowser(root, 'edge'), 'chrome')).toThrow()
  })

  it('finds only processes using the exact validation profile', () => {
    const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const profile = '/Users/test/Library/Application Support/Login Pilot/BrowserProfiles/chrome'
    const processList = [
      `101 ${executable} --user-data-dir=${profile} --app=https://chatgpt.com/`,
      `102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --user-data-dir=${profile} --lang=zh-CN`,
      `103 ${executable} --user-data-dir=${profile}-other --app=https://chatgpt.com/`,
      `104 ${executable} --app=https://chatgpt.com/`,
      `105 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir=${profile} --app=https://chatgpt.com/`
    ].join('\n')

    expect(findDedicatedProcessIds(processList, profile, executable)).toEqual([101, 102])
  })
})
