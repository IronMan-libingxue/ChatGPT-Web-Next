import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { PilotBrowserId, PilotBrowserOption } from '../shared/types'

const execFileAsync = promisify(execFile)

export interface BrowserSpec {
  id: PilotBrowserId
  name: string
  executablePath: string
}

export interface TerminationResult {
  requestedProcessCount: number
  forcedProcessCount: number
}

export function browserSpecsForPlatform(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
  testChromeExecutable?: string
): BrowserSpec[] {
  if (platform === 'darwin') {
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePath:
          testChromeExecutable ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      }
    ]
  }

  if (platform === 'win32') {
    const programFiles = environment.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = environment.LOCALAPPDATA ?? ''
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePath: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        executablePath: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      },
      ...(localAppData
        ? [
            {
              id: 'chrome' as const,
              name: 'Google Chrome',
              executablePath: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
            }
          ]
        : [])
    ]
  }

  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      executablePath: '/usr/bin/google-chrome'
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      executablePath: '/usr/bin/microsoft-edge'
    }
  ]
}

export async function detectBrowsers(specs: BrowserSpec[]): Promise<{
  specs: BrowserSpec[]
  options: PilotBrowserOption[]
}> {
  const uniqueSpecs = deduplicateSpecs(specs)
  const detected = await Promise.all(
    uniqueSpecs.map(async (spec) => {
      const available = await canExecute(spec.executablePath)
      return {
        spec,
        option: {
          id: spec.id,
          name: spec.name,
          available,
          version: available ? await readBrowserVersion(spec.executablePath) : null
        } satisfies PilotBrowserOption
      }
    })
  )

  return {
    specs: detected.map((entry) => entry.spec),
    options: detected.map((entry) => entry.option)
  }
}

function deduplicateSpecs(specs: BrowserSpec[]): BrowserSpec[] {
  const byId = new Map<PilotBrowserId, BrowserSpec>()
  for (const spec of specs) {
    if (!byId.has(spec.id)) byId.set(spec.id, spec)
  }
  return [...byId.values()]
}

async function canExecute(executablePath: string): Promise<boolean> {
  try {
    await access(executablePath)
    return true
  } catch {
    return false
  }
}

async function readBrowserVersion(executablePath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ['--version'], {
      timeout: 4_000
    })
    const value = `${stdout}${stderr}`.trim()
    return value || null
  } catch {
    return null
  }
}

export function profilePathForBrowser(
  profilesRoot: string,
  browserId: PilotBrowserId
): string {
  return join(resolve(profilesRoot), browserId)
}

export function assertDedicatedProfilePath(
  profilesRoot: string,
  profilePath: string,
  browserId: PilotBrowserId
): void {
  const resolvedRoot = resolve(profilesRoot)
  const resolvedProfile = resolve(profilePath)
  const expected = profilePathForBrowser(resolvedRoot, browserId)
  const pathFromRoot = relative(resolvedRoot, resolvedProfile)

  if (
    resolvedProfile !== expected ||
    pathFromRoot === '' ||
    pathFromRoot.startsWith('..') ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('拒绝处理不属于登录验证版的浏览器资料目录。')
  }
}

export function buildBrowserLaunchArguments(profilePath: string, targetUrl: string): string[] {
  return [
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    `--app=${targetUrl}`
  ]
}

export function buildBrowserPageArguments(profilePath: string, targetUrl: string): string[] {
  return [
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    targetUrl
  ]
}

export function findDedicatedProcessIds(
  processList: string,
  profilePath: string,
  executablePath: string
): number[] {
  const executableName = basename(executablePath)
  const matches: number[] = []

  for (const line of processList.split('\n')) {
    const parsed = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!parsed) continue
    const pid = Number(parsed[1])
    const command = parsed[2]
    if (!Number.isSafeInteger(pid) || pid <= 1 || !command) continue
    if (!command.includes(executablePath) && !command.includes(executableName)) continue
    if (!hasExactUserDataDirectory(command, profilePath)) continue
    matches.push(pid)
  }

  return [...new Set(matches)]
}

function hasExactUserDataDirectory(command: string, profilePath: string): boolean {
  const variants = [
    `--user-data-dir=${profilePath}`,
    `--user-data-dir="${profilePath}"`,
    `--user-data-dir='${profilePath}'`
  ]

  return variants.some((marker) => {
    const markerIndex = command.indexOf(marker)
    if (markerIndex < 0) return false
    const remainder = command.slice(markerIndex + marker.length)
    return remainder === '' || /^[\s]+--/u.test(remainder)
  })
}

export async function listDedicatedProcessIds(
  profilePath: string,
  executablePath: string
): Promise<number[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return []
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], {
    maxBuffer: 4 * 1024 * 1024
  })
  return findDedicatedProcessIds(stdout, profilePath, executablePath)
}

export async function terminateDedicatedProcesses(
  profilePath: string,
  executablePath: string
): Promise<TerminationResult> {
  const initial = await listDedicatedProcessIds(profilePath, executablePath)
  signalProcesses(initial, 'SIGTERM')
  let remaining = await waitForProcessExit(profilePath, executablePath, 5_000)
  const forcedProcessCount = remaining.length

  if (remaining.length > 0) {
    signalProcesses(remaining, 'SIGKILL')
    remaining = await waitForProcessExit(profilePath, executablePath, 2_000)
  }

  if (remaining.length > 0) {
    throw new Error('独立浏览器仍在运行，未清除任何资料。请关闭验证窗口后重试。')
  }

  return {
    requestedProcessCount: initial.length,
    forcedProcessCount
  }
}

function signalProcesses(processIds: number[], signal: NodeJS.Signals): void {
  for (const processId of processIds) {
    try {
      process.kill(processId, signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') throw error
    }
  }
}

async function waitForProcessExit(
  profilePath: string,
  executablePath: string,
  timeoutMs: number
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = await listDedicatedProcessIds(profilePath, executablePath)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 125))
    remaining = await listDedicatedProcessIds(profilePath, executablePath)
  }
  return remaining
}
