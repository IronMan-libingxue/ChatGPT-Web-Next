import { afterEach, describe, expect, it, vi } from 'vitest'
import { SafetyController } from '../src/main/safety-controller'
import { createDeviceState, setSafetyPlan } from '../src/shared/work-state'

afterEach(() => vi.useRealTimers())

describe('automatic safety controller', () => {
  it('clears at the first deadline and quits at the second without allowing a duplicate to delay it', async () => {
    vi.useFakeTimers()
    const base = new Date('2026-09-13T00:00:00.000Z').getTime()
    let elapsed = 0
    let state = createDeviceState(new Date(base))
    const store = {
      getState: () => structuredClone(state),
      update: async (updater: (current: typeof state) => typeof state) => {
        state = updater(structuredClone(state))
        return structuredClone(state)
      }
    }
    const clearAll = vi.fn().mockResolvedValue(undefined)
    const quit = vi.fn().mockResolvedValue(undefined)
    const controller = new SafetyController(
      store as never,
      clearAll,
      quit,
      vi.fn(),
      {
        now: () => new Date(base + elapsed),
        monotonicNow: () => elapsed,
        clearAfterMs: 10_000,
        quitAfterMs: 30_000
      }
    )

    expect(await controller.trigger('operation-a', new Date(base))).toBe(true)
    const originalPlan = structuredClone(state.safetyPlan)
    elapsed = 5_000
    expect(await controller.trigger('operation-a', new Date(base + elapsed))).toBe(false)
    expect(state.safetyPlan).toEqual(originalPlan)

    expect(await controller.trigger('operation-b', new Date(base + elapsed))).toBe(true)
    expect(state.safetyPlan?.operationHash).toBe('operation-b')
    expect(state.safetyPlan?.clearDueAt).toBe(new Date(base + 15_000).toISOString())

    elapsed = 14_999
    controller.onSystemResume()
    await vi.runAllTicks()
    expect(clearAll).not.toHaveBeenCalled()

    elapsed = 15_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(clearAll).toHaveBeenCalledTimes(1))
    expect(controller.getSnapshot().loginBlocked).toBe(true)

    elapsed = 35_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(state.safetyPlan?.clearedAt).not.toBeNull()
    controller.dispose()
  })

  it('uses monotonic elapsed time so a wall-clock rollback cannot delay cleanup', async () => {
    vi.useFakeTimers()
    const base = new Date('2026-09-13T00:00:00.000Z').getTime()
    let monotonic = 0
    let wall = base
    let state = createDeviceState(new Date(base))
    const store = {
      getState: () => structuredClone(state),
      update: async (updater: (current: typeof state) => typeof state) => {
        state = updater(structuredClone(state))
        return structuredClone(state)
      }
    }
    const clearAll = vi.fn().mockResolvedValue(undefined)
    const controller = new SafetyController(
      store as never,
      clearAll,
      vi.fn(),
      vi.fn(),
      {
        now: () => new Date(wall),
        monotonicNow: () => monotonic,
        clearAfterMs: 10_000,
        quitAfterMs: 30_000
      }
    )
    await controller.trigger('operation-a', new Date(base))
    wall = base - 3_600_000
    monotonic = 10_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(clearAll).toHaveBeenCalledTimes(1))
    controller.dispose()
  })

  it('blocks login at the deadline but reports cleared only after storage cleanup finishes', async () => {
    vi.useFakeTimers()
    const base = new Date('2026-09-13T00:00:00.000Z').getTime()
    let elapsed = 0
    let state = createDeviceState(new Date(base))
    let finishCleanup = (): void => undefined
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const store = {
      getState: () => structuredClone(state),
      update: async (updater: (current: typeof state) => typeof state) => {
        state = updater(structuredClone(state))
        return structuredClone(state)
      }
    }
    const controller = new SafetyController(
      store as never,
      vi.fn(() => cleanup),
      vi.fn(),
      vi.fn(),
      {
        now: () => new Date(base + elapsed),
        monotonicNow: () => elapsed,
        clearAfterMs: 10_000,
        quitAfterMs: 30_000
      }
    )

    await controller.trigger('operation-a', new Date(base))
    elapsed = 10_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(controller.getSnapshot().loginBlocked).toBe(true))
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'countdown',
      clearRemainingMs: 0,
      loginBlocked: true
    })

    finishCleanup()
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('cleared'))
    controller.dispose()
  })

  it('clears an unfinished plan before any page may be loaded on restart', async () => {
    const acceptedAt = new Date('2026-09-13T00:00:00.000Z')
    let state = setSafetyPlan(createDeviceState(acceptedAt), {
      operationHash: 'operation-a',
      acceptedAt: acceptedAt.toISOString(),
      clearDueAt: new Date(acceptedAt.getTime() + 10_000).toISOString(),
      quitDueAt: new Date(acceptedAt.getTime() + 30_000).toISOString(),
      clearedAt: null
    })
    const store = {
      getState: () => structuredClone(state),
      update: async (updater: (current: typeof state) => typeof state) => {
        state = updater(structuredClone(state))
        return structuredClone(state)
      }
    }
    const clearAll = vi.fn().mockResolvedValue(undefined)
    const controller = new SafetyController(store as never, clearAll, vi.fn(), vi.fn())
    expect(await controller.recoverBeforePageLoad()).toBe(true)
    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(state.safetyPlan).toBeNull()
  })

  it('blocks login at ten seconds and still quits at thirty seconds when cleanup must retry', async () => {
    vi.useFakeTimers()
    const base = new Date('2026-09-13T00:00:00.000Z').getTime()
    let elapsed = 0
    let state = createDeviceState(new Date(base))
    const store = {
      getState: () => structuredClone(state),
      update: async (updater: (current: typeof state) => typeof state) => {
        state = updater(structuredClone(state))
        return structuredClone(state)
      }
    }
    const clearAll = vi.fn().mockRejectedValue(new Error('temporary clear failure'))
    const quit = vi.fn().mockResolvedValue(undefined)
    const controller = new SafetyController(store as never, clearAll, quit, vi.fn(), {
      now: () => new Date(base + elapsed),
      monotonicNow: () => elapsed,
      clearAfterMs: 10_000,
      quitAfterMs: 30_000
    })
    await controller.trigger('operation-a', new Date(base))
    elapsed = 10_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(clearAll).toHaveBeenCalled())
    expect(controller.getSnapshot().loginBlocked).toBe(true)
    elapsed = 30_000
    controller.onSystemResume()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    controller.dispose()
  })
})
