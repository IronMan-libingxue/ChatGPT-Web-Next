import {
  ACCEPTANCE_WINDOW_MS,
  CHROME_WORK_RULE_VERSION,
  PENDING_RETENTION_MS,
  type SafeWorkSignals
} from './detection.js'

const MAX_EVENTS = 30
const MAX_CONFIRMED_HASHES = 128

export type PilotHealth = 'monitoring' | 'healthy' | 'attention'
export type PilotPhase = 'idle' | 'pending' | 'confirmed' | 'attention'

export type PilotEventKind =
  | 'monitoring-started'
  | 'ignored-non-work'
  | 'work-pending'
  | 'work-confirmed'
  | 'work-rejected'
  | 'transport-error'
  | 'attention'
  | 'duplicate'
  | 'reset'

export interface PilotEvent {
  at: string
  kind: PilotEventKind
  message: string
  operationHint?: string
  statusCode?: number
  signals?: SafeWorkSignals
}

export interface PendingWorkCandidate {
  operationHash: string
  requestHash: string
  conversationHash: string | null
  tabId: number
  observedAt: string
  transportCompletedAt: string | null
}

export interface PilotStatistics {
  conversationPosts: number
  ignoredNonWork: number
  matchedWork: number
  confirmedWork: number
  rejectedWork: number
  transportErrors: number
  unmatchedWorkLike: number
  unreadableBodies: number
  streamStatusSuccesses: number
  duplicates: number
}

export interface WorkPilotState {
  schemaVersion: 1
  ruleVersion: string
  health: PilotHealth
  phase: PilotPhase
  startedAt: string
  updatedAt: string
  lastConfirmedAt: string | null
  pending: PendingWorkCandidate[]
  confirmedOperationHashes: string[]
  statistics: PilotStatistics
  events: PilotEvent[]
}

export interface WorkPilotViewState {
  ruleVersion: string
  health: PilotHealth
  phase: PilotPhase
  updatedAt: string
  lastConfirmedAt: string | null
  pendingCount: number
  statistics: PilotStatistics
  events: PilotEvent[]
}

export function createInitialPilotState(now = new Date()): WorkPilotState {
  const timestamp = now.toISOString()
  return {
    schemaVersion: 1,
    ruleVersion: CHROME_WORK_RULE_VERSION,
    health: 'monitoring',
    phase: 'idle',
    startedAt: timestamp,
    updatedAt: timestamp,
    lastConfirmedAt: null,
    pending: [],
    confirmedOperationHashes: [],
    statistics: {
      conversationPosts: 0,
      ignoredNonWork: 0,
      matchedWork: 0,
      confirmedWork: 0,
      rejectedWork: 0,
      transportErrors: 0,
      unmatchedWorkLike: 0,
      unreadableBodies: 0,
      streamStatusSuccesses: 0,
      duplicates: 0
    },
    events: [
      {
        at: timestamp,
        kind: 'monitoring-started',
        message: 'Chrome Work 网络观察已启动'
      }
    ]
  }
}

export function normalizePilotState(value: unknown, now = new Date()): WorkPilotState {
  if (!value || typeof value !== 'object') return createInitialPilotState(now)
  const candidate = value as Partial<WorkPilotState>
  if (
    candidate.schemaVersion !== 1 ||
    candidate.ruleVersion !== CHROME_WORK_RULE_VERSION ||
    !candidate.statistics ||
    !Array.isArray(candidate.pending) ||
    !Array.isArray(candidate.events) ||
    !Array.isArray(candidate.confirmedOperationHashes)
  ) {
    return createInitialPilotState(now)
  }
  return pruneExpiredCandidates(candidate as WorkPilotState, now)
}

export function recordIgnoredNonWork(
  state: WorkPilotState,
  signals: SafeWorkSignals,
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  next.statistics.conversationPosts += 1
  next.statistics.ignoredNonWork += 1
  appendEvent(next, {
    at: now.toISOString(),
    kind: 'ignored-non-work',
    message: '已忽略普通聊天或非 Work 提交',
    signals
  })
  return finalize(next, now)
}

export function recordAttention(
  state: WorkPilotState,
  input: {
    message: string
    signals?: SafeWorkSignals
    category: 'unmatched-work-like' | 'unreadable' | 'ambiguous'
  },
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  next.statistics.conversationPosts += input.category === 'ambiguous' ? 0 : 1
  if (input.category === 'unmatched-work-like') next.statistics.unmatchedWorkLike += 1
  if (input.category === 'unreadable') next.statistics.unreadableBodies += 1
  next.health = 'attention'
  appendEvent(next, {
    at: now.toISOString(),
    kind: 'attention',
    message: input.message,
    signals: input.signals
  })
  return finalize(next, now)
}

export function recordMatchedWork(
  state: WorkPilotState,
  input: PendingWorkCandidate & { signals: SafeWorkSignals },
  now = new Date()
): WorkPilotState {
  const next = cloneState(pruneExpiredCandidates(state, now))
  next.statistics.conversationPosts += 1
  next.statistics.matchedWork += 1

  if (next.confirmedOperationHashes.includes(input.operationHash)) {
    next.statistics.duplicates += 1
    appendEvent(next, {
      at: now.toISOString(),
      kind: 'duplicate',
      message: '已忽略重复的 Work 操作',
      operationHint: shortHash(input.operationHash),
      signals: input.signals
    })
    return finalize(next, now)
  }

  const existingIndex = next.pending.findIndex(
    (candidate) => candidate.operationHash === input.operationHash
  )
  const pending: PendingWorkCandidate = {
    operationHash: input.operationHash,
    requestHash: input.requestHash,
    conversationHash: input.conversationHash,
    tabId: input.tabId,
    observedAt: input.observedAt,
    transportCompletedAt: input.transportCompletedAt
  }
  if (existingIndex >= 0) {
    next.pending[existingIndex] = pending
    next.statistics.duplicates += 1
  } else {
    next.pending.push(pending)
  }
  next.health = 'monitoring'
  appendEvent(next, {
    at: now.toISOString(),
    kind: 'work-pending',
    message: '已识别本机 Work 提交，等待服务端接受信号',
    operationHint: shortHash(input.operationHash),
    signals: input.signals
  })
  return finalize(next, now)
}

export function recordRequestCompleted(
  state: WorkPilotState,
  requestHash: string,
  statusCode: number,
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  const index = next.pending.findIndex((candidate) => candidate.requestHash === requestHash)
  if (index < 0) return finalize(next, now)
  const candidate = next.pending[index]
  if (!candidate) return finalize(next, now)

  if (statusCode >= 400) {
    next.pending.splice(index, 1)
    next.statistics.rejectedWork += 1
    appendEvent(next, {
      at: now.toISOString(),
      kind: 'work-rejected',
      message: 'Work 提交被明确拒绝，未计入使用',
      operationHint: shortHash(candidate.operationHash),
      statusCode
    })
  } else if (statusCode >= 200 && statusCode < 300) {
    next.pending[index] = {
      ...candidate,
      transportCompletedAt: now.toISOString()
    }
  }
  return finalize(next, now)
}

export function recordRequestError(
  state: WorkPilotState,
  requestHash: string,
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  const index = next.pending.findIndex((candidate) => candidate.requestHash === requestHash)
  if (index < 0) return finalize(next, now)
  const candidate = next.pending[index]
  if (!candidate) return finalize(next, now)
  next.pending.splice(index, 1)
  next.statistics.transportErrors += 1
  appendEvent(next, {
    at: now.toISOString(),
    kind: 'transport-error',
    message: 'Work 提交发生网络错误，未计入使用；本机重试会重新识别',
    operationHint: shortHash(candidate.operationHash)
  })
  return finalize(next, now)
}

export function eligibleCandidates(
  state: WorkPilotState,
  input: { conversationHash: string; tabId: number; signalObservedAt?: Date },
  now = new Date()
): PendingWorkCandidate[] {
  const cutoff = now.getTime() - ACCEPTANCE_WINDOW_MS
  const signalObservedAt = input.signalObservedAt?.getTime() ?? now.getTime()
  const recent = state.pending.filter(
    (candidate) => {
      const candidateObservedAt = new Date(candidate.observedAt).getTime()
      return candidateObservedAt >= cutoff && candidateObservedAt <= signalObservedAt
    }
  )
  const exactConversation = recent.filter(
    (candidate) => candidate.conversationHash === input.conversationHash
  )
  if (exactConversation.length > 0) return exactConversation
  if (input.tabId >= 0) {
    return recent.filter(
      (candidate) => candidate.conversationHash === null && candidate.tabId === input.tabId
    )
  }
  return recent.filter((candidate) => candidate.conversationHash === null)
}

export function recordStreamStatusSeen(
  state: WorkPilotState,
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  next.statistics.streamStatusSuccesses += 1
  return finalize(next, now)
}

export function confirmCandidate(
  state: WorkPilotState,
  operationHash: string,
  now = new Date()
): WorkPilotState {
  const next = cloneState(state)
  const index = next.pending.findIndex(
    (candidate) => candidate.operationHash === operationHash
  )
  if (index < 0) return finalize(next, now)
  const candidate = next.pending[index]
  if (!candidate) return finalize(next, now)
  next.pending.splice(index, 1)
  next.confirmedOperationHashes = [
    operationHash,
    ...next.confirmedOperationHashes.filter((hash) => hash !== operationHash)
  ].slice(0, MAX_CONFIRMED_HASHES)
  next.statistics.confirmedWork += 1
  next.lastConfirmedAt = now.toISOString()
  next.health = 'healthy'
  appendEvent(next, {
    at: now.toISOString(),
    kind: 'work-confirmed',
    message: '已确认本机 Work 提交被服务端接受',
    operationHint: shortHash(operationHash)
  })
  return finalize(next, now)
}

export function pruneExpiredCandidates(
  state: WorkPilotState,
  now = new Date()
): WorkPilotState {
  const cutoff = now.getTime() - PENDING_RETENTION_MS
  const next = cloneState(state)
  next.pending = next.pending.filter(
    (candidate) => new Date(candidate.observedAt).getTime() >= cutoff
  )
  return finalize(next, now)
}

export function sanitizedReport(state: WorkPilotState): Omit<WorkPilotState, 'pending' | 'confirmedOperationHashes'> & {
  pending: Array<Omit<PendingWorkCandidate, 'operationHash' | 'requestHash' | 'conversationHash'> & {
    operationHint: string
    hasConversationHash: boolean
  }>
  confirmedOperationHints: string[]
} {
  const { pending, confirmedOperationHashes, ...safeState } = state
  return {
    ...safeState,
    pending: pending.map((candidate) => ({
      operationHint: shortHash(candidate.operationHash),
      hasConversationHash: candidate.conversationHash !== null,
      tabId: candidate.tabId,
      observedAt: candidate.observedAt,
      transportCompletedAt: candidate.transportCompletedAt
    })),
    confirmedOperationHints: confirmedOperationHashes.map(shortHash)
  }
}

export function publicViewState(state: WorkPilotState): WorkPilotViewState {
  return {
    ruleVersion: state.ruleVersion,
    health: state.health,
    phase: state.phase,
    updatedAt: state.updatedAt,
    lastConfirmedAt: state.lastConfirmedAt,
    pendingCount: state.pending.length,
    statistics: structuredClone(state.statistics),
    events: structuredClone(state.events)
  }
}

function cloneState(state: WorkPilotState): WorkPilotState {
  return structuredClone(state)
}

function appendEvent(state: WorkPilotState, event: PilotEvent): void {
  state.events = [event, ...state.events].slice(0, MAX_EVENTS)
}

function finalize(state: WorkPilotState, now: Date): WorkPilotState {
  state.updatedAt = now.toISOString()
  if (state.health === 'attention') {
    state.phase = 'attention'
  } else if (state.pending.length > 0) {
    state.phase = 'pending'
  } else if (state.lastConfirmedAt) {
    state.phase = 'confirmed'
  } else {
    state.phase = 'idle'
  }
  return state
}

function shortHash(value: string): string {
  return value.slice(0, 8)
}
