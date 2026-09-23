import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from 'electron'
import type {
  NativeLoginPilotActivity,
  NativeLoginPilotState,
  NativeLoginPopupStatus
} from '../shared/types'
import {
  guardPopupNavigation,
  installNativePopupPolicy,
  isChatGptPageUrl,
  isIdentityProviderUrl,
  safeHost,
  type NativePopupEvent,
  type NativePopupPolicyOptions
} from './popup-policy'

const APP_NAME = 'ChatGPT Web Next Native Login Pilot'
const PARTITION = 'persist:chatgpt-native-login-pilot'
const TOOLBAR_HEIGHT = 64
const outputDirectory = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(outputDirectory, '../preload/index.cjs')
const rendererPath = join(outputDirectory, '../renderer/index.html')
const testRoot = process.env.CHATGPT_NATIVE_LOGIN_PILOT_TEST_ROOT
const targetUrl = process.env.CHATGPT_NATIVE_LOGIN_PILOT_TEST_URL ?? 'https://chatgpt.com/'

app.setName(APP_NAME)
if (testRoot) {
  app.setPath('appData', join(testRoot, 'app-data'))
  app.setPath('userData', join(testRoot, 'browser-data'))
} else {
  app.setPath('userData', join(app.getPath('appData'), APP_NAME))
}

class NativeLoginPilotController {
  private toolbar: BrowserWindow | null = null
  private remoteView: WebContentsView | null = null
  private remoteSession: Session | null = null
  private readonly authWindows = new Set<BrowserWindow>()
  private activity: NativeLoginPilotActivity = 'idle'
  private popupCount = 0
  private popupStatus: NativeLoginPopupStatus = 'none'
  private pageStage: NativeLoginPilotState['pageStage'] = 'other'
  private currentPageHost: string | null = null
  private lastPopupHost: string | null = null
  private lastBlockedHost: string | null = null
  private message = '请在 ChatGPT 中选择“使用 Google 登录”，验证原生弹窗。'
  private error: string | null = null
  private readonly testAllowedOrigins = readTestAllowedOrigins()

  async initialize(): Promise<void> {
    const toolbar = this.createToolbar()
    const remoteSession = session.fromPartition(PARTITION, { cache: true })
    denyAllPermissions(remoteSession)
    const remoteView = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: true
      }
    })

    this.toolbar = toolbar
    this.remoteView = remoteView
    this.remoteSession = remoteSession
    toolbar.contentView.addChildView(remoteView)
    this.layout()
    toolbar.on('resize', () => this.layout())
    toolbar.on('enter-full-screen', () => this.layout())
    toolbar.on('leave-full-screen', () => this.layout())

    const popupOptions = this.popupOptions()
    guardPopupNavigation(remoteView.webContents, popupOptions)
    installNativePopupPolicy(remoteView.webContents, popupOptions)
    remoteView.webContents.on('did-navigate', (_event, url) => this.handleMainNavigation(url))
    remoteView.webContents.on('did-navigate-in-page', (_event, url) =>
      this.handleMainNavigation(url)
    )
    remoteView.webContents.on('did-finish-load', () =>
      this.handleMainNavigation(remoteView.webContents.getURL())
    )
    remoteView.webContents.on(
      'did-fail-load',
      (_event, errorCode, description, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        this.error = description
        this.message = `页面加载失败：${safeHost(validatedUrl) ?? '未知地址'}`
        this.broadcast()
      }
    )

    await this.loadToolbar(toolbar)
    toolbar.show()
    await remoteView.webContents.loadURL(targetUrl)
    this.broadcast()

    toolbar.once('close', () => {
      this.closeAuthWindows()
      toolbar.contentView.removeChildView(remoteView)
      if (!remoteView.webContents.isDestroyed()) {
        remoteView.webContents.close({ waitForBeforeUnload: false })
      }
    })
    toolbar.on('closed', () => {
      this.toolbar = null
      this.remoteView = null
      this.remoteSession = null
    })
  }

  focus(): void {
    const toolbar = this.toolbar
    if (!toolbar || toolbar.isDestroyed()) return
    if (toolbar.isMinimized()) toolbar.restore()
    toolbar.show()
    toolbar.focus()
  }

  ownsSender(sender: WebContents): boolean {
    return Boolean(this.toolbar && !this.toolbar.isDestroyed() && this.toolbar.webContents === sender)
  }

  getState(): NativeLoginPilotState {
    return {
      activity: this.activity,
      popupStrategy: 'native',
      persistentSession: true,
      popupCount: this.popupCount,
      activePopupCount: this.authWindows.size,
      popupStatus: this.popupStatus,
      pageStage: this.pageStage,
      currentPageHost: this.currentPageHost,
      lastPopupHost: this.lastPopupHost,
      lastBlockedHost: this.lastBlockedHost,
      message: this.message,
      error: this.error
    }
  }

  refresh(hard = false): NativeLoginPilotState {
    const contents = this.remoteView?.webContents
    if (!contents || contents.isDestroyed()) return this.getState()
    if (hard) contents.reloadIgnoringCache()
    else contents.reload()
    this.message = hard ? '正在强制刷新 ChatGPT…' : '正在刷新 ChatGPT…'
    this.error = null
    this.broadcast()
    return this.getState()
  }

  async clearWebData(): Promise<NativeLoginPilotState> {
    const toolbar = this.toolbar
    const remoteSession = this.remoteSession
    const remoteContents = this.remoteView?.webContents
    if (!toolbar || !remoteSession || !remoteContents) return this.getState()

    const accepted = testRoot
      ? process.env.CHATGPT_NATIVE_LOGIN_PILOT_TEST_CLEAR_RESPONSE === 'accept'
      :
          (
            await dialog.showMessageBox(toolbar, {
              type: 'warning',
              title: '清除独立登录环境',
              message: '确定清除验证版中的登录及全部网页数据吗？',
              detail:
                '这只会清除 Electron 原生弹窗验证版，不会影响正式版、Chrome 验证版或日常浏览器。清除后会重新打开 ChatGPT。',
              buttons: ['取消', '清除并重新加载'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            })
          ).response === 1

    if (!accepted) {
      this.message = '已取消清除。'
      this.broadcast()
      return this.getState()
    }

    this.activity = 'clearing'
    this.error = null
    this.message = '正在清除登录、Cookie、缓存和网页数据…'
    this.broadcast()

    try {
      this.closeAuthWindows()
      await Promise.all([
        remoteSession.clearCache(),
        remoteSession.clearAuthCache(),
        remoteSession.clearStorageData()
      ])
      await remoteContents.loadURL(targetUrl)
      this.popupStatus = 'none'
      this.lastPopupHost = null
      this.lastBlockedHost = null
      this.message = '独立登录环境已清除，ChatGPT 已重新加载。'
    } catch (error) {
      this.popupStatus = 'error'
      this.error = errorMessage(error)
      this.message = '网页数据未能完整清除。'
    } finally {
      this.activity = 'idle'
      this.broadcast()
    }

    return this.getState()
  }

  private createToolbar(): BrowserWindow {
    const toolbar = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: 'ChatGPT Web Next — Electron 原生登录验证',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 22 } : undefined,
      backgroundColor: '#f5f5f4',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    toolbar.webContents.on('will-navigate', (event, url) => {
      if (url !== toolbar.webContents.getURL()) event.preventDefault()
    })
    return toolbar
  }

  private popupOptions(): NativePopupPolicyOptions {
    const toolbar = this.toolbar
    const remoteSession = this.remoteSession
    if (!toolbar || !remoteSession) throw new Error('登录验证窗口尚未初始化。')
    return {
      ownerWindow: toolbar,
      partition: PARTITION,
      expectedSession: remoteSession,
      showWindows: true,
      testAllowedOrigins: this.testAllowedOrigins,
      onEvent: (event) => this.handlePopupEvent(event)
    }
  }

  private handlePopupEvent(event: NativePopupEvent): void {
    if (event.type === 'created' && event.window) {
      this.authWindows.add(event.window)
      this.popupCount += 1
      this.popupStatus = 'created'
      this.lastPopupHost = event.host
      this.error = null
      this.message = '原生登录弹窗已创建，并与 ChatGPT 共用同一登录环境。'
    } else if (event.type === 'closed' && event.window) {
      this.authWindows.delete(event.window)
      this.popupStatus = 'closed'
      this.message = '登录弹窗已关闭；请检查 ChatGPT 是否已经登录。'
    } else if (event.type === 'blocked') {
      this.popupStatus = 'blocked'
      this.lastBlockedHost = event.host
      this.error = `已拦截非登录地址：${event.host ?? '未知地址'}`
      this.message = '为保护登录环境，未打开非白名单地址。'
    } else if (event.type === 'session-mismatch') {
      this.popupStatus = 'error'
      this.error = '登录弹窗没有使用与 ChatGPT 相同的会话，已安全关闭。'
      this.message = '检测到会话不一致。'
    } else if (event.type === 'load-failed') {
      this.popupStatus = 'error'
      this.error = `登录页面加载失败：${event.host ?? '未知地址'}`
      this.message = '登录弹窗加载失败。'
    }
    this.broadcast()
  }

  private handleMainNavigation(url: string): void {
    this.currentPageHost = safeHost(url)
    if (isIdentityProviderUrl(url)) {
      this.pageStage = 'authentication'
      this.message = 'ChatGPT 已在当前页面进入身份验证；网页本次没有创建登录弹窗。'
    } else if (isChatGptPageUrl(url)) {
      this.pageStage = 'chatgpt'
      this.message = 'ChatGPT 页面已就绪；如果网页创建弹窗，验证版会保留原生关系。'
    } else {
      this.pageStage = 'other'
      this.message = '页面已加载。'
    }
    this.error = null
    this.broadcast()
  }

  private closeAuthWindows(): void {
    for (const window of this.authWindows) {
      if (!window.isDestroyed()) window.destroy()
    }
    this.authWindows.clear()
  }

  private layout(): void {
    const toolbar = this.toolbar
    const remoteView = this.remoteView
    if (!toolbar || !remoteView) return
    const bounds = toolbar.getContentBounds()
    remoteView.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height - TOOLBAR_HEIGHT)
    })
  }

  private async loadToolbar(toolbar: BrowserWindow): Promise<void> {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) await toolbar.loadURL(developmentUrl)
    else await toolbar.loadFile(rendererPath)
  }

  private broadcast(): void {
    const toolbar = this.toolbar
    if (!toolbar || toolbar.isDestroyed()) return
    toolbar.webContents.send('native-login-pilot:state-updated', this.getState())
  }
}

function readTestAllowedOrigins(): ReadonlySet<string> {
  if (!testRoot) return new Set()
  return new Set(
    (process.env.CHATGPT_NATIVE_LOGIN_PILOT_TEST_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
}

function denyAllPermissions(remoteSession: Session): void {
  remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  remoteSession.setPermissionCheckHandler(() => false)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const controller = new NativeLoginPilotController()
let hasRegisteredIpc = false

function assertToolbarSender(event: IpcMainInvokeEvent): void {
  if (!controller.ownsSender(event.sender)) throw new Error('拒绝未授权的界面调用。')
}

function registerIpc(): void {
  if (hasRegisteredIpc) return
  hasRegisteredIpc = true
  ipcMain.handle('native-login-pilot:get-state', (event) => {
    assertToolbarSender(event)
    return controller.getState()
  })
  ipcMain.handle('native-login-pilot:refresh', (event) => {
    assertToolbarSender(event)
    return controller.refresh(false)
  })
  ipcMain.handle('native-login-pilot:hard-refresh', (event) => {
    assertToolbarSender(event)
    return controller.refresh(true)
  })
  ipcMain.handle('native-login-pilot:clear-web-data', async (event) => {
    assertToolbarSender(event)
    return controller.clearWebData()
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => controller.focus())
  app.whenReady().then(async () => {
    registerIpc()
    await controller.initialize()
  }).catch(async (error: unknown) => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Electron 原生登录验证版无法启动',
      message: '验证版初始化失败。',
      detail: errorMessage(error)
    })
    app.quit()
  })
  app.on('activate', () => controller.focus())
  app.on('window-all-closed', () => app.quit())
}
