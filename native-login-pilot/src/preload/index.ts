import { contextBridge, ipcRenderer } from 'electron'
import type { NativeLoginPilotBridge, NativeLoginPilotState } from '../shared/types'

const bridge: NativeLoginPilotBridge = {
  getState: () =>
    ipcRenderer.invoke('native-login-pilot:get-state') as Promise<NativeLoginPilotState>,
  refresh: () =>
    ipcRenderer.invoke('native-login-pilot:refresh') as Promise<NativeLoginPilotState>,
  hardRefresh: () =>
    ipcRenderer.invoke('native-login-pilot:hard-refresh') as Promise<NativeLoginPilotState>,
  clearWebData: () =>
    ipcRenderer.invoke('native-login-pilot:clear-web-data') as Promise<NativeLoginPilotState>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NativeLoginPilotState): void =>
      listener(state)
    ipcRenderer.on('native-login-pilot:state-updated', handler)
    return () => ipcRenderer.off('native-login-pilot:state-updated', handler)
  }
}

contextBridge.exposeInMainWorld('chatgptNativeLoginPilot', bridge)
