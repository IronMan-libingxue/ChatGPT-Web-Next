/// <reference types="vite/client" />

import type { NativeLoginPilotBridge } from '../../shared/types'

declare global {
  interface Window {
    chatgptNativeLoginPilot: NativeLoginPilotBridge
  }
}

export {}
