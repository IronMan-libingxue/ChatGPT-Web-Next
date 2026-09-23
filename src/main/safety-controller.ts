import { performance } from 'node:perf_hooks'
import type { PersistedDeviceState, SafetySnapshot } from '../shared/types'
import { setSafetyPlan } from '../shared/work-state'
import type { DeviceStateStore } from './device-state-store'

export interface SafetyControllerDependencies {
  now?: () => Date
  monotonicNow?: () => number
  clearAfterMs?: number
  quitAfterMs?: number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export class SafetyController {
  private timer: NodeJS.Timeout | null = null
  private startedWallMs: number | null = null
  private startedMonotonicMs: number | null = null
  private clearing = false
  private quitTriggered = false

  constructor(
    private readonly store: DeviceStateStore,
    private readonly clearAll: () => Promise<void>,
    private readonly quitApp: () => Promise<void> | void,
    private readonly onChange: () => void,
    private readonly dependencies: SafetyControllerDependencies = {}
  ) {}

  async recoverBeforePageLoad(): Promise<boolean> {
    const plan = this.store.getState().safetyPlan
    if (!plan) return false
    await this.clearAll()
    await this.store.update((state) => setSafetyPlan(state, null, this.now()))
    this.onChange()
    return true
  }

  async trigger(operationHash: string, acceptedAt = this.now()): Promise<boolean> {
    const currentPlan = this.store.getState().safetyPlan
    if (currentPlan?.operationHash === operationHash) return false
    await this.store.update((state) => this.prepareAcceptedState(state, operationHash, acceptedAt))
    this.activatePersistedPlan()
    return true
  }

  prepareAcceptedState(
    state: PersistedDeviceState,
    operationHash: string,
    acceptedAt: Date
  ): PersistedDeviceState {
    if (state.safetyPlan?.operationHash === operationHash) return state
    const clearAfterMs = this.dependencies.clearAfterMs ?? 10_000
    const quitAfterMs = this.dependencies.quitAfterMs ?? 30_000
    return setSafetyPlan(
      state,
      {
        operationHash,
        acceptedAt: acceptedAt.toISOString(),
        clearDueAt: new Date(acceptedAt.getTime() + clearAfterMs).toISOString(),
        quitDueAt: new Date(acceptedAt.getTime() + quitAfterMs).toISOString(),
        clearedAt: null
      },
      acceptedAt
    )
  }

  activatePersistedPlan(): boolean {
    const plan = this.store.getState().safetyPlan
    if (!plan) return false
    this.startedWallMs = Date.parse(plan.acceptedAt)
    this.startedMonotonicMs = this.monotonicNow()
    this.clearing = false
    this.quitTriggered = false
    this.startTicker()
    this.onChange()
    return true
  }

  getSnapshot(): SafetySnapshot {
    const plan = this.store.getState().safetyPlan
    if (!plan) return emptySafetySnapshot()
    const elapsed = this.elapsedMs(plan.acceptedAt)
    const clearAfter = Math.max(0, Date.parse(plan.clearDueAt) - Date.parse(plan.acceptedAt))
    const quitAfter = Math.max(0, Date.parse(plan.quitDueAt) - Date.parse(plan.acceptedAt))
    const deadlineReached = elapsed >= clearAfter
    const cleared = plan.clearedAt !== null
    const loginBlocked = cleared || deadlineReached
    return {
      phase: cleared ? 'cleared' : 'countdown',
      clearRemainingMs: loginBlocked ? 0 : Math.max(0, clearAfter - elapsed),
      quitRemainingMs: Math.max(0, quitAfter - elapsed),
      clearDueAt: plan.clearDueAt,
      quitDueAt: plan.quitDueAt,
      loginBlocked,
      message: loginBlocked ? '账号状态异常，请稍后重试' : '即将清除登录并退出 APP'
    }
  }

  onSystemResume(): void {
    this.requestTick()
  }

  dispose(): void {
    if (this.timer) this.intervalClear()(this.timer)
    this.timer = null
  }

  private startTicker(): void {
    if (this.timer) return
    this.timer = this.intervalSet()(() => this.requestTick(), 250)
    this.requestTick()
  }

  private requestTick(): void {
    void this.tick().catch(() => this.onChange())
  }

  private async tick(): Promise<void> {
    const plan = this.store.getState().safetyPlan
    if (!plan) {
      this.dispose()
      return
    }
    const elapsed = this.elapsedMs(plan.acceptedAt)
    const clearAfter = Date.parse(plan.clearDueAt) - Date.parse(plan.acceptedAt)
    const quitAfter = Date.parse(plan.quitDueAt) - Date.parse(plan.acceptedAt)

    if (!plan.clearedAt && !this.clearing && elapsed >= clearAfter) {
      this.clearing = true
      try {
        await this.clearAll()
        await this.store.update((state) => {
          if (!state.safetyPlan) return state
          return setSafetyPlan(
            state,
            { ...state.safetyPlan, clearedAt: this.now().toISOString() },
            this.now()
          )
        })
      } catch {
        // Keep the login blocked, retry on the next tick, and never let a
        // cleanup error cancel the non-negotiable APP exit deadline.
      } finally {
        this.clearing = false
      }
    }

    if (!this.quitTriggered && elapsed >= quitAfter) {
      this.quitTriggered = true
      this.onChange()
      this.dispose()
      await this.quitApp()
      return
    }
    this.onChange()
  }

  private elapsedMs(acceptedAt: string): number {
    const wallStart = this.startedWallMs ?? Date.parse(acceptedAt)
    const monotonicStart = this.startedMonotonicMs ?? this.monotonicNow()
    const wallElapsed = Math.max(0, this.now().getTime() - wallStart)
    const monotonicElapsed = Math.max(0, this.monotonicNow() - monotonicStart)
    return Math.max(wallElapsed, monotonicElapsed)
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }

  private monotonicNow(): number {
    return this.dependencies.monotonicNow?.() ?? performance.now()
  }

  private intervalSet(): typeof setInterval {
    return this.dependencies.setInterval ?? setInterval
  }

  private intervalClear(): typeof clearInterval {
    return this.dependencies.clearInterval ?? clearInterval
  }
}

export function emptySafetySnapshot(): SafetySnapshot {
  return {
    phase: 'none',
    clearRemainingMs: 0,
    quitRemainingMs: 0,
    clearDueAt: null,
    quitDueAt: null,
    loginBlocked: false,
    message: null
  }
}
