import { randomUUID } from 'node:crypto'
import type {
  DetectorHealth,
  PersistedDeviceState,
  PersistedSafetyPlan,
  WorkSnapshot
} from './types'
import { WORK_WINDOW_MS } from './types'

const MAX_RECENT_OPERATIONS = 128
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000

export function createDeviceState(now = new Date()): PersistedDeviceState {
  return {
    schemaVersion: 2,
    deviceId: randomUUID(),
    lastAcceptedAt: null,
    workRemainingMs: 0,
    workTimerRunning: false,
    workTimerUpdatedAt: now.toISOString(),
    recentOperationHashes: [],
    pendingOperations: [],
    detectorRuleVersion: 'unverified',
    lastWallClockAt: now.toISOString(),
    safetyPlan: null
  }
}

export function normalizeDeviceState(value: unknown, now = new Date()): PersistedDeviceState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Record<string, unknown>
  if (!isCommonStateValid(state)) return null

  if (state.schemaVersion === 2) {
    if (
      typeof state.workRemainingMs !== 'number' ||
      !Number.isFinite(state.workRemainingMs) ||
      typeof state.workTimerRunning !== 'boolean' ||
      typeof state.workTimerUpdatedAt !== 'string' ||
      !isSafetyPlan(state.safetyPlan)
    ) {
      return null
    }
    return {
      ...(state as unknown as PersistedDeviceState),
      workRemainingMs: clampRemaining(state.workRemainingMs)
    }
  }

  if (state.schemaVersion === 1) {
    const expiresAt = state.expiresAt
    if (expiresAt !== null && typeof expiresAt !== 'string') return null
    const remaining =
      typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))
        ? Math.max(0, Date.parse(expiresAt) - now.getTime())
        : 0
    return {
      schemaVersion: 2,
      deviceId: state.deviceId as string,
      lastAcceptedAt: state.lastAcceptedAt as string | null,
      workRemainingMs: clampRemaining(remaining),
      workTimerRunning: false,
      workTimerUpdatedAt: now.toISOString(),
      recentOperationHashes: state.recentOperationHashes as string[],
      pendingOperations: state.pendingOperations as PersistedDeviceState['pendingOperations'],
      detectorRuleVersion: state.detectorRuleVersion as string,
      lastWallClockAt: state.lastWallClockAt as string,
      safetyPlan: null
    }
  }
  return null
}

export function validateDeviceState(value: unknown): value is PersistedDeviceState {
  return normalizeDeviceState(value) !== null && (value as { schemaVersion?: number }).schemaVersion === 2
}

export function prunePending(state: PersistedDeviceState, now = new Date()): PersistedDeviceState {
  const cutoff = now.getTime() - MAX_PENDING_AGE_MS
  return {
    ...state,
    pendingOperations: state.pendingOperations.filter(
      (operation) => Date.parse(operation.createdAt) >= cutoff
    )
  }
}

export function recordPending(
  state: PersistedDeviceState,
  operation: PersistedDeviceState['pendingOperations'][number],
  now = new Date()
): PersistedDeviceState {
  const current = prunePending(state, now)
  if (
    current.recentOperationHashes.includes(operation.operationHash) ||
    current.pendingOperations.some((item) => item.operationHash === operation.operationHash)
  ) {
    return current
  }

  return {
    ...current,
    pendingOperations: [...current.pendingOperations, operation],
    lastWallClockAt: now.toISOString()
  }
}

export function rejectPending(
  state: PersistedDeviceState,
  operationHash: string,
  now = new Date()
): PersistedDeviceState {
  return {
    ...state,
    pendingOperations: state.pendingOperations.filter(
      (operation) => operation.operationHash !== operationHash
    ),
    lastWallClockAt: now.toISOString()
  }
}

export function recordAccepted(
  state: PersistedDeviceState,
  operationHash: string,
  acceptedAt: Date,
  now = acceptedAt
): PersistedDeviceState {
  if (state.recentOperationHashes.includes(operationHash)) {
    return rejectPending(state, operationHash, now)
  }

  const acceptedMs = acceptedAt.getTime()
  const mostRecentAccepted = state.lastAcceptedAt ? Date.parse(state.lastAcceptedAt) : 0

  return {
    ...state,
    lastAcceptedAt:
      acceptedMs >= mostRecentAccepted ? acceptedAt.toISOString() : state.lastAcceptedAt,
    workRemainingMs:
      acceptedMs >= mostRecentAccepted ? WORK_WINDOW_MS : state.workRemainingMs,
    workTimerRunning:
      acceptedMs >= mostRecentAccepted ? true : state.workTimerRunning,
    workTimerUpdatedAt:
      acceptedMs >= mostRecentAccepted ? now.toISOString() : state.workTimerUpdatedAt,
    recentOperationHashes: [
      operationHash,
      ...state.recentOperationHashes.filter((hash) => hash !== operationHash)
    ].slice(0, MAX_RECENT_OPERATIONS),
    pendingOperations: state.pendingOperations.filter(
      (operation) => operation.operationHash !== operationHash
    ),
    lastWallClockAt: now.toISOString()
  }
}

export function materializeWorkTimer(
  state: PersistedDeviceState,
  now = new Date()
): PersistedDeviceState {
  if (!state.workTimerRunning || state.workRemainingMs <= 0) return state
  const updatedMs = Date.parse(state.workTimerUpdatedAt)
  const nowMs = now.getTime()
  if (!Number.isFinite(updatedMs) || nowMs < updatedMs) return state
  const remaining = clampRemaining(state.workRemainingMs - (nowMs - updatedMs))
  return {
    ...state,
    workRemainingMs: remaining,
    workTimerRunning: remaining > 0,
    workTimerUpdatedAt: now.toISOString(),
    lastWallClockAt: now.toISOString()
  }
}

export function pauseWorkTimer(
  state: PersistedDeviceState,
  now = new Date()
): PersistedDeviceState {
  const current = materializeWorkTimer(state, now)
  return {
    ...current,
    workTimerRunning: false,
    workTimerUpdatedAt: now.toISOString(),
    lastWallClockAt: now.toISOString()
  }
}

export function freezeWorkTimerOnStartup(
  state: PersistedDeviceState,
  now = new Date()
): PersistedDeviceState {
  return {
    ...state,
    workTimerRunning: false,
    workTimerUpdatedAt: now.toISOString()
  }
}

export function resumeWorkTimer(
  state: PersistedDeviceState,
  now = new Date()
): PersistedDeviceState {
  const current = materializeWorkTimer(state, now)
  return {
    ...current,
    workTimerRunning: current.workRemainingMs > 0,
    workTimerUpdatedAt: now.toISOString(),
    lastWallClockAt: now.toISOString()
  }
}

export function setSafetyPlan(
  state: PersistedDeviceState,
  plan: PersistedSafetyPlan | null,
  now = new Date()
): PersistedDeviceState {
  return { ...state, safetyPlan: plan, lastWallClockAt: now.toISOString() }
}

export function deriveWorkSnapshot(
  state: PersistedDeviceState,
  detectorHealth: DetectorHealth,
  now = new Date(),
  detectorExpected = true
): WorkSnapshot {
  const current = materializeWorkTimer(prunePending(state, now), now)
  const nowMs = now.getTime()
  const lastWallClockMs = Date.parse(current.lastWallClockAt)
  const clockAnomaly = Number.isFinite(lastWallClockMs)
    ? nowMs + CLOCK_ROLLBACK_TOLERANCE_MS < lastWallClockMs
    : true
  const active = Boolean(current.lastAcceptedAt && current.workRemainingMs > 0)
  const pendingCount = current.pendingOperations.length

  if (active) {
    const notices: string[] = []
    if (pendingCount > 0) notices.push(`另有${pendingCount}次提交待确认`)
    if (detectorHealth === 'degraded') notices.push('当前检测异常')
    if (clockAnomaly) notices.push('系统时间需要核验')
    return {
      light: 'active',
      detectorHealth,
      lastAcceptedAt: current.lastAcceptedAt,
      expiresAt: current.workTimerRunning
        ? new Date(nowMs + current.workRemainingMs).toISOString()
        : null,
      remainingMs: current.workRemainingMs,
      timerRunning: current.workTimerRunning,
      pendingCount,
      clockAnomaly,
      message: ['96小时内已确认使用', ...notices].join('；')
    }
  }

  if (pendingCount > 0) {
    return {
      light: 'pending',
      detectorHealth,
      lastAcceptedAt: current.lastAcceptedAt,
      expiresAt: null,
      remainingMs: 0,
      timerRunning: false,
      pendingCount,
      clockAnomaly,
      message: '本机提交正在等待可靠确认'
    }
  }

  if ((detectorExpected && detectorHealth !== 'healthy') || clockAnomaly) {
    return {
      light: 'error',
      detectorHealth,
      lastAcceptedAt: current.lastAcceptedAt,
      expiresAt: null,
      remainingMs: 0,
      timerRunning: false,
      pendingCount: 0,
      clockAnomaly,
      message: clockAnomaly
        ? '系统时间异常，无法可靠判断'
        : detectorHealth === 'unverified'
          ? 'Work 检测尚未完成真实校准'
          : 'Work 检测异常'
    }
  }

  return {
    light: 'inactive',
    detectorHealth,
    lastAcceptedAt: current.lastAcceptedAt,
    expiresAt: null,
    remainingMs: 0,
    timerRunning: false,
    pendingCount: 0,
    clockAnomaly: false,
    message: detectorExpected
      ? '最近96小时没有已确认的本机 Work 使用'
      : '登录后开始 Work 检测'
  }
}

function isCommonStateValid(state: Record<string, unknown>): boolean {
  return (
    typeof state.deviceId === 'string' &&
    (state.lastAcceptedAt === null || typeof state.lastAcceptedAt === 'string') &&
    Array.isArray(state.recentOperationHashes) &&
    state.recentOperationHashes.every((item) => typeof item === 'string') &&
    Array.isArray(state.pendingOperations) &&
    state.pendingOperations.every(isPendingOperation) &&
    typeof state.detectorRuleVersion === 'string' &&
    typeof state.lastWallClockAt === 'string'
  )
}

function isPendingOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.operationHash === 'string' &&
    typeof item.requestId === 'string' &&
    typeof item.createdAt === 'string' &&
    (item.windowKind === 'normal' || item.windowKind === 'incognito')
  )
}

function isSafetyPlan(value: unknown): value is PersistedSafetyPlan | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan.operationHash === 'string' &&
    typeof plan.acceptedAt === 'string' &&
    typeof plan.clearDueAt === 'string' &&
    typeof plan.quitDueAt === 'string' &&
    (plan.clearedAt === null || typeof plan.clearedAt === 'string')
  )
}

function clampRemaining(value: number): number {
  return Math.max(0, Math.min(WORK_WINDOW_MS, value))
}

export function maskDeviceId(deviceId: string): string {
  const compact = deviceId.replaceAll('-', '')
  return `${compact.slice(0, 6)}…${compact.slice(-4)}`
}
