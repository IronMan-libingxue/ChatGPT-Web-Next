import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, powerMonitor } from 'electron'
import { DeviceStateStore } from './device-state-store'
import { DownloadStore } from './download-store'
import { registerIpc } from './ipc'
import { installApplicationMenu } from './menu'
import { PreferencesStore } from './preferences-store'
import { WindowManager } from './window-manager'
import { WorkUsageStore } from './work-usage-store'

const outputDirectory = dirname(fileURLToPath(import.meta.url))
app.setName('ChatGPT Web Next')

const isolatedTestRoot = process.env.CHATGPT_WEB_NEXT_TEST_ROOT
if (isolatedTestRoot) {
  app.setPath('appData', join(isolatedTestRoot, 'app-data'))
  app.setPath('userData', join(isolatedTestRoot, 'browser-data'))
  app.setPath('downloads', join(isolatedTestRoot, 'downloads'))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

let manager: WindowManager | null = null
let store: DeviceStateStore | null = null
let quitPrepared = false
let quitPreparation: Promise<void> | null = null

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => manager?.focusNormalOrCreate())

  app.whenReady().then(async () => {
    store = new DeviceStateStore(
      app.getPath('appData'),
      isolatedTestRoot ? process.env.CHATGPT_WEB_NEXT_TEST_STORAGE_SECRET : undefined
    )
    try {
      await store.initialize()
    } catch (error: unknown) {
      console.error('Encrypted device state initialization failed', error)
      store.markInitializationFailed()
    }
    const encryptionSecret = isolatedTestRoot
      ? process.env.CHATGPT_WEB_NEXT_TEST_STORAGE_SECRET
      : undefined
    const usageStore = new WorkUsageStore(app.getPath('appData'), encryptionSecret)
    const downloadStore = new DownloadStore(app.getPath('appData'), encryptionSecret)
    const preferencesStore = new PreferencesStore(app.getPath('appData'), encryptionSecret)
    await Promise.all([
      usageStore.initialize(),
      downloadStore.initialize(),
      preferencesStore.initialize()
    ])
    manager = new WindowManager(
      store,
      usageStore,
      downloadStore,
      preferencesStore,
      app.getPath('appData'),
      outputDirectory
    )
    await manager.initializeBeforeWindows()
    registerIpc(manager)
    installApplicationMenu(manager)
    powerMonitor.on('suspend', () => void manager?.onSystemSuspend())
    powerMonitor.on('resume', () => void manager?.onSystemResume())
    await manager.createWindow('normal')
    manager.sendAllStates()
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    await dialog.showMessageBox({
      type: 'error',
      title: 'ChatGPT Web Next 无法启动',
      message: '客户端初始化失败。',
      detail: message
    })
    app.quit()
  })

  app.on('activate', () => manager?.focusNormalOrCreate())

  app.on('before-quit', (event) => {
    if (quitPrepared) return
    event.preventDefault()
    if (!quitPreparation) {
      quitPreparation = (manager?.prepareForQuit() ?? store?.touchClock() ?? Promise.resolve())
        .catch((error: unknown) => console.error('Failed to persist final local state', error))
        .finally(() => {
          quitPrepared = true
          app.quit()
        })
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
