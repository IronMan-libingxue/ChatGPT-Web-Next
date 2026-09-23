import type { ChatGptWebNextBridge } from '../../shared/types'

declare global {
  interface Window {
    chatgptWebNext: ChatGptWebNextBridge
  }
}

export {}
