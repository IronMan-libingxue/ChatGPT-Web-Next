export type NativeLoginPilotActivity = 'idle' | 'clearing'
export type NativeLoginPopupStatus = 'none' | 'created' | 'closed' | 'blocked' | 'error'
export type NativeLoginPageStage = 'chatgpt' | 'authentication' | 'other'

export interface NativeLoginPilotState {
  activity: NativeLoginPilotActivity
  popupStrategy: 'native'
  persistentSession: true
  popupCount: number
  activePopupCount: number
  popupStatus: NativeLoginPopupStatus
  pageStage: NativeLoginPageStage
  currentPageHost: string | null
  lastPopupHost: string | null
  lastBlockedHost: string | null
  message: string
  error: string | null
}

export interface NativeLoginPilotBridge {
  getState: () => Promise<NativeLoginPilotState>
  refresh: () => Promise<NativeLoginPilotState>
  hardRefresh: () => Promise<NativeLoginPilotState>
  clearWebData: () => Promise<NativeLoginPilotState>
  onState: (listener: (state: NativeLoginPilotState) => void) => () => void
}
