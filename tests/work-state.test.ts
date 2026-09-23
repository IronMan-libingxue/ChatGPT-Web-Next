import { describe, expect, it } from 'vitest'
import {
  createDeviceState,
  deriveWorkSnapshot,
  freezeWorkTimerOnStartup,
  materializeWorkTimer,
  pauseWorkTimer,
  recordAccepted,
  recordPending,
  rejectPending,
  resumeWorkTimer
} from '../src/shared/work-state'
import { WORK_WINDOW_MS } from '../src/shared/types'

describe('Work state', () => {
  it('starts unverified without inventing a usage event', () => {
    const now = new Date('2026-09-09T00:00:00.000Z')
    const state = createDeviceState(now)
    const snapshot = deriveWorkSnapshot(state, 'unverified', now)
    expect(snapshot.light).toBe('error')
    expect(snapshot.lastAcceptedAt).toBeNull()
    expect(snapshot.message).toContain('校准')
  })

  it('shows an intentionally paused logged-out detector as unused instead of abnormal', () => {
    const now = new Date('2026-09-09T00:00:00.000Z')
    const snapshot = deriveWorkSnapshot(createDeviceState(now), 'unverified', now, false)
    expect(snapshot.light).toBe('inactive')
    expect(snapshot.detectorHealth).toBe('unverified')
    expect(snapshot.message).toContain('登录后')
  })

  it('keeps an accepted operation active for exactly 96 hours', () => {
    const acceptedAt = new Date('2026-09-09T00:00:00.000Z')
    const state = recordAccepted(createDeviceState(acceptedAt), 'operation-a', acceptedAt)

    expect(state.workRemainingMs).toBe(WORK_WINDOW_MS)
    expect(
      deriveWorkSnapshot(state, 'healthy', new Date('2026-09-12T23:59:59.000Z')).light
    ).toBe('active')
    expect(
      deriveWorkSnapshot(state, 'healthy', new Date('2026-09-13T00:00:00.000Z')).light
    ).toBe('inactive')
  })

  it('does not extend the timer for a duplicate operation', () => {
    const first = new Date('2026-09-09T00:00:00.000Z')
    const initial = recordAccepted(createDeviceState(first), 'same-operation', first)
    const duplicate = recordAccepted(
      initial,
      'same-operation',
      new Date('2026-09-10T00:00:00.000Z')
    )
    expect(duplicate.workRemainingMs).toBe(initial.workRemainingMs)
    expect(duplicate.lastAcceptedAt).toBe(initial.lastAcceptedAt)
  })

  it('extends for a genuinely newer Work instruction but not an older recovered event', () => {
    const firstAt = new Date('2026-09-09T00:00:00.000Z')
    const first = recordAccepted(createDeviceState(firstAt), 'first', firstAt)
    const secondAt = new Date('2026-09-10T00:00:00.000Z')
    const second = recordAccepted(first, 'second', secondAt)
    const older = recordAccepted(second, 'older', new Date('2026-09-08T00:00:00.000Z'))
    expect(second.lastAcceptedAt).toBe(secondAt.toISOString())
    expect(older.lastAcceptedAt).toBe(second.lastAcceptedAt)
    expect(older.workRemainingMs).toBe(second.workRemainingMs)
  })

  it('shows pending only for a locally-created unmatched operation', () => {
    const now = new Date('2026-09-09T00:00:00.000Z')
    const state = recordPending(createDeviceState(now), {
      operationHash: 'pending-a',
      requestId: 'request-a',
      createdAt: now.toISOString(),
      windowKind: 'normal'
    })
    expect(deriveWorkSnapshot(state, 'healthy', now).light).toBe('pending')
    const rejected = rejectPending(state, 'pending-a', now)
    expect(deriveWorkSnapshot(rejected, 'healthy', now).light).toBe('inactive')
  })

  it('hides an unresolved operation after 24 hours', () => {
    const createdAt = new Date('2026-09-09T00:00:00.000Z')
    const state = recordPending(
      createDeviceState(createdAt),
      {
        operationHash: 'expired-pending',
        requestId: 'hashed-request',
        createdAt: createdAt.toISOString(),
        windowKind: 'normal'
      },
      createdAt
    )

    expect(
      deriveWorkSnapshot(state, 'healthy', new Date('2026-09-09T23:59:59.999Z')).light
    ).toBe('pending')
    expect(
      deriveWorkSnapshot(state, 'healthy', new Date('2026-09-10T00:00:00.001Z')).light
    ).toBe('inactive')
  })

  it('prunes expired pending records before adding a new operation', () => {
    const createdAt = new Date('2026-09-09T00:00:00.000Z')
    const original = recordPending(createDeviceState(createdAt), {
      operationHash: 'old-pending',
      requestId: 'old-request',
      createdAt: createdAt.toISOString(),
      windowKind: 'normal'
    })
    const nextAt = new Date('2026-09-10T00:00:00.001Z')
    const updated = recordPending(
      original,
      {
        operationHash: 'new-pending',
        requestId: 'new-request',
        createdAt: nextAt.toISOString(),
        windowKind: 'incognito'
      },
      nextAt
    )

    expect(updated.pendingOperations.map((item) => item.operationHash)).toEqual(['new-pending'])
  })

  it('keeps a confirmed red light while reporting a detector failure', () => {
    const now = new Date('2026-09-09T00:00:00.000Z')
    const state = recordAccepted(createDeviceState(now), 'accepted', now)
    const snapshot = deriveWorkSnapshot(
      state,
      'degraded',
      new Date('2026-09-10T00:00:00.000Z')
    )
    expect(snapshot.light).toBe('active')
    expect(snapshot.message).toContain('异常')
  })

  it('keeps the red light and reports a second offline operation as pending', () => {
    const acceptedAt = new Date('2026-09-09T00:00:00.000Z')
    const accepted = recordAccepted(createDeviceState(acceptedAt), 'accepted', acceptedAt)
    const pendingAt = new Date('2026-09-09T01:00:00.000Z')
    const state = recordPending(
      accepted,
      {
        operationHash: 'offline-pending',
        requestId: 'hashed-request',
        createdAt: pendingAt.toISOString(),
        windowKind: 'normal'
      },
      pendingAt
    )
    const snapshot = deriveWorkSnapshot(state, 'healthy', pendingAt)

    expect(snapshot.light).toBe('active')
    expect(snapshot.pendingCount).toBe(1)
    expect(snapshot.message).toContain('另有1次提交待确认')
  })

  it('flags a wall-clock rollback instead of claiming healthy inactivity', () => {
    const state = createDeviceState(new Date('2026-09-09T12:00:00.000Z'))
    const snapshot = deriveWorkSnapshot(
      state,
      'healthy',
      new Date('2026-09-09T00:00:00.000Z')
    )
    expect(snapshot.clockAnomaly).toBe(true)
    expect(snapshot.light).toBe('error')
  })

  it('pauses while the app is closed or logged out and resumes from the saved remainder', () => {
    const acceptedAt = new Date('2026-09-09T00:00:00.000Z')
    const accepted = recordAccepted(createDeviceState(acceptedAt), 'accepted', acceptedAt)
    const pausedAt = new Date('2026-09-09T01:00:00.000Z')
    const paused = pauseWorkTimer(accepted, pausedAt)
    expect(paused.workRemainingMs).toBe(WORK_WINDOW_MS - 60 * 60 * 1000)
    expect(paused.workTimerRunning).toBe(false)

    const nextDay = new Date('2026-09-10T01:00:00.000Z')
    const frozen = freezeWorkTimerOnStartup(paused, nextDay)
    expect(frozen.workRemainingMs).toBe(paused.workRemainingMs)
    const resumed = resumeWorkTimer(frozen, nextDay)
    const later = materializeWorkTimer(resumed, new Date('2026-09-10T01:30:00.000Z'))
    expect(later.workRemainingMs).toBe(WORK_WINDOW_MS - 90 * 60 * 1000)
  })

  it('never increases remaining time when the system clock moves backward', () => {
    const acceptedAt = new Date('2026-09-09T12:00:00.000Z')
    const accepted = recordAccepted(createDeviceState(acceptedAt), 'accepted', acceptedAt)
    const rollback = materializeWorkTimer(accepted, new Date('2026-09-09T11:00:00.000Z'))
    expect(rollback.workRemainingMs).toBe(WORK_WINDOW_MS)
  })
})
