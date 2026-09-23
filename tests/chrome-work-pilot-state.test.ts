import { describe, expect, it } from 'vitest'
import type { SafeWorkSignals } from '../chrome-work-pilot/src/detection'
import {
  confirmCandidate,
  createInitialPilotState,
  eligibleCandidates,
  recordIgnoredNonWork,
  recordMatchedWork,
  recordRequestCompleted,
  recordRequestError,
  recordStreamStatusSeen,
  publicViewState,
  sanitizedReport,
  type WorkPilotState
} from '../chrome-work-pilot/src/state'

const observedAt = new Date('2026-09-11T02:00:00.000Z')
const acceptedAt = new Date('2026-09-11T02:00:02.000Z')
const operationHash = 'a'.repeat(64)
const requestHash = 'b'.repeat(64)
const conversationHash = 'c'.repeat(64)
const signals: SafeWorkSignals = {
  action: 'next',
  clientPrepareState: 'sent',
  conversationMode: 'primary_assistant',
  conversationOrigin: 'tpp',
  model: 'gpt-5.6-sol-wm',
  authorRole: 'user'
}

function pendingState(input: { conversation?: string | null; operation?: string } = {}): WorkPilotState {
  return recordMatchedWork(
    createInitialPilotState(observedAt),
    {
      operationHash: input.operation ?? operationHash,
      requestHash,
      conversationHash: input.conversation === undefined ? conversationHash : input.conversation,
      tabId: 7,
      observedAt: observedAt.toISOString(),
      transportCompletedAt: null,
      signals
    },
    observedAt
  )
}

describe('Chrome Work pilot state machine', () => {
  it('only becomes confirmed after a matching later server signal', () => {
    let state = pendingState()
    expect(state.phase).toBe('pending')
    expect(state.lastConfirmedAt).toBeNull()

    state = recordRequestCompleted(state, requestHash, 200, acceptedAt)
    state = recordStreamStatusSeen(state, acceptedAt)
    const candidates = eligibleCandidates(
      state,
      { conversationHash, tabId: 7 },
      acceptedAt
    )
    expect(candidates).toHaveLength(1)

    state = confirmCandidate(state, candidates[0]?.operationHash ?? '', acceptedAt)
    expect(state.phase).toBe('confirmed')
    expect(state.health).toBe('healthy')
    expect(state.lastConfirmedAt).toBe(acceptedAt.toISOString())
    expect(state.statistics.confirmedWork).toBe(1)
    expect(state.pending).toHaveLength(0)
  })

  it('keeps ordinary chat out of pending and confirmed state', () => {
    const state = recordIgnoredNonWork(
      createInitialPilotState(observedAt),
      { conversationOrigin: 'chat', authorRole: 'user' },
      observedAt
    )
    expect(state.phase).toBe('idle')
    expect(state.pending).toHaveLength(0)
    expect(state.lastConfirmedAt).toBeNull()
    expect(state.statistics.ignoredNonWork).toBe(1)
  })

  it('does not confirm an explicitly rejected submission', () => {
    const state = recordRequestCompleted(pendingState(), requestHash, 403, acceptedAt)
    expect(state.pending).toHaveLength(0)
    expect(state.lastConfirmedAt).toBeNull()
    expect(state.statistics.rejectedWork).toBe(1)
  })

  it('does not confirm a transport failure', () => {
    const state = recordRequestError(pendingState(), requestHash, acceptedAt)
    expect(state.pending).toHaveLength(0)
    expect(state.lastConfirmedAt).toBeNull()
    expect(state.statistics.transportErrors).toBe(1)
  })

  it('deduplicates a repeated operation after confirmation', () => {
    let state = confirmCandidate(pendingState(), operationHash, acceptedAt)
    state = recordMatchedWork(
      state,
      {
        operationHash,
        requestHash: 'd'.repeat(64),
        conversationHash,
        tabId: 7,
        observedAt: new Date(acceptedAt.getTime() + 1_000).toISOString(),
        transportCompletedAt: null,
        signals
      },
      new Date(acceptedAt.getTime() + 1_000)
    )
    expect(state.pending).toHaveLength(0)
    expect(state.statistics.confirmedWork).toBe(1)
    expect(state.statistics.duplicates).toBe(1)
    expect(state.lastConfirmedAt).toBe(acceptedAt.toISOString())
  })

  it('refuses to guess when one success signal could match multiple new tasks', () => {
    let state = pendingState({ conversation: null })
    state = recordMatchedWork(
      state,
      {
        operationHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
        conversationHash: null,
        tabId: 7,
        observedAt: new Date(observedAt.getTime() + 500).toISOString(),
        transportCompletedAt: null,
        signals
      },
      new Date(observedAt.getTime() + 500)
    )
    expect(eligibleCandidates(state, { conversationHash, tabId: 7 }, acceptedAt)).toHaveLength(2)
  })

  it('rejects a status request that started before the local Work submission', () => {
    const state = pendingState()
    const candidates = eligibleCandidates(
      state,
      {
        conversationHash,
        tabId: 7,
        signalObservedAt: new Date(observedAt.getTime() - 1)
      },
      acceptedAt
    )
    expect(candidates).toHaveLength(0)
  })

  it('exports only shortened anonymous hints, never full operation or conversation hashes', () => {
    let state = pendingState()
    state = confirmCandidate(state, operationHash, acceptedAt)
    const report = sanitizedReport(state)
    const serialized = JSON.stringify(report)

    expect(report.confirmedOperationHints).toEqual(['aaaaaaaa'])
    expect(serialized).not.toContain(operationHash)
    expect(serialized).not.toContain(requestHash)
    expect(serialized).not.toContain(conversationHash)
    expect(serialized).not.toContain('confirmedOperationHashes')
  })

  it('sends the page only counts and safe events, never internal hashes', () => {
    const view = publicViewState(pendingState())
    const serialized = JSON.stringify(view)
    expect(view.pendingCount).toBe(1)
    expect(serialized).not.toContain(operationHash)
    expect(serialized).not.toContain(requestHash)
    expect(serialized).not.toContain(conversationHash)
  })
})
