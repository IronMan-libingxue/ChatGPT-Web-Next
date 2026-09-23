import { contextBridge, ipcRenderer } from 'electron'
import type { LoginPilotBridge, PilotBrowserId, PilotState } from '../shared/types'

const bridge: LoginPilotBridge = {
  getState: () => ipcRenderer.invoke('pilot:get-state') as Promise<PilotState>,
  selectBrowser: (browserId: PilotBrowserId) =>
    ipcRenderer.invoke('pilot:select-browser', browserId) as Promise<PilotState>,
  launch: () => ipcRenderer.invoke('pilot:launch') as Promise<PilotState>,
  prepareWorkExtension: () =>
    ipcRenderer.invoke('pilot:prepare-work-extension') as Promise<PilotState>,
  clearAndRelaunch: () =>
    ipcRenderer.invoke('pilot:clear-and-relaunch') as Promise<PilotState>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PilotState): void => listener(state)
    ipcRenderer.on('pilot:state-updated', handler)
    return () => ipcRenderer.off('pilot:state-updated', handler)
  }
}

contextBridge.exposeInMainWorld('chatgptLoginPilot', bridge)
