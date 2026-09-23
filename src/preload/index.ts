import { contextBridge, ipcRenderer } from 'electron'
import type { ChatGptWebNextBridge, ToolbarState } from '../shared/types'

const bridge: ChatGptWebNextBridge = {
  getState: () => ipcRenderer.invoke('state:get') as Promise<ToolbarState>,
  refresh: () => ipcRenderer.invoke('page:refresh') as Promise<void>,
  hardRefresh: () => ipcRenderer.invoke('page:hard-refresh') as Promise<void>,
  newIncognito: () => ipcRenderer.invoke('window:new-incognito') as Promise<void>,
  openSettings: () => ipcRenderer.invoke('window:open-settings') as Promise<void>,
  toggleDownloads: (anchor) =>
    ipcRenderer.invoke('window:toggle-downloads', anchor) as Promise<void>,
  closeDownloads: () => ipcRenderer.invoke('window:close-downloads') as Promise<void>,
  clearCache: () => ipcRenderer.invoke('data:clear-cache') as Promise<boolean>,
  clearWebData: () => ipcRenderer.invoke('data:clear-web') as Promise<boolean>,
  refreshNetwork: () => ipcRenderer.invoke('network:refresh') as Promise<void>,
  clearDownloadRecords: () => ipcRenderer.invoke('downloads:clear-records') as Promise<void>,
  revealDownload: (downloadId) =>
    ipcRenderer.invoke('downloads:reveal', downloadId) as Promise<'revealed' | 'missing'>,
  selectLogo: (logoId) =>
    ipcRenderer.invoke('preferences:select-logo', logoId) as Promise<boolean>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ToolbarState): void => listener(state)
    ipcRenderer.on('state-updated', handler)
    return () => ipcRenderer.off('state-updated', handler)
  }
}

contextBridge.exposeInMainWorld('chatgptWebNext', bridge)

window.addEventListener('online', () => ipcRenderer.send('network:online'))
window.addEventListener('offline', () => ipcRenderer.send('network:offline'))
