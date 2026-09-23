import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import type {
  PilotActivity,
  PilotBrowserId,
  PilotBrowserOption,
  PilotState
} from '../shared/types'
import {
  assertDedicatedProfilePath,
  buildBrowserPageArguments,
  browserSpecsForPlatform,
  buildBrowserLaunchArguments,
  detectBrowsers,
  listDedicatedProcessIds,
  profilePathForBrowser,
  terminateDedicatedProcesses,
  type BrowserSpec
} from './browser-environment'

const APP_NAME = 'ChatGPT Web Next Login Pilot'
const CHATGPT_URL = 'https://chatgpt.com/'
const outputDirectory = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(outputDirectory, '../preload/index.cjs')
const rendererPath = join(outputDirectory, '../renderer/index.html')
const testRoot = process.env.CHATGPT_LOGIN_PILOT_TEST_ROOT

app.setName(APP_NAME)
if (testRoot) {
  app.setPath('userData', join(testRoot, 'control-data'))
} else {
  app.setPath('userData', join(app.getPath('appData'), APP_NAME))
}

class LoginPilotController {
  private window: BrowserWindow | null = null
  private specs: BrowserSpec[] = []
  private options: PilotBrowserOption[] = []
  private selectedBrowser: PilotBrowserId = 'chrome'
  private activity: PilotActivity = 'idle'
  private message = '请选择浏览器并打开独立登录环境。'
  private error: string | null = null
  private lastActionAt: string | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private readonly profilesRoot = join(app.getPath('userData'), 'BrowserProfiles')
  private readonly workExtensionPath = resolveWorkExtensionPath()

  async initialize(): Promise<void> {
    const testExecutable = testRoot
      ? process.env.CHATGPT_LOGIN_PILOT_TEST_BROWSER_EXECUTABLE
      : undefined
    const detected = await detectBrowsers(
      browserSpecsForPlatform(process.platform, process.env, testExecutable)
    )
    this.specs = detected.specs
    this.options = detected.options
    this.selectedBrowser =
      this.options.find((browser) => browser.available)?.id ?? this.options[0]?.id ?? 'chrome'

    await mkdir(this.profilesRoot, { recursive: true })
    this.window = this.createWindow()
    await this.loadRenderer(this.window)
    this.window.show()
    this.pollTimer = setInterval(() => void this.broadcast(), 2_000)
    await this.broadcast()
  }

  focus(): void {
    if (!this.window || this.window.isDestroyed()) return
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }

  async selectBrowser(browserId: PilotBrowserId): Promise<PilotState> {
    if (!this.options.some((browser) => browser.id === browserId)) {
      throw new Error('不支持所选浏览器。')
    }
    this.selectedBrowser = browserId
    this.error = null
    this.message = `${this.selectedOption().name} 已选中。`
    return this.broadcast()
  }

  async getState(): Promise<PilotState> {
    return this.snapshot()
  }

  async launch(): Promise<PilotState> {
    if (this.activity !== 'idle') return this.snapshot()
    this.activity = 'launching'
    this.error = null
    await this.broadcast()

    try {
      await this.launchSelectedBrowser()
      this.message = `已用真实 ${this.selectedOption().name} 打开独立 ChatGPT 环境。`
      this.lastActionAt = new Date().toISOString()
    } catch (error) {
      this.error = errorMessage(error)
      this.message = '浏览器未能打开。'
    } finally {
      this.activity = 'idle'
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
    return this.broadcast()
  }

  async prepareWorkExtension(): Promise<PilotState> {
    if (this.activity !== 'idle') return this.snapshot()
    this.activity = 'preparing-extension'
    this.error = null
    await this.broadcast()

    try {
      if (this.selectedBrowser !== 'chrome') {
        throw new Error('本轮 Work 检测只校准 Google Chrome，请先选择 Chrome。')
      }
      await access(join(this.workExtensionPath, 'manifest.json'))
      await this.ensureDedicatedProfile()
      clipboard.writeText(this.workExtensionPath)
      if (!testRoot) shell.showItemInFolder(join(this.workExtensionPath, 'manifest.json'))
      await this.launchSelectedBrowserPage('chrome://extensions/')
      this.message =
        '检测扩展目录已复制并在访达中标出。请在 Chrome 扩展页开启开发者模式，选择“加载已解压的扩展程序”，再粘贴或选择该目录。'
      this.lastActionAt = new Date().toISOString()
    } catch (error) {
      this.error = errorMessage(error)
      this.message = '检测扩展未能准备完成。'
    } finally {
      this.activity = 'idle'
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
    return this.broadcast()
  }

  async clearAndRelaunch(): Promise<PilotState> {
    if (this.activity !== 'idle') return this.snapshot()
    const option = this.selectedOption()
    const confirmation = testRoot
      ? process.env.CHATGPT_LOGIN_PILOT_TEST_CLEAR_RESPONSE === 'accept'
        ? 0
        : 1
      : (
          await (this.window
            ? dialog.showMessageBox(this.window, {
                type: 'warning',
                title: '清除独立登录环境',
                message: `确定清除 ${option.name} 验证环境吗？`,
                detail:
                  '这会关闭验证版打开的浏览器窗口，并清除其中的账号登录、Cookie、缓存和全部网页资料。你的日常浏览器资料不会受到影响。清除后会自动打开全新环境。',
                buttons: ['清除并重新打开', '取消'],
                defaultId: 1,
                cancelId: 1,
                noLink: true
              })
            : dialog.showMessageBox({
            type: 'warning',
            title: '清除独立登录环境',
            message: `确定清除 ${option.name} 验证环境吗？`,
            detail:
              '这会关闭验证版打开的浏览器窗口，并清除其中的账号登录、Cookie、缓存和全部网页资料。你的日常浏览器资料不会受到影响。清除后会自动打开全新环境。',
            buttons: ['清除并重新打开', '取消'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
              }))
        ).response

    if (confirmation !== 0) {
      this.message = '已取消清除。'
      return this.broadcast()
    }

    this.activity = 'clearing'
    this.error = null
    await this.broadcast()

    try {
      const spec = this.selectedSpec()
      const profilePath = this.selectedProfilePath()
      assertDedicatedProfilePath(this.profilesRoot, profilePath, this.selectedBrowser)
      const termination = await terminateDedicatedProcesses(profilePath, spec.executablePath)
      if (await pathExists(profilePath)) await this.moveProfileToTrash(profilePath)
      if (await pathExists(profilePath)) {
        throw new Error('独立浏览器资料未能完全移除，未重新打开浏览器。')
      }

      await this.launchSelectedBrowser()
      const forcedNote = termination.forcedProcessCount > 0 ? '（浏览器已被强制关闭）' : ''
      this.message = `独立登录资料已清除，并已打开全新 ${option.name} 环境${forcedNote}。Work 检测扩展也已随资料清除，需要重新加载。`
      this.lastActionAt = new Date().toISOString()
    } catch (error) {
      this.error = errorMessage(error)
      this.message = '未完成清除；原有资料不会被当作已清除。'
    } finally {
      this.activity = 'idle'
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
    return this.broadcast()
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 780,
      height: 780,
      minWidth: 680,
      minHeight: 680,
      show: false,
      title: 'ChatGPT Web Next 登录验证版',
      backgroundColor: '#f4f5f7',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      const currentUrl = window.webContents.getURL()
      if (url !== currentUrl) event.preventDefault()
    })
    window.on('closed', () => {
      this.window = null
    })
    return window
  }

  private async loadRenderer(window: BrowserWindow): Promise<void> {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      await window.loadURL(developmentUrl)
    } else {
      await window.loadFile(rendererPath)
    }
  }

  private selectedSpec(): BrowserSpec {
    const spec = this.specs.find((browser) => browser.id === this.selectedBrowser)
    if (!spec) throw new Error('找不到所选浏览器。')
    return spec
  }

  private selectedOption(): PilotBrowserOption {
    const option = this.options.find((browser) => browser.id === this.selectedBrowser)
    if (!option) throw new Error('找不到所选浏览器。')
    return option
  }

  private selectedProfilePath(): string {
    return profilePathForBrowser(this.profilesRoot, this.selectedBrowser)
  }

  private async launchSelectedBrowser(): Promise<void> {
    const option = this.selectedOption()
    if (!option.available) throw new Error(`${option.name} 未安装或无法执行。`)

    const spec = this.selectedSpec()
    const profilePath = await this.ensureDedicatedProfile()
    await this.spawnBrowser(
      spec.executablePath,
      buildBrowserLaunchArguments(profilePath, CHATGPT_URL)
    )
  }

  private async launchSelectedBrowserPage(targetUrl: string): Promise<void> {
    const option = this.selectedOption()
    if (!option.available) throw new Error(`${option.name} 未安装或无法执行。`)
    const spec = this.selectedSpec()
    const profilePath = await this.ensureDedicatedProfile()
    await this.spawnBrowser(
      spec.executablePath,
      buildBrowserPageArguments(profilePath, targetUrl)
    )
  }

  private async ensureDedicatedProfile(): Promise<string> {
    const profilePath = this.selectedProfilePath()
    assertDedicatedProfilePath(this.profilesRoot, profilePath, this.selectedBrowser)
    await mkdir(profilePath, { recursive: true })
    await writeFile(
      join(profilePath, '.chatgpt-web-next-login-pilot.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          browser: this.selectedBrowser,
          profileId: randomUUID(),
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      { flag: 'wx' }
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    return profilePath
  }

  private async spawnBrowser(executablePath: string, args: string[]): Promise<void> {
    const child = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore'
    })
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const onError = (error: Error): void => rejectLaunch(error)
      child.once('error', onError)
      child.once('spawn', () => {
        child.off('error', onError)
        child.unref()
        resolveLaunch()
      })
    })
  }

  private async moveProfileToTrash(profilePath: string): Promise<void> {
    if (testRoot) {
      const testTrash = join(testRoot, 'recoverable-trash')
      await mkdir(testTrash, { recursive: true })
      await rename(profilePath, join(testTrash, `${this.selectedBrowser}-${Date.now()}-${randomUUID()}`))
      return
    }
    await shell.trashItem(profilePath)
  }

  private async snapshot(): Promise<PilotState> {
    const profilePath = this.selectedProfilePath()
    const spec = this.selectedSpec()
    return {
      browsers: this.options,
      selectedBrowser: this.selectedBrowser,
      activity: this.activity,
      profilePath,
      profileExists: await pathExists(profilePath),
      runningProcessCount: (await listDedicatedProcessIds(profilePath, spec.executablePath)).length,
      workExtensionPath: this.workExtensionPath,
      workExtensionSourceReady: await pathExists(join(this.workExtensionPath, 'manifest.json')),
      message: this.message,
      error: this.error,
      lastActionAt: this.lastActionAt
    }
  }

  private async broadcast(): Promise<PilotState> {
    const state = await this.snapshot()
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('pilot:state-updated', state)
    }
    return state
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveWorkExtensionPath(): string {
  const override = process.env.CHATGPT_WORK_PILOT_EXTENSION_DIR
  if (override) return join(override)
  if (app.isPackaged) return join(process.resourcesPath, 'work-pilot-extension')
  return join(app.getAppPath(), 'out-chrome-work-pilot')
}

function assertLocalSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? ''
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  const isLocalFile = senderUrl.startsWith('file://')
  const isDevelopmentPage = Boolean(developmentUrl && senderUrl.startsWith(developmentUrl))
  if (!isLocalFile && !isDevelopmentPage) throw new Error('拒绝非本地界面调用。')
}

let controller: LoginPilotController | null = null
const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => controller?.focus())

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    controller = new LoginPilotController()
    ipcMain.handle('pilot:get-state', (event) => {
      assertLocalSender(event)
      return controller?.getState()
    })
    ipcMain.handle('pilot:select-browser', (event, browserId: PilotBrowserId) => {
      assertLocalSender(event)
      return controller?.selectBrowser(browserId)
    })
    ipcMain.handle('pilot:launch', (event) => {
      assertLocalSender(event)
      return controller?.launch()
    })
    ipcMain.handle('pilot:prepare-work-extension', (event) => {
      assertLocalSender(event)
      return controller?.prepareWorkExtension()
    })
    ipcMain.handle('pilot:clear-and-relaunch', (event) => {
      assertLocalSender(event)
      return controller?.clearAndRelaunch()
    })
    await controller.initialize()
  }).catch(async (error: unknown) => {
    await dialog.showMessageBox({
      type: 'error',
      title: '登录验证版无法启动',
      message: '登录验证版初始化失败。',
      detail: errorMessage(error)
    })
    app.quit()
  })

  app.on('activate', () => controller?.focus())
  app.on('before-quit', () => controller?.dispose())
  app.on('window-all-closed', () => app.quit())
}
