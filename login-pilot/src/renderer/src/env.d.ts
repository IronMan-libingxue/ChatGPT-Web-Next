/// <reference types="vite/client" />

import type { LoginPilotBridge } from '../../shared/types'

declare global {
  interface Window {
    chatgptLoginPilot: LoginPilotBridge
  }
}

export {}
