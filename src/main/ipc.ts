import { ipcMain } from 'electron'
import type { DownloadPanelAnchor } from '../shared/types'
import { isLogoId } from './preferences-store'
import { WindowManager } from './window-manager'

export function registerIpc(manager: WindowManager): void {
  ipcMain.handle('state:get', (event) => manager.getState(manager.resolveSender(event.sender)))
  ipcMain.handle('page:refresh', (event) => {
    manager.refresh(manager.resolveSender(event.sender), false)
  })
  ipcMain.handle('page:hard-refresh', (event) => {
    manager.refresh(manager.resolveSender(event.sender), true)
  })
  ipcMain.handle('window:new-incognito', async (event) => {
    manager.resolveSender(event.sender)
    await manager.createWindow('incognito')
  })
  ipcMain.handle('window:open-settings', async (event) => {
    await manager.openSettings(manager.resolveSender(event.sender))
  })
  ipcMain.handle('window:toggle-downloads', async (event, anchor: unknown) => {
    if (!isDownloadPanelAnchor(anchor)) throw new Error('Invalid download panel anchor')
    await manager.toggleDownloads(manager.resolveSender(event.sender), anchor)
  })
  ipcMain.handle('window:close-downloads', (event) => {
    const managed = manager.resolveSender(event.sender)
    setImmediate(() => manager.closeDownloads(managed))
  })
  ipcMain.handle('data:clear-cache', (event) =>
    manager.clearCache(manager.resolveSender(event.sender))
  )
  ipcMain.handle('data:clear-web', (event) =>
    manager.clearWebData(manager.resolveSender(event.sender))
  )
  ipcMain.handle('network:refresh', async (event) => {
    await manager.refreshNetwork(manager.resolveSender(event.sender))
  })
  ipcMain.handle('downloads:clear-records', async (event) => {
    manager.resolveSender(event.sender)
    await manager.clearDownloadRecords()
  })
  ipcMain.handle('downloads:reveal', async (event, downloadId: unknown) => {
    manager.resolveSender(event.sender)
    if (typeof downloadId !== 'string' || downloadId.length > 100) {
      throw new Error('Invalid download identifier')
    }
    return manager.revealDownload(downloadId)
  })
  ipcMain.handle('preferences:select-logo', async (event, logoId: unknown) => {
    manager.resolveSender(event.sender)
    if (!isLogoId(logoId)) throw new Error('Invalid logo identifier')
    return manager.selectLogo(logoId)
  })
  ipcMain.on('network:online', (event) => {
    void manager.refreshNetwork(manager.resolveSender(event.sender))
  })
  ipcMain.on('network:offline', (event) => {
    manager.markNetworkOffline(manager.resolveSender(event.sender))
  })
}

function isDownloadPanelAnchor(value: unknown): value is DownloadPanelAnchor {
  if (!value || typeof value !== 'object') return false
  const anchor = value as Record<string, unknown>
  return (
    typeof anchor.right === 'number' &&
    Number.isFinite(anchor.right) &&
    anchor.right >= 0 &&
    anchor.right <= 10_000 &&
    typeof anchor.bottom === 'number' &&
    Number.isFinite(anchor.bottom) &&
    anchor.bottom >= 0 &&
    anchor.bottom <= 500
  )
}
