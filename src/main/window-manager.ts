import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  screen,
  session,
  type Session,
  type WebContents
} from 'electron'
import type {
  DetectorHealth,
  DownloadPanelAnchor,
  LogoId,
  LoginState,
  ToolbarState
} from '../shared/types'
import { NETWORK_REFRESH_MS } from '../shared/types'
import {
  deriveWorkSnapshot,
  freezeWorkTimerOnStartup,
  maskDeviceId,
  materializeWorkTimer,
  pauseWorkTimer,
  resumeWorkTimer
} from '../shared/work-state'
import { CalibrationRecorder } from './calibration-recorder'
import {
  detectLoginState,
  readWorkUsageMetadata,
  shouldRefreshNetworkAfterLoginCheck
} from './chatgpt-page-state'
import { DeviceStateStore } from './device-state-store'
import { DownloadManager } from './download-manager'
import { DownloadStore } from './download-store'
import { LogoService } from './logo-service'
import { createLocationCachePath, NetworkService } from './network-service'
import {
  installNativePopupPolicy,
  isAuthenticationPageUrl,
  isChatGptPageUrl,
  safeHost,
  type NativePopupEvent
} from './native-popup-policy'
import { PreferencesStore } from './preferences-store'
import { SafetyController } from './safety-controller'
import { configureRemoteSession, confirmExternalNavigation, guardNavigation } from './security'
import { WorkDetector, type WorkAcceptedEvent } from './work-detector'
import { WorkUsageStore } from './work-usage-store'

const TOOLBAR_HEIGHT = 54
const CHATGPT_URL = process.env.CHATGPT_WEB_NEXT_TEST_ROOT
  ? (process.env.CHATGPT_WEB_NEXT_TEST_URL ?? 'https://chatgpt.com/')
  : 'https://chatgpt.com/'
const SHOULD_SHOW_WINDOWS = !process.env.CHATGPT_WEB_NEXT_TEST_ROOT
const SHOULD_RUN_DETECTOR =
  !process.env.CHATGPT_WEB_NEXT_TEST_ROOT ||
  process.env.CHATGPT_WEB_NEXT_TEST_ENABLE_DETECTOR === '1'
const LOGIN_REFRESH_MS = 30_000
const TIMER_CHECKPOINT_MS = 15_000
const DOWNLOAD_PANEL_WIDTH = 410
const DOWNLOAD_PANEL_MIN_HEIGHT = 250
const DOWNLOAD_PANEL_MAX_HEIGHT = 560

interface ManagedWindow {
  toolbar: BrowserWindow
  remoteView: WebContentsView | null
  remoteSession: Session
  partition: string
  kind: 'normal' | 'incognito'
  detector: WorkDetector | null
  network: NetworkService
  networkTimer: NodeJS.Timeout
  loginTimer: NodeJS.Timeout
  loginDebounce: NodeJS.Timeout | null
  loginCheck: Promise<void> | null
  loginState: LoginState
  accountName: string
  settings: Set<BrowserWindow>
  downloadsWindow: BrowserWindow | null
  authWindows: Set<BrowserWindow>
  cookieChanged: () => void
}

export class WindowManager {
  private readonly windows = new Set<ManagedWindow>()
  private readonly senderOwners = new Map<number, ManagedWindow>()
  private readonly configuredSessions = new Set<Session>()
  private readonly preloadPath: string
  private readonly rendererPath: string
  private readonly downloadManager: DownloadManager
  private readonly logoService = new LogoService()
  private readonly safety: SafetyController
  private readonly metadataTimers = new Set<NodeJS.Timeout>()
  private readonly timerCheckpoint: NodeJS.Timeout
  private suspended = false
  private preparingToQuit = false
  private readonly testClearDataResponses = process.env.CHATGPT_WEB_NEXT_TEST_ROOT
    ? (process.env.CHATGPT_WEB_NEXT_TEST_CLEAR_DATA_RESPONSES ?? '').split(',')
    : []
  private readonly testAllowedOrigins = process.env.CHATGPT_WEB_NEXT_TEST_ROOT
    ? readAllowedOrigins(process.env.CHATGPT_WEB_NEXT_TEST_ALLOWED_ORIGINS)
    : new Set<string>()
  private readonly testAuthenticationOrigins = process.env.CHATGPT_WEB_NEXT_TEST_ROOT
    ? readAllowedOrigins(process.env.CHATGPT_WEB_NEXT_TEST_AUTHENTICATION_ORIGINS)
    : new Set<string>()
  private testClearDataResponseIndex = 0

  constructor(
    private readonly store: DeviceStateStore,
    private readonly usageStore: WorkUsageStore,
    downloadStore: DownloadStore,
    private readonly preferencesStore: PreferencesStore,
    private readonly appDataPath: string,
    outputDirectory: string
  ) {
    this.preloadPath = join(outputDirectory, '../preload/index.cjs')
    this.rendererPath = join(outputDirectory, '../renderer/index.html')
    this.downloadManager = new DownloadManager(
      downloadStore,
      () => this.sendAllStates(),
      this.testAllowedOrigins,
      this.testAuthenticationOrigins
    )
    this.safety = new SafetyController(
      store,
      () => this.clearAllWebEnvironments(),
      async () => {
        try {
          await this.prepareForQuit()
        } finally {
          app.quit()
        }
      },
      () => this.sendAllStates(),
      {
        clearAfterMs: readPositiveTestNumber('CHATGPT_WEB_NEXT_TEST_SAFETY_CLEAR_MS', 10_000),
        quitAfterMs: readPositiveTestNumber('CHATGPT_WEB_NEXT_TEST_SAFETY_QUIT_MS', 30_000)
      }
    )
    this.timerCheckpoint = setInterval(() => void this.checkpointWorkTimer(), TIMER_CHECKPOINT_MS)
  }

  async initializeBeforeWindows(): Promise<void> {
    await this.store.update((state) => freezeWorkTimerOnStartup(state))
    const selected = this.preferencesStore.getSnapshot().selectedLogoId
    const applied = this.logoService.apply(selected)
    if (applied !== selected) await this.preferencesStore.select(applied)
    await this.safety.recoverBeforePageLoad()
  }

  async createWindow(kind: 'normal' | 'incognito'): Promise<ManagedWindow> {
    if (this.safety.getSnapshot().loginBlocked) {
      const existing = [...this.windows][0]
      if (existing) return existing
      throw new Error('安全清理期间不能新建网页窗口')
    }

    const toolbar = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 980,
      minHeight: 640,
      show: false,
      title: kind === 'incognito' ? 'ChatGPT Web Next — 无痕' : 'ChatGPT Web Next',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 19 } : undefined,
      backgroundColor: '#f5f5f4',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    const windowTitle = kind === 'incognito' ? 'ChatGPT Web Next — 独立无痕' : 'ChatGPT Web Next'
    toolbar.on('page-title-updated', (event) => {
      event.preventDefault()
      toolbar.setTitle(windowTitle)
    })
    toolbar.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error('Local interface failed to load', { code, description, url })
    })
    toolbar.webContents.on('render-process-gone', (_event, details) => {
      console.error('Local interface renderer stopped', details)
    })

    const partition = kind === 'normal' ? 'persist:chatgpt-main' : `incognito-${randomUUID()}`
    const remoteSession = session.fromPartition(partition, { cache: true })
    if (!this.configuredSessions.has(remoteSession)) {
      configureRemoteSession(remoteSession)
      this.configuredSessions.add(remoteSession)
    }
    this.downloadManager.attach(remoteSession, kind)

    const remoteView = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: true
      }
    })
    toolbar.contentView.addChildView(remoteView)

    const recorder = new CalibrationRecorder(app.getPath('logs'))
    const owner: { current?: ManagedWindow } = {}
    const onChange = (): void => {
      if (owner.current) this.sendState(owner.current)
    }
    const detector =
      kind === 'normal'
        ? new WorkDetector(
            remoteView.webContents,
            kind,
            this.store,
            recorder,
            onChange,
            remoteSession,
            (event) => this.handleWorkAccepted(owner.current, event),
            (state, event) =>
              this.safety.prepareAcceptedState(state, event.operationHash, event.acceptedAt)
          )
        : null
    const network = new NetworkService(
      remoteSession,
      createLocationCachePath(this.appDataPath),
      onChange,
      {
        traceUrl: process.env.CHATGPT_WEB_NEXT_TEST_ROOT
          ? (process.env.CHATGPT_WEB_NEXT_TEST_TRACE_URL ?? new URL('/cdn-cgi/trace', CHATGPT_URL).toString())
          : undefined,
        fetchLocation: process.env.CHATGPT_WEB_NEXT_TEST_ROOT
          ? async () => new Response(JSON.stringify({
              success: true,
              country: 'Testland',
              city: 'Fixture City',
              timezone: { id: 'UTC' }
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          : undefined
      }
    )
    const networkTimer = setInterval(() => void network.refresh(), NETWORK_REFRESH_MS)
    const loginTimer = setInterval(() => {
      if (owner.current) void this.checkLogin(owner.current)
    }, LOGIN_REFRESH_MS)
    const cookieChanged = (): void => {
      const current = owner.current
      if (!current || current.loginDebounce) return
      current.loginDebounce = setTimeout(() => {
        current.loginDebounce = null
        void this.checkLogin(current)
      }, 500)
    }
    remoteSession.cookies.on('changed', cookieChanged)

    const managed: ManagedWindow = {
      toolbar,
      remoteView,
      remoteSession,
      partition,
      kind,
      detector,
      network,
      networkTimer,
      loginTimer,
      loginDebounce: null,
      loginCheck: null,
      loginState: 'checking',
      accountName: '未识别账号',
      settings: new Set(),
      downloadsWindow: null,
      authWindows: new Set(),
      cookieChanged
    }
    owner.current = managed
    this.windows.add(managed)
    this.installRefreshShortcuts(toolbar.webContents, managed)
    this.installRefreshShortcuts(remoteView.webContents, managed)
    const toolbarWebContentsId = toolbar.webContents.id
    this.senderOwners.set(toolbarWebContentsId, managed)

    const layout = (): void => {
      if (!managed.remoteView) return
      const bounds = toolbar.getContentBounds()
      managed.remoteView.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height - TOOLBAR_HEIGHT)
      })
    }
    toolbar.on('resize', () => {
      layout()
      this.closeDownloads(managed)
    })
    toolbar.on('move', () => this.closeDownloads(managed))
    toolbar.on('enter-full-screen', layout)
    toolbar.on('leave-full-screen', layout)
    layout()

    this.configureRemoteContents(managed)
    await this.loadLocalPage(toolbar, 'toolbar')
    if (SHOULD_SHOW_WINDOWS) toolbar.show()
    void remoteView.webContents.loadURL(CHATGPT_URL).catch(() => undefined)
    void network.refresh()

    toolbar.once('close', () => {
      detector?.dispose()
      this.closeDownloads(managed)
      this.closeAuthWindows(managed)
      this.removeRemoteView(managed)
    })

    toolbar.on('closed', () => {
      clearInterval(networkTimer)
      clearInterval(loginTimer)
      if (managed.loginDebounce) clearTimeout(managed.loginDebounce)
      remoteSession.cookies.off('changed', cookieChanged)
      for (const settingsWindow of managed.settings) {
        if (!settingsWindow.isDestroyed()) settingsWindow.destroy()
      }
      this.senderOwners.delete(toolbarWebContentsId)
      this.windows.delete(managed)
      if (kind === 'incognito') void clearSession(remoteSession)
      void this.reconcileWorkTimerWithLogin()
    })
    return managed
  }

  resolveSender(sender: WebContents): ManagedWindow {
    const managed = this.senderOwners.get(sender.id)
    if (!managed || sender.isDestroyed()) throw new Error('Untrusted IPC sender')
    return managed
  }

  getFocused(): ManagedWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused && process.env.CHATGPT_WEB_NEXT_TEST_ROOT) {
      return [...this.windows].find((item) => item.kind === 'normal') ?? null
    }
    if (!focused) return null
    return this.senderOwners.get(focused.webContents.id) ?? null
  }

  focusNormalOrCreate(): void {
    const normal = [...this.windows].find((item) => item.kind === 'normal')
    if (normal) {
      if (normal.toolbar.isMinimized()) normal.toolbar.restore()
      normal.toolbar.show()
      normal.toolbar.focus()
    } else if (!this.safety.getSnapshot().loginBlocked) {
      void this.createWindow('normal')
    }
  }

  getState(managed: ManagedWindow): ToolbarState {
    const device = this.store.getState()
    const storageStatus = this.store.getStatus()
    return {
      windowKind: managed.kind,
      work: deriveWorkSnapshot(
        device,
        this.detectorHealth(),
        new Date(),
        this.detectorExpected()
      ),
      workRecords: this.usageStore.getRecords(),
      network: managed.network.getSnapshot(),
      safety: this.safety.getSnapshot(),
      downloads: this.downloadManager.getSnapshot(),
      preferences: this.preferencesStore.getSnapshot(),
      loginState: managed.loginState,
      maskedDeviceId: storageStatus === 'ready' ? maskDeviceId(device.deviceId) : '正在读取',
      storageStatus,
      storageWarning: this.store.getWarning()
    }
  }

  sendAllStates(): void {
    for (const managed of this.windows) this.sendState(managed)
  }

  refresh(managed: ManagedWindow, hard = false): void {
    const contents = managed.remoteView?.webContents
    if (!contents || contents.isDestroyed() || this.safety.getSnapshot().loginBlocked) return
    if (hard) contents.reloadIgnoringCache()
    else contents.reload()
  }

  adjustPageZoom(managed: ManagedWindow, delta: number): void {
    const contents = managed.remoteView?.webContents
    if (!contents || contents.isDestroyed()) return
    const next = Math.min(3, Math.max(0.5, Math.round((contents.getZoomFactor() + delta) * 10) / 10))
    contents.setZoomFactor(next)
  }

  resetPageZoom(managed: ManagedWindow): void {
    managed.remoteView?.webContents.setZoomFactor(1)
  }

  async clearCache(managed: ManagedWindow): Promise<boolean> {
    await managed.remoteSession.clearCache()
    this.refresh(managed)
    return true
  }

  async clearWebData(managed: ManagedWindow): Promise<boolean> {
    if (this.safety.getSnapshot().loginBlocked) return false
    if (!(await this.confirmWebDataClear(managed))) return false
    this.closeAuthWindows(managed)
    await clearSession(managed.remoteSession)
    managed.loginState = 'logged-out'
    managed.accountName = '未识别账号'
    await this.reconcileWorkTimerWithLogin()
    if (managed.remoteView && !managed.remoteView.webContents.isDestroyed()) {
      void managed.remoteView.webContents.loadURL(CHATGPT_URL).catch(() => undefined)
    }
    this.sendAllStates()
    return true
  }

  async refreshNetwork(managed: ManagedWindow): Promise<void> {
    await managed.network.refreshManually()
  }

  markNetworkOffline(managed: ManagedWindow): void {
    managed.network.markOffline()
  }

  async clearDownloadRecords(): Promise<void> {
    await this.downloadManager.clearRecords()
  }

  async revealDownload(downloadId: string): Promise<'revealed' | 'missing'> {
    return this.downloadManager.reveal(downloadId)
  }

  async toggleDownloads(
    managed: ManagedWindow,
    anchor: DownloadPanelAnchor
  ): Promise<void> {
    if (managed.downloadsWindow && !managed.downloadsWindow.isDestroyed()) {
      this.closeDownloads(managed)
      return
    }

    const recentCount = this.downloadManager.getSnapshot().recent.length
    const panelHeight = Math.min(
      DOWNLOAD_PANEL_MAX_HEIGHT,
      Math.max(DOWNLOAD_PANEL_MIN_HEIGHT, 132 + Math.max(1, recentCount) * 66)
    )
    const panel = new BrowserWindow({
      width: DOWNLOAD_PANEL_WIDTH,
      height: panelHeight,
      minWidth: DOWNLOAD_PANEL_WIDTH,
      maxWidth: DOWNLOAD_PANEL_WIDTH,
      minHeight: panelHeight,
      maxHeight: panelHeight,
      show: false,
      parent: managed.toolbar,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'ChatGPT Web Next 下载管理',
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    managed.downloadsWindow = panel
    panel.setMenuBarVisibility(false)
    panel.on('page-title-updated', (event) => {
      event.preventDefault()
      panel.setTitle('ChatGPT Web Next 下载管理')
    })

    const panelWebContentsId = panel.webContents.id
    this.senderOwners.set(panelWebContentsId, managed)
    let blurTimer: NodeJS.Timeout | null = null
    panel.on('blur', () => {
      blurTimer = setTimeout(() => {
        blurTimer = null
        if (managed.downloadsWindow === panel) this.closeDownloads(managed)
      }, 180)
    })
    panel.on('focus', () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = null
    })
    panel.on('closed', () => {
      if (blurTimer) clearTimeout(blurTimer)
      this.senderOwners.delete(panelWebContentsId)
      if (managed.downloadsWindow === panel) managed.downloadsWindow = null
    })

    const parentBounds = managed.toolbar.getContentBounds()
    const workArea = screen.getDisplayMatching(managed.toolbar.getBounds()).workArea
    const desiredX = parentBounds.x + Math.min(parentBounds.width, anchor.right) - DOWNLOAD_PANEL_WIDTH
    const desiredY = parentBounds.y + Math.min(TOOLBAR_HEIGHT, anchor.bottom) + 5
    panel.setPosition(
      clampInteger(desiredX, workArea.x + 8, workArea.x + workArea.width - DOWNLOAD_PANEL_WIDTH - 8),
      clampInteger(desiredY, workArea.y + 8, workArea.y + workArea.height - panelHeight - 8),
      false
    )

    try {
      await this.loadLocalPage(panel, 'downloads')
      if (SHOULD_SHOW_WINDOWS && managed.downloadsWindow === panel && !panel.isDestroyed()) {
        panel.show()
        panel.focus()
      }
    } catch (error) {
      if (!panel.isDestroyed()) panel.destroy()
      throw error
    }
  }

  closeDownloads(managed: ManagedWindow): void {
    const panel = managed.downloadsWindow
    managed.downloadsWindow = null
    if (panel && !panel.isDestroyed()) panel.destroy()
  }

  async selectLogo(logoId: LogoId): Promise<boolean> {
    const selected = await this.preferencesStore.select(logoId)
    if (!selected) return false
    const applied = this.logoService.apply(logoId)
    if (applied !== logoId) await this.preferencesStore.select(applied)
    this.sendAllStates()
    return applied === logoId
  }

  async openSettings(managed: ManagedWindow): Promise<void> {
    const existing = [...managed.settings].find((window) => !window.isDestroyed())
    if (existing) {
      existing.show()
      existing.focus()
      return
    }
    await this.usageStore.prune()
    const settingsWindow = new BrowserWindow({
      width: 680,
      height: 760,
      minWidth: 560,
      minHeight: 600,
      show: false,
      parent: managed.toolbar,
      title: 'ChatGPT Web Next 设置与状态',
      backgroundColor: '#f5f5f4',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    settingsWindow.on('page-title-updated', (event) => {
      event.preventDefault()
      settingsWindow.setTitle('ChatGPT Web Next 设置与状态')
    })
    managed.settings.add(settingsWindow)
    this.installRefreshShortcuts(settingsWindow.webContents, managed)
    const settingsWebContentsId = settingsWindow.webContents.id
    this.senderOwners.set(settingsWebContentsId, managed)
    settingsWindow.on('closed', () => {
      this.senderOwners.delete(settingsWebContentsId)
      managed.settings.delete(settingsWindow)
    })
    await this.loadLocalPage(settingsWindow, 'settings')
    if (SHOULD_SHOW_WINDOWS) settingsWindow.show()
  }

  async onSystemSuspend(): Promise<void> {
    this.suspended = true
    await this.store.update((state) => pauseWorkTimer(state))
    this.sendAllStates()
  }

  async onSystemResume(): Promise<void> {
    this.suspended = false
    this.safety.onSystemResume()
    await this.reconcileWorkTimerWithLogin()
    for (const managed of this.windows) void managed.network.refresh()
    this.sendAllStates()
  }

  async prepareForQuit(): Promise<void> {
    if (this.preparingToQuit) return
    this.preparingToQuit = true
    clearInterval(this.timerCheckpoint)
    for (const timer of this.metadataTimers) clearTimeout(timer)
    this.metadataTimers.clear()
    this.safety.dispose()
    await this.downloadManager.interruptAll('APP 退出时下载尚未完成')
    await this.store.update((state) => pauseWorkTimer(state))
  }

  private async handleWorkAccepted(
    managed: ManagedWindow | undefined,
    event: WorkAcceptedEvent
  ): Promise<void> {
    if (!managed || managed.kind !== 'normal') return
    managed.loginState = 'logged-in'
    this.safety.activatePersistedPlan()
    const metadata = managed.remoteView
      ? await readWorkUsageMetadata(managed.remoteView.webContents, managed.accountName)
      : {
          accountName: managed.accountName,
          projectName: '未归入项目',
          chatName: '未命名对话'
        }
    await this.usageStore.add(event.operationHash, metadata, event.acceptedAt)
    this.scheduleMetadataRefresh(managed, event.operationHash)
    this.sendAllStates()
  }

  private scheduleMetadataRefresh(managed: ManagedWindow, operationHash: string): void {
    for (const delay of [2_000, 5_000, 9_000]) {
      const timer = setTimeout(() => {
        this.metadataTimers.delete(timer)
        const contents = managed.remoteView?.webContents
        if (!contents || contents.isDestroyed() || this.safety.getSnapshot().loginBlocked) return
        void readWorkUsageMetadata(contents, managed.accountName)
          .then((metadata) => {
            if (this.safety.getSnapshot().loginBlocked) return undefined
            return this.usageStore.updateMetadata(operationHash, metadata)
          })
          .then(() => this.sendAllStates())
      }, delay)
      this.metadataTimers.add(timer)
    }
  }

  private async clearAllWebEnvironments(): Promise<void> {
    await this.downloadManager.interruptAll()
    await rm(createLocationCachePath(this.appDataPath), { force: true }).catch(() => undefined)
    const sessions = new Set<Session>([session.fromPartition('persist:chatgpt-main', { cache: true })])
    for (const managed of this.windows) {
      managed.detector?.pauseForAuthentication()
      this.closeDownloads(managed)
      this.closeAuthWindows(managed)
      sessions.add(managed.remoteSession)
      managed.loginState = 'logged-out'
      managed.accountName = '未识别账号'
      this.removeRemoteView(managed)
      await managed.network.clearAndPause()
    }
    await Promise.all([...sessions].map((remoteSession) => clearSession(remoteSession)))
    await this.store.update((state) => pauseWorkTimer(state))
    this.sendAllStates()
  }

  private async checkpointWorkTimer(): Promise<void> {
    const device = this.store.getState()
    if (!device.workTimerRunning) return
    await this.store.update((state) => materializeWorkTimer(state))
    this.sendAllStates()
  }

  private async checkLogin(managed: ManagedWindow): Promise<void> {
    if (managed.loginCheck || this.safety.getSnapshot().loginBlocked) {
      if (managed.loginCheck) await managed.loginCheck
      return
    }
    managed.loginCheck = (async () => {
      const pageUrl = managed.remoteView?.webContents.getURL() ?? ''
      const previousLoginState = managed.loginState
      const result = await detectLoginState(managed.remoteSession, pageUrl, CHATGPT_URL)
      if (result.state !== 'checking' || managed.loginState === 'checking') {
        managed.loginState = result.state
      }
      if (result.state === 'logged-in') {
        managed.accountName = result.accountName
        if (shouldRefreshNetworkAfterLoginCheck(previousLoginState, result.state)) {
          void managed.network.refresh()
        }
      } else if (result.state === 'logged-out') {
        managed.accountName = '未识别账号'
      }
      await this.reconcileWorkTimerWithLogin()
      this.sendAllStates()
    })().finally(() => {
      managed.loginCheck = null
    })
    await managed.loginCheck
  }

  private async reconcileWorkTimerWithLogin(): Promise<void> {
    if (this.suspended) {
      await this.store.update((state) => pauseWorkTimer(state))
      return
    }
    const loginStates = [...this.windows].map((managed) => managed.loginState)
    if (loginStates.includes('logged-in')) {
      await this.store.update((state) => resumeWorkTimer(state))
    } else if (loginStates.length === 0 || loginStates.every((state) => state === 'logged-out')) {
      await this.store.update((state) => pauseWorkTimer(state))
    }
  }

  private detectorHealth(): DetectorHealth {
    const normal = [...this.windows].find((managed) => managed.kind === 'normal')
    return normal?.detector?.getHealth() ?? 'unverified'
  }

  private detectorExpected(): boolean {
    const normal = [...this.windows].find((managed) => managed.kind === 'normal')
    const contents = normal?.remoteView?.webContents
    return Boolean(
      normal?.loginState === 'logged-in' &&
      normal.authWindows.size === 0 &&
      contents &&
      !contents.isDestroyed() &&
      this.isWorkObservationPage(contents.getURL())
    )
  }

  private sendState(managed: ManagedWindow): void {
    if (managed.toolbar.isDestroyed()) return
    const state = this.getState(managed)
    managed.toolbar.webContents.send('state-updated', state)
    for (const settingsWindow of managed.settings) {
      if (!settingsWindow.isDestroyed()) settingsWindow.webContents.send('state-updated', state)
    }
    if (managed.downloadsWindow && !managed.downloadsWindow.isDestroyed()) {
      managed.downloadsWindow.webContents.send('state-updated', state)
    }
  }

  private async confirmWebDataClear(managed: ManagedWindow): Promise<boolean> {
    const testResponse = this.testClearDataResponses[this.testClearDataResponseIndex]
    if (testResponse) {
      this.testClearDataResponseIndex += 1
      return testResponse === 'accept'
    }
    const result = await dialog.showMessageBox(managed.toolbar, {
      type: 'warning',
      title: '清除登录及全部网页数据',
      message: '此操作会退出当前窗口中的 ChatGPT 登录。',
      detail: '设备 ID、工作状态、状态检测记录、下载记录和 Logo 选择不会被删除。',
      buttons: ['取消', '清除并重新加载'],
      defaultId: 0,
      cancelId: 0
    })
    return result.response === 1
  }

  private installRefreshShortcuts(contents: WebContents, managed: ManagedWindow): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return
      const primaryModifier = process.platform === 'darwin' ? input.meta : input.control
      if (!primaryModifier || input.alt || input.key.toLowerCase() !== 'r') return
      event.preventDefault()
      this.refresh(managed, input.shift)
    })
  }

  private configureRemoteContents(managed: ManagedWindow): void {
    const contents = managed.remoteView!.webContents
    const pauseForAuthentication = (_event: Electron.Event, url: string): void => {
      if (isAuthenticationPageUrl(url, this.testAuthenticationOrigins)) {
        managed.detector?.pauseForAuthentication()
      }
    }
    contents.on('will-navigate', pauseForAuthentication)
    contents.on('will-redirect', pauseForAuthentication)
    contents.on('did-start-navigation', (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) pauseForAuthentication(event, url)
    })
    guardNavigation(contents, managed.toolbar, this.testAllowedOrigins)
    installNativePopupPolicy(contents, {
      ownerWindow: managed.toolbar,
      partition: managed.partition,
      expectedSession: managed.remoteSession,
      showWindows: SHOULD_SHOW_WINDOWS,
      testAllowedOrigins: this.testAllowedOrigins,
      testAuthenticationOrigins: this.testAuthenticationOrigins,
      onEvent: (event) => this.handleNativePopupEvent(managed, event)
    })
    contents.on('did-finish-load', () => {
      if (
        managed.detector &&
        SHOULD_RUN_DETECTOR &&
        managed.authWindows.size === 0 &&
        this.isWorkObservationPage(contents.getURL())
      ) {
        void managed.detector.start()
      }
      managed.detector?.reconcileCurrentPage()
      void managed.network.refresh()
      void this.checkLogin(managed)
      this.sendState(managed)
    })
    contents.on('did-navigate', () => {
      managed.detector?.reconcileCurrentPage()
    })
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) managed.detector?.reconcileCurrentPage()
    })
    contents.on('did-fail-load', (_event, code, description, url) => {
      console.error('ChatGPT failed to load', { code, description, host: safeHost(url) })
    })
    contents.on('render-process-gone', () => this.sendState(managed))
  }

  private handleNativePopupEvent(managed: ManagedWindow, event: NativePopupEvent): void {
    if (event.type === 'authentication') {
      managed.detector?.pauseForAuthentication()
      return
    }
    if (event.type === 'created' && event.window) {
      managed.authWindows.add(event.window)
      return
    }
    if (event.type === 'closed' && event.window) {
      managed.authWindows.delete(event.window)
      if (
        managed.detector &&
        managed.authWindows.size === 0 &&
        SHOULD_RUN_DETECTOR &&
        managed.remoteView &&
        this.isWorkObservationPage(managed.remoteView.webContents.getURL())
      ) {
        void managed.detector.start()
      }
      setTimeout(() => void this.checkLogin(managed), 500)
      return
    }
    if (event.type === 'blocked' && event.url && !managed.toolbar.isDestroyed()) {
      void confirmExternalNavigation(managed.toolbar, event.url)
      return
    }
    if (event.type === 'session-mismatch') {
      console.error('Login popup session did not match the ChatGPT session', { host: event.host })
      return
    }
    if (event.type === 'load-failed') console.error('Login popup failed to load', { host: event.host })
  }

  private isWorkObservationPage(url: string): boolean {
    if (isAuthenticationPageUrl(url, this.testAuthenticationOrigins)) return false
    if (isChatGptPageUrl(url)) return true
    if (!process.env.CHATGPT_WEB_NEXT_TEST_ROOT) return false
    try {
      const origin = new URL(url).origin
      return this.testAllowedOrigins.has(origin) && !this.testAuthenticationOrigins.has(origin)
    } catch {
      return false
    }
  }

  private closeAuthWindows(managed: ManagedWindow): void {
    for (const authWindow of managed.authWindows) {
      if (!authWindow.isDestroyed()) authWindow.destroy()
    }
    managed.authWindows.clear()
  }

  private removeRemoteView(managed: ManagedWindow): void {
    const view = managed.remoteView
    if (!view) return
    managed.remoteView = null
    try {
      managed.toolbar.contentView.removeChildView(view)
    } catch {
      // The window may already be closing.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
  }

  private async loadLocalPage(
    window: BrowserWindow,
    view: 'toolbar' | 'settings' | 'downloads'
  ): Promise<void> {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      const url = new URL(developmentUrl)
      url.searchParams.set('view', view)
      await window.loadURL(url.toString())
    } else {
      await window.loadFile(this.rendererPath, { query: { view } })
    }
  }
}

export type WindowHandle = ReturnType<WindowManager['resolveSender']>

async function clearSession(remoteSession: Session): Promise<void> {
  await Promise.all([
    remoteSession.clearCache(),
    remoteSession.clearAuthCache(),
    remoteSession.clearStorageData()
  ])
}

function readAllowedOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>()
  for (const candidate of value?.split(',') ?? []) {
    try {
      origins.add(new URL(candidate.trim()).origin)
    } catch {
      // Ignore malformed test-only values.
    }
  }
  return origins
}

function readPositiveTestNumber(name: string, fallback: number): number {
  if (!process.env.CHATGPT_WEB_NEXT_TEST_ROOT) return fallback
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, minimum), Math.max(minimum, maximum)))
}
