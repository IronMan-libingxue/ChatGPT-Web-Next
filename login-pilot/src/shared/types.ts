export type PilotBrowserId = 'chrome' | 'edge'
export type PilotActivity = 'idle' | 'launching' | 'clearing' | 'preparing-extension'

export interface PilotBrowserOption {
  id: PilotBrowserId
  name: string
  available: boolean
  version: string | null
}

export interface PilotState {
  browsers: PilotBrowserOption[]
  selectedBrowser: PilotBrowserId
  activity: PilotActivity
  profilePath: string
  profileExists: boolean
  runningProcessCount: number
  workExtensionPath: string
  workExtensionSourceReady: boolean
  message: string
  error: string | null
  lastActionAt: string | null
}

export interface LoginPilotBridge {
  getState: () => Promise<PilotState>
  selectBrowser: (browserId: PilotBrowserId) => Promise<PilotState>
  launch: () => Promise<PilotState>
  prepareWorkExtension: () => Promise<PilotState>
  clearAndRelaunch: () => Promise<PilotState>
  onState: (listener: (state: PilotState) => void) => () => void
}
