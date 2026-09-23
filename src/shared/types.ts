export const WORK_WINDOW_MS = 96 * 60 * 60 * 1000
export const NETWORK_REFRESH_MS = 20 * 60 * 1000
export const LOCATION_CACHE_MS = 24 * 60 * 60 * 1000
export const WORK_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DOWNLOAD_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type DetectorHealth = 'unverified' | 'healthy' | 'degraded'
export type WorkLight = 'inactive' | 'active' | 'pending' | 'error'
export type NetworkFreshness = 'live' | 'stale' | 'unavailable'
export type StorageStatus = 'initializing' | 'ready' | 'unavailable' | 'error'
export type LoginState = 'checking' | 'logged-in' | 'logged-out'
export type DownloadStatus =
  | 'progressing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type LogoId =
  | 'logo-043714'
  | 'logo-121805'
  | 'logo-122825'
  | 'logo-123336'
  | 'logo-124106'

export interface PendingOperation {
  operationHash: string
  requestId: string
  createdAt: string
  windowKind: 'normal' | 'incognito'
}

export interface PersistedDeviceState {
  schemaVersion: 2
  deviceId: string
  lastAcceptedAt: string | null
  workRemainingMs: number
  workTimerRunning: boolean
  workTimerUpdatedAt: string
  recentOperationHashes: string[]
  pendingOperations: PendingOperation[]
  detectorRuleVersion: string
  lastWallClockAt: string
  safetyPlan: PersistedSafetyPlan | null
}

export interface PersistedSafetyPlan {
  operationHash: string
  acceptedAt: string
  clearDueAt: string
  quitDueAt: string
  clearedAt: string | null
}

export interface WorkSnapshot {
  light: WorkLight
  detectorHealth: DetectorHealth
  lastAcceptedAt: string | null
  expiresAt: string | null
  remainingMs: number
  timerRunning: boolean
  pendingCount: number
  clockAnomaly: boolean
  message: string
}

export interface NetworkSnapshot {
  ip: string | null
  country: string | null
  city: string | null
  timezone: string | null
  observedAt: string | null
  freshness: NetworkFreshness
  error: string | null
  locationError: string | null
  latencyMs: number | null
  latencyObservedAt: string | null
  latencyError: string | null
  latencySampleCount: number
  checking: boolean
}

export interface SafetySnapshot {
  phase: 'none' | 'countdown' | 'cleared'
  clearRemainingMs: number
  quitRemainingMs: number
  clearDueAt: string | null
  quitDueAt: string | null
  loginBlocked: boolean
  message: string | null
}

export interface WorkUsageRecord {
  id: string
  operationHash: string
  accountName: string
  projectName: string
  chatName: string
  triggeredAt: string
}

export interface DownloadRecord {
  id: string
  fileName: string
  savePath: string
  receivedBytes: number
  totalBytes: number | null
  startedAt: string
  updatedAt: string
  completedAt: string | null
  status: DownloadStatus
  windowKind: 'normal' | 'incognito'
  error: string | null
}

export interface DownloadsSnapshot {
  recent: DownloadRecord[]
  all: DownloadRecord[]
  totalCount: number
}

export interface DownloadPanelAnchor {
  right: number
  bottom: number
}

export interface LogoChoice {
  id: LogoId
  label: string
}

export interface PreferencesSnapshot {
  selectedLogoId: LogoId
  logos: LogoChoice[]
}

export interface ToolbarState {
  windowKind: 'normal' | 'incognito'
  work: WorkSnapshot
  workRecords: WorkUsageRecord[]
  network: NetworkSnapshot
  safety: SafetySnapshot
  downloads: DownloadsSnapshot
  preferences: PreferencesSnapshot
  loginState: LoginState
  maskedDeviceId: string
  storageStatus: StorageStatus
  storageWarning: string | null
}

export interface ChatGptWebNextBridge {
  getState: () => Promise<ToolbarState>
  refresh: () => Promise<void>
  hardRefresh: () => Promise<void>
  newIncognito: () => Promise<void>
  openSettings: () => Promise<void>
  toggleDownloads: (anchor: DownloadPanelAnchor) => Promise<void>
  closeDownloads: () => Promise<void>
  clearCache: () => Promise<boolean>
  clearWebData: () => Promise<boolean>
  refreshNetwork: () => Promise<void>
  clearDownloadRecords: () => Promise<void>
  revealDownload: (downloadId: string) => Promise<'revealed' | 'missing'>
  selectLogo: (logoId: LogoId) => Promise<boolean>
  onState: (listener: (state: ToolbarState) => void) => () => void
}
