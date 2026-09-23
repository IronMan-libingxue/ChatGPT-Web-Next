import {
  analyzeConversationPost,
  decodeRequestBody,
  isConversationSubmission,
  streamStatusConversationId
} from './detection.js'
import {
  confirmCandidate,
  createInitialPilotState,
  eligibleCandidates,
  normalizePilotState,
  pruneExpiredCandidates,
  publicViewState,
  recordAttention,
  recordIgnoredNonWork,
  recordMatchedWork,
  recordRequestCompleted,
  recordRequestError,
  recordStreamStatusSeen,
  sanitizedReport,
  type WorkPilotState
} from './state.js'

const STATE_KEY = 'chatgptWorkPilotStateV1'
const STREAM_STATUS_KEY = 'chatgptWorkPilotStreamRequestsV1'
const MAX_STREAM_STATUS_REQUESTS = 128
const OBSERVED_REQUESTS: chrome.webRequest.RequestFilter = {
  urls: [
    'https://chatgpt.com/backend-api/*',
    'https://*.chatgpt.com/backend-api/*'
  ]
}

let workQueue: Promise<void> = Promise.resolve()

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    enqueue(async () => handleBeforeRequest(details))
    return undefined
  },
  OBSERVED_REQUESTS,
  ['requestBody']
)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    enqueue(async () => handleCompleted(details))
  },
  OBSERVED_REQUESTS
)

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    enqueue(async () => handleError(details))
  },
  OBSERVED_REQUESTS
)

chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    const state = await readState()
    await writeState(state)
  })
})

chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    const state = pruneExpiredCandidates(await readState())
    await writeState(state)
  })
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isPilotMessage(message)) return false

  if (message.type === 'work-pilot:get-state') {
    enqueue(async () => sendResponse({ ok: true, state: publicViewState(await readState()) }))
    return true
  }

  if (message.type === 'work-pilot:get-report') {
    enqueue(async () => {
      const state = await readState()
      sendResponse({
        ok: true,
        report: {
          generatedAt: new Date().toISOString(),
          extensionVersion: chrome.runtime.getManifest().version,
          state: sanitizedReport(state)
        }
      })
    })
    return true
  }

  if (message.type === 'work-pilot:reset') {
    enqueue(async () => {
      const state = createInitialPilotState()
      state.events[0] = {
        at: state.updatedAt,
        kind: 'reset',
        message: '验证记录已由用户重置'
      }
      await writeState(state)
      sendResponse({ ok: true, state })
    })
    return true
  }

  return false
})

enqueue(async () => {
  const state = await readState()
  await writeState(state)
})

async function handleBeforeRequest(
  details: chrome.webRequest.OnBeforeRequestDetails
): Promise<void> {
  const streamConversationId = streamStatusConversationId(details.method, details.url)
  if (streamConversationId) {
    const [requestHash, conversationHash] = await Promise.all([
      sha256(details.requestId),
      sha256(streamConversationId)
    ])
    await rememberStreamStatusRequest({
      requestHash,
      conversationHash,
      tabId: details.tabId,
      observedAt: new Date(details.timeStamp).toISOString()
    })
    return
  }

  if (!isConversationSubmission(details.method, details.url)) return

  const body = decodeRequestBody(details.requestBody)
  const analysis = analyzeConversationPost(body)
  let state = await readState()
  const now = new Date()

  if (analysis.kind === 'not-work') {
    state = recordIgnoredNonWork(state, analysis.signals, now)
  } else if (analysis.kind === 'unreadable') {
    state = recordAttention(
      state,
      {
        message: analysis.reason,
        signals: analysis.signals,
        category: 'unreadable'
      },
      now
    )
  } else if (analysis.kind === 'work-like-unmatched') {
    state = recordAttention(
      state,
      {
        message: analysis.reason,
        signals: analysis.signals,
        category: 'unmatched-work-like'
      },
      now
    )
  } else {
    const [operationHash, requestHash, conversationHash] = await Promise.all([
      sha256(analysis.operationId),
      sha256(details.requestId),
      analysis.conversationId ? sha256(analysis.conversationId) : Promise.resolve(null)
    ])
    state = recordMatchedWork(
      state,
      {
        operationHash,
        requestHash,
        conversationHash,
        tabId: details.tabId,
        observedAt: now.toISOString(),
        transportCompletedAt: null,
        signals: analysis.signals
      },
      now
    )
  }

  await writeState(state)
}

async function handleCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
  let state = await readState()
  const now = new Date()

  if (isConversationSubmission(details.method, details.url)) {
    state = recordRequestCompleted(state, await sha256(details.requestId), details.statusCode, now)
    await writeState(state)
    return
  }

  const conversationId = streamStatusConversationId(details.method, details.url)
  if (!conversationId) return

  const streamObservation = await takeStreamStatusRequest(await sha256(details.requestId))
  if (details.statusCode !== 200 || !streamObservation) return

  state = recordStreamStatusSeen(state, now)
  const conversationHash = await sha256(conversationId)
  if (streamObservation.conversationHash !== conversationHash) return
  const candidates = eligibleCandidates(
    state,
    {
      conversationHash,
      tabId: details.tabId,
      signalObservedAt: new Date(streamObservation.observedAt)
    },
    now
  )

  if (candidates.length === 1 && candidates[0]) {
    state = confirmCandidate(state, candidates[0].operationHash, now)
  } else if (candidates.length > 1) {
    state = recordAttention(
      state,
      {
        message: '同一接受信号对应多个待确认操作，未自动计入使用',
        category: 'ambiguous'
      },
      now
    )
  }
  await writeState(state)
}

async function handleError(details: chrome.webRequest.OnErrorOccurredDetails): Promise<void> {
  if (isConversationSubmission(details.method, details.url)) {
    const state = recordRequestError(await readState(), await sha256(details.requestId))
    await writeState(state)
    return
  }
  if (streamStatusConversationId(details.method, details.url)) {
    await takeStreamStatusRequest(await sha256(details.requestId))
  }
}

async function readState(): Promise<WorkPilotState> {
  const stored = await chrome.storage.local.get(STATE_KEY)
  return normalizePilotState(stored[STATE_KEY])
}

async function writeState(state: WorkPilotState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state })
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*']
  })
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === 'number')
      .map(async (tab) => {
        try {
          await chrome.tabs.sendMessage(tab.id as number, {
            type: 'work-pilot:state-updated',
            state: publicViewState(state)
          })
        } catch {
          // The page may still be loading or may not have the content script yet.
        }
      })
  )
}

interface StreamStatusObservation {
  requestHash: string
  conversationHash: string
  tabId: number
  observedAt: string
}

async function rememberStreamStatusRequest(
  observation: StreamStatusObservation
): Promise<void> {
  const observations = await readStreamStatusRequests()
  const withoutDuplicate = observations.filter(
    (candidate) => candidate.requestHash !== observation.requestHash
  )
  await chrome.storage.session.set({
    [STREAM_STATUS_KEY]: [...withoutDuplicate, observation].slice(-MAX_STREAM_STATUS_REQUESTS)
  })
}

async function takeStreamStatusRequest(
  requestHash: string
): Promise<StreamStatusObservation | null> {
  const observations = await readStreamStatusRequests()
  const found = observations.find((candidate) => candidate.requestHash === requestHash) ?? null
  await chrome.storage.session.set({
    [STREAM_STATUS_KEY]: observations.filter(
      (candidate) => candidate.requestHash !== requestHash
    )
  })
  return found
}

async function readStreamStatusRequests(): Promise<StreamStatusObservation[]> {
  const stored = await chrome.storage.session.get(STREAM_STATUS_KEY)
  const value = stored[STREAM_STATUS_KEY]
  if (!Array.isArray(value)) return []
  const cutoff = Date.now() - 10 * 60_000
  return value.filter(isRecentStreamStatusObservation).filter(
    (observation) => new Date(observation.observedAt).getTime() >= cutoff
  )
}

function isRecentStreamStatusObservation(value: unknown): value is StreamStatusObservation {
  if (!value || typeof value !== 'object') return false
  const observation = value as Partial<StreamStatusObservation>
  return (
    typeof observation.requestHash === 'string' &&
    typeof observation.conversationHash === 'string' &&
    typeof observation.tabId === 'number' &&
    typeof observation.observedAt === 'string' &&
    Number.isFinite(new Date(observation.observedAt).getTime())
  )
}

function enqueue(task: () => Promise<void>): void {
  workQueue = workQueue.then(task).catch(async (error: unknown) => {
    try {
      const state = recordAttention(await readState(), {
        message: `验证程序内部错误：${safeError(error)}`,
        category: 'ambiguous'
      })
      await chrome.storage.local.set({ [STATE_KEY]: state })
    } catch {
      // Chrome will surface an extension service worker error if storage is unavailable.
    }
  })
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function isPilotMessage(value: unknown): value is { type: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      typeof (value as { type?: unknown }).type === 'string'
  )
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 160)
}
