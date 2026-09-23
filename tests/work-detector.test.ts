import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WorkDetector } from '../src/main/work-detector'
import { createDeviceState } from '../src/shared/work-state'

function workPostData(
  messageId: string,
  conversationKind: 'primary_assistant' | 'gizmo_interaction' = 'primary_assistant'
): string {
  return JSON.stringify({
    action: 'next',
    client_prepare_state: 'sent',
    conversation_mode: { kind: conversationKind },
    conversation_origin: 'tpp',
    model: 'gpt-5.6-sol-wm',
    messages: [{ id: messageId, author: { role: 'user' } }]
  })
}

describe('Work detector lifecycle', () => {
  it('does not touch the debugger after its web page has already been destroyed', () => {
    const webContents = {
      isDestroyed: () => true,
      get debugger(): never {
        throw new Error('debugger must not be accessed')
      }
    }
    const detector = new WorkDetector(
      webContents as never,
      'normal',
      {} as never,
      {} as never,
      vi.fn()
    )
    expect(() => detector.dispose()).not.toThrow()
    expect(() => detector.dispose()).not.toThrow()
  })

  it('tolerates a page being destroyed during debugger cleanup', () => {
    const debuggerApi = {
      off: vi.fn(() => {
        throw new Error('target disappeared')
      }),
      isAttached: vi.fn(() => true),
      detach: vi.fn()
    }
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => 'https://chatgpt.com/c/conversation-id',
        debugger: debuggerApi
      } as never,
      'incognito',
      {} as never,
      {} as never,
      vi.fn()
    )
    expect(() => detector.dispose()).not.toThrow()
    expect(debuggerApi.detach).not.toHaveBeenCalled()
  })

  it('fully pauses observation for authentication and safely resumes afterward', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attachCount = 0
      detachCount = 0
      attach(): void {
        this.attached = true
        this.attachCount += 1
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
        this.detachCount += 1
      }
      async sendCommand(method: string): Promise<object> {
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'root-page-target',
              type: 'page',
              url: 'https://chatgpt.com/',
              browserContextId: 'browser-context-1'
            }
          }
        }
        return {}
      }
    }

    type BeforeRequestListener = (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void
    type CompletedListener = (details: Electron.OnCompletedListenerDetails) => void
    type ErrorListener = (details: Electron.OnErrorOccurredListenerDetails) => void
    const webRequest = {
      before: null as BeforeRequestListener | null,
      completed: null as CompletedListener | null,
      failed: null as ErrorListener | null,
      onBeforeRequest: vi.fn((_filter, listener: BeforeRequestListener | null) => {
        webRequest.before = listener
      }),
      onCompleted: vi.fn((_filter, listener: CompletedListener | null) => {
        webRequest.completed = listener
      }),
      onErrorOccurred: vi.fn((_filter, listener: ErrorListener | null) => {
        webRequest.failed = listener
      })
    }
    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-11T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      { isDestroyed: () => false, debugger: debuggerApi } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn(),
      { webRequest, getBlobData: vi.fn() } as never
    )

    await detector.start()
    expect(debuggerApi.attached).toBe(true)
    expect(webRequest.before).not.toBeNull()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'stale-before-login',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('stale-operation')
      }
    })
    detector.pauseForAuthentication()

    expect(debuggerApi.attached).toBe(false)
    expect(detector.getHealth()).toBe('unverified')
    expect(webRequest.before).toBeNull()
    expect(webRequest.completed).toBeNull()
    expect(webRequest.failed).toBeNull()

    await detector.start()
    expect(debuggerApi.attached).toBe(true)
    expect(debuggerApi.attachCount).toBe(2)
    expect(debuggerApi.detachCount).toBe(1)
    expect(webRequest.before).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.pendingOperations).toHaveLength(0)

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'fresh-after-login',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('fresh-operation')
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))

    detector.dispose()
    expect(debuggerApi.attached).toBe(false)
    expect(debuggerApi.detachCount).toBe(2)
  })

  it('records the real response status while no Work rule is installed yet', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(method: string): Promise<object> {
        return method === 'Network.getResponseBody'
          ? { body: '{"status":"accepted"}', base64Encoded: false }
          : {}
      }
    }

    const debuggerApi = new FakeDebugger()
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      { isDestroyed: () => false, debugger: debuggerApi } as never,
      'normal',
      { update: vi.fn() } as never,
      recorder as never,
      vi.fn()
    )
    await detector.start()
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'request-1',
      request: {
        url: 'https://chatgpt.com/backend-api/example',
        method: 'POST',
        postData: '{"mode":"work"}'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'request-1',
      response: { url: 'https://chatgpt.com/backend-api/example', status: 202 }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: 'request-1' })

    await vi.waitFor(() => {
      expect(recorder.recordResponse).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'root\u0000request-1', status: 202 })
      )
    })
    detector.dispose()
  })

  it('confirms a Work request after its conversation stream status succeeds', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(): Promise<object> {
        return {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-09T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const accepted = vi.fn(async () => {
      expect(state.safetyPlan?.operationHash).toBe(state.recentOperationHashes.at(-1))
    })
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => 'https://chatgpt.com/c/conversation-id',
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn(),
      undefined,
      accepted,
      (current, event) => ({
        ...current,
        safetyPlan: {
          operationHash: event.operationHash,
          acceptedAt: event.acceptedAt.toISOString(),
          clearDueAt: new Date(event.acceptedAt.getTime() + 10_000).toISOString(),
          quitDueAt: new Date(event.acceptedAt.getTime() + 30_000).toISOString(),
          clearedAt: null
        }
      })
    )
    await detector.start()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'work-request',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('local-operation-id')
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'work-stream-status',
      request: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        method: 'GET'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'work-stream-status',
      response: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        status: 200
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'work-stream-status'
    })

    await vi.waitFor(() => expect(state.lastAcceptedAt).not.toBeNull())
    expect(state.pendingOperations).toHaveLength(0)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(state.safetyPlan?.operationHash).toBe(state.recentOperationHashes.at(-1))
    detector.dispose()
  })

  it('keeps multiple local Work submissions pending when one stream status cannot identify either operation', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(): Promise<object> {
        return {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-13T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const accepted = vi.fn()
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => 'https://chatgpt.com/c/conversation-id',
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn(),
      undefined,
      accepted
    )
    await detector.start()

    for (const [requestId, operationId] of [
      ['work-request-a', 'local-operation-a'],
      ['work-request-b', 'local-operation-b']
    ] as const) {
      debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
        requestId,
        request: {
          url: 'https://chatgpt.com/backend-api/f/conversation',
          method: 'POST',
          postData: workPostData(operationId)
        }
      })
    }
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(2))

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'ambiguous-stream-status',
      request: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        method: 'GET'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'ambiguous-stream-status',
      response: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        status: 200
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'ambiguous-stream-status'
    })

    await vi.waitFor(() => expect(recorder.recordResponse).toHaveBeenCalled())
    expect(state.pendingOperations).toHaveLength(2)
    expect(state.lastAcceptedAt).toBeNull()
    expect(accepted).not.toHaveBeenCalled()
    detector.dispose()
  })

  it('confirms after a new Work conversation finishes navigating to its accepted stream', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(): Promise<object> {
        return {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let currentPageUrl = 'https://chatgpt.com/'
    let state = createDeviceState(new Date('2026-09-11T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => currentPageUrl,
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn()
    )
    await detector.start()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'new-work-request',
      documentURL: 'https://chatgpt.com/',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('new-work-operation-id', 'gizmo_interaction')
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'early-stream-status',
      documentURL: 'https://chatgpt.com/',
      request: {
        url: 'https://chatgpt.com/backend-api/conversation/new-conversation/stream_status',
        method: 'GET'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'early-stream-status',
      response: {
        url: 'https://chatgpt.com/backend-api/conversation/new-conversation/stream_status',
        status: 200
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'early-stream-status'
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.lastAcceptedAt).toBeNull()
    expect(state.pendingOperations).toHaveLength(1)

    currentPageUrl = 'https://chatgpt.com/g/team/c/new-conversation'
    detector.reconcileCurrentPage()
    await vi.waitFor(() => expect(state.lastAcceptedAt).not.toBeNull())
    expect(state.pendingOperations).toHaveLength(0)
    detector.dispose()
  })

  it('rejects a matching Work request when the server returns an error', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(method: string): Promise<object> {
        return method === 'Network.getResponseBody'
          ? {
              body: 'data: {"type":"stream_handoff","options":[{"type":"resume_sse_endpoint"}]}\n',
              base64Encoded: false
            }
          : {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-09T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => 'https://chatgpt.com/c/other-conversation-id',
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn()
    )
    await detector.start()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'failed-work-request',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('failed-operation-id')
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))

    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'failed-work-request',
      response: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        status: 500
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'failed-work-request'
    })

    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(0))
    expect(state.lastAcceptedAt).toBeNull()
    detector.dispose()
  })

  it('keeps an interrupted operation pending and accepts its background-worker retry', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      commands: Array<{ method: string; params: object; sessionId?: string }> = []
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(
        method: string,
        params: object = {},
        sessionId?: string
      ): Promise<object> {
        this.commands.push({ method, params, sessionId })
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'root-page-target',
              type: 'page',
              url: 'https://chatgpt.com/',
              browserContextId: 'browser-context-1'
            }
          }
        }
        return method === 'Network.getResponseBody'
          ? {
              body: 'data: {"type":"stream_handoff","options":[{"type":"resume_sse_endpoint"}]}\n',
              base64Encoded: false
            }
          : {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-09T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      { isDestroyed: () => false, debugger: debuggerApi } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn()
    )
    const postData = workPostData('retry-operation-id')
    await detector.start()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'shared-request-id',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(state.pendingOperations[0]?.requestId).toMatch(/^[a-f0-9]{64}$/u)
    expect(state.pendingOperations[0]?.requestId).not.toContain('shared-request-id')

    debuggerApi.emit('message', {}, 'Network.loadingFailed', {
      requestId: 'shared-request-id'
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(state.lastAcceptedAt).toBeNull()

    debuggerApi.emit('message', {}, 'Target.targetCreated', {
      targetInfo: {
        targetId: 'other-context-worker',
        type: 'service_worker',
        url: 'https://chatgpt.com/service-worker.js',
        browserContextId: 'browser-context-2'
      }
    })
    debuggerApi.emit('message', {}, 'Target.targetCreated', {
      targetInfo: {
        targetId: 'service-worker-target',
        type: 'service_worker',
        url: 'https://chatgpt.com/service-worker.js',
        browserContextId: 'browser-context-1'
      }
    })
    await vi.waitFor(() => {
      expect(debuggerApi.commands).toContainEqual(
        expect.objectContaining({
          method: 'Target.attachToTarget',
          params: { targetId: 'service-worker-target', flatten: true }
        })
      )
    })
    expect(debuggerApi.commands).not.toContainEqual(
      expect.objectContaining({
        method: 'Target.attachToTarget',
        params: { targetId: 'other-context-worker', flatten: true }
      })
    )

    debuggerApi.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: {
        targetId: 'service-worker-target',
        type: 'service_worker',
        url: 'https://chatgpt.com/service-worker.js',
        browserContextId: 'browser-context-1'
      },
      waitingForDebugger: true
    })
    await vi.waitFor(() => {
      expect(debuggerApi.commands).toContainEqual(
        expect.objectContaining({ method: 'Network.enable', sessionId: 'worker-session' })
      )
      expect(debuggerApi.commands).toContainEqual(
        expect.objectContaining({
          method: 'Runtime.runIfWaitingForDebugger',
          sessionId: 'worker-session'
        })
      )
      expect(debuggerApi.commands).toContainEqual(
        expect.objectContaining({
          method: 'Target.setDiscoverTargets',
          sessionId: undefined
        })
      )
    })

    // Chromium may reuse a request id in another target; the target session keeps it distinct.
    debuggerApi.emit(
      'message',
      {},
      'Network.requestWillBeSent',
      {
        requestId: 'shared-request-id',
        request: {
          url: 'https://chatgpt.com/backend-api/f/conversation',
          method: 'POST',
          postData
        }
      },
      'worker-session'
    )
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    debuggerApi.emit(
      'message',
      {},
      'Network.responseReceived',
      {
        requestId: 'shared-request-id',
        response: {
          url: 'https://chatgpt.com/backend-api/f/conversation',
          status: 200
        }
      },
      'worker-session'
    )
    debuggerApi.emit(
      'message',
      {},
      'Network.loadingFinished',
      { requestId: 'shared-request-id' },
      'worker-session'
    )

    await vi.waitFor(() => expect(state.lastAcceptedAt).not.toBeNull())
    expect(state.pendingOperations).toHaveLength(0)
    expect(state.recentOperationHashes).toHaveLength(1)
    detector.dispose()
  })

  it('keeps a session-scoped offline request pending and confirms its accepted retry', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(method: string): Promise<object> {
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'root-page-target',
              type: 'page',
              url: 'https://chatgpt.com/',
              browserContextId: 'browser-context-1'
            }
          }
        }
        return {}
      }
    }

    type BeforeRequestListener = (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void
    type CompletedListener = (details: Electron.OnCompletedListenerDetails) => void
    type ErrorListener = (details: Electron.OnErrorOccurredListenerDetails) => void
    const webRequest = {
      before: null as BeforeRequestListener | null,
      completed: null as CompletedListener | null,
      failed: null as ErrorListener | null,
      onBeforeRequest: vi.fn((_filter, listener: BeforeRequestListener | null) => {
        webRequest.before = listener
      }),
      onCompleted: vi.fn((_filter, listener: CompletedListener | null) => {
        webRequest.completed = listener
      }),
      onErrorOccurred: vi.fn((_filter, listener: ErrorListener | null) => {
        webRequest.failed = listener
      })
    }
    const remoteSession = {
      webRequest,
      getBlobData: vi.fn()
    }
    const debuggerApi = new FakeDebugger()
    let currentPageUrl = 'https://chatgpt.com/'
    let state = createDeviceState(new Date('2026-09-10T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => currentPageUrl,
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn(),
      remoteSession as never
    )
    await detector.start()

    const postData = Buffer.from(workPostData('session-background-operation'))
    const callback = vi.fn()
    webRequest.before?.(
      {
        id: 71,
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        resourceType: 'other',
        referrer: 'https://chatgpt.com/',
        timestamp: 1,
        uploadData: [{ bytes: postData }]
      },
      callback
    )

    expect(callback).toHaveBeenCalledWith({})
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(state.lastAcceptedAt).toBeNull()
    expect(recorder.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'session-network',
        resourceType: 'other',
        hasWebContents: false
      })
    )

    webRequest.failed?.({
      id: 71,
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      resourceType: 'other',
      referrer: 'https://chatgpt.com/',
      timestamp: 2,
      fromCache: false,
      error: 'net::ERR_INTERNET_DISCONNECTED'
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(state.lastAcceptedAt).toBeNull()

    webRequest.before?.(
      {
        id: 72,
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        resourceType: 'other',
        referrer: 'https://chatgpt.com/',
        timestamp: 3,
        uploadData: [{ bytes: postData }]
      },
      vi.fn()
    )
    await vi.waitFor(() => expect(recorder.recordRequest).toHaveBeenCalledTimes(2))
    webRequest.completed?.({
      id: 72,
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      resourceType: 'other',
      referrer: 'https://chatgpt.com/',
      timestamp: 4,
      fromCache: false,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      error: 'net::OK'
    })
    currentPageUrl = 'https://chatgpt.com/c/session-conversation'
    webRequest.completed?.({
      id: 73,
      url: 'https://chatgpt.com/backend-api/conversation/session-conversation/stream_status',
      method: 'GET',
      resourceType: 'xhr',
      referrer: 'https://chatgpt.com/c/session-conversation',
      timestamp: 5,
      fromCache: false,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      error: 'net::OK'
    })
    await vi.waitFor(() => expect(state.lastAcceptedAt).not.toBeNull())
    expect(state.pendingOperations).toHaveLength(0)

    detector.dispose()
    expect(webRequest.before).toBeNull()
    expect(webRequest.completed).toBeNull()
    expect(webRequest.failed).toBeNull()
  })

  it('recovers a missing Work request body from the matching debugger session', async () => {
    const postData = workPostData('recovered-operation-id')
    class FakeDebugger extends EventEmitter {
      attached = false
      commands: Array<{ method: string; sessionId?: string }> = []
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(
        method: string,
        _params: object = {},
        sessionId?: string
      ): Promise<object> {
        void _params
        this.commands.push({ method, sessionId })
        return method === 'Network.getRequestPostData' ? { postData } : {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-09T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      { isDestroyed: () => false, debugger: debuggerApi } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn()
    )
    await detector.start()

    debuggerApi.emit(
      'message',
      {},
      'Network.requestWillBeSent',
      {
        requestId: 'bodyless-request',
        request: {
          url: 'https://chatgpt.com/backend-api/f/conversation',
          method: 'POST',
          hasPostData: true
        }
      },
      'worker-session'
    )

    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(debuggerApi.commands).toContainEqual({
      method: 'Network.getRequestPostData',
      sessionId: 'worker-session'
    })
    detector.dispose()
  })

  it('does not confirm a prepared draft', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(method: string): Promise<object> {
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'root-page-target',
              type: 'page',
              url: 'https://chatgpt.com/',
              browserContextId: 'browser-context-1'
            }
          }
        }
        return {}
      }
    }

    type BeforeRequestListener = (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void
    type CompletedListener = (details: Electron.OnCompletedListenerDetails) => void
    type ErrorListener = (details: Electron.OnErrorOccurredListenerDetails) => void
    const webRequest = {
      before: null as BeforeRequestListener | null,
      completed: null as CompletedListener | null,
      failed: null as ErrorListener | null,
      onBeforeRequest: vi.fn((_filter, listener: BeforeRequestListener | null) => {
        webRequest.before = listener
      }),
      onCompleted: vi.fn((_filter, listener: CompletedListener | null) => {
        webRequest.completed = listener
      }),
      onErrorOccurred: vi.fn((_filter, listener: ErrorListener | null) => {
        webRequest.failed = listener
      })
    }
    const remoteSession = { webRequest, getBlobData: vi.fn() }
    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-10T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      { isDestroyed: () => false, debugger: debuggerApi } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn(),
      remoteSession as never
    )
    await detector.start()

    const prepareBody = (queryId: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          action: 'next',
          client_prepare_dispatch: true,
          conversation_mode: { kind: 'primary_assistant' },
          conversation_origin: 'composer',
          model: 'gpt-5.6-sol-wm',
          parent_message_id: 'stable-parent-message',
          partial_query: { id: queryId }
        })
      )
    const prepareUrl = 'https://chatgpt.com/backend-api/f/conversation/prepare'

    webRequest.before?.(
      {
        id: 81,
        url: prepareUrl,
        method: 'POST',
        resourceType: 'xhr',
        referrer: 'https://chatgpt.com/',
        timestamp: 1,
        uploadData: [{ bytes: prepareBody('offline-attempt') }]
      },
      vi.fn()
    )
    await vi.waitFor(() => expect(recorder.recordRequest).toHaveBeenCalledTimes(1))
    expect(state.pendingOperations).toHaveLength(0)

    webRequest.failed?.({
      id: 81,
      url: prepareUrl,
      method: 'POST',
      resourceType: 'xhr',
      referrer: 'https://chatgpt.com/',
      timestamp: 2,
      fromCache: false,
      error: 'net::ERR_NAME_NOT_RESOLVED'
    })
    await vi.waitFor(() => expect(recorder.recordResponse).toHaveBeenCalledTimes(1))
    expect(state.pendingOperations).toHaveLength(0)
    expect(state.lastAcceptedAt).toBeNull()

    webRequest.before?.(
      {
        id: 82,
        url: prepareUrl,
        method: 'POST',
        resourceType: 'xhr',
        referrer: 'https://chatgpt.com/',
        timestamp: 3,
        uploadData: [{ bytes: prepareBody('online-retry') }]
      },
      vi.fn()
    )
    await vi.waitFor(() => expect(recorder.recordRequest).toHaveBeenCalledTimes(2))
    expect(state.pendingOperations).toHaveLength(0)
    webRequest.completed?.({
      id: 82,
      url: prepareUrl,
      method: 'POST',
      resourceType: 'xhr',
      referrer: 'https://chatgpt.com/',
      timestamp: 4,
      fromCache: false,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      error: 'net::OK'
    })
    await vi.waitFor(() => expect(recorder.recordResponse).toHaveBeenCalledTimes(2))
    expect(state.lastAcceptedAt).toBeNull()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'work-manager',
      request: {
        url: 'https://chatgpt.com/realtime/wm',
        method: 'POST'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'work-manager',
      response: {
        url: 'https://chatgpt.com/realtime/wm',
        status: 201
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'work-manager'
    })

    await vi.waitFor(() => expect(recorder.recordResponse).toHaveBeenCalledTimes(3))
    expect(state.lastAcceptedAt).toBeNull()
    expect(state.pendingOperations).toHaveLength(0)
    detector.dispose()
  })

  it('keeps a 2xx response pending when the acceptance handoff cannot be proven', async () => {
    class FakeDebugger extends EventEmitter {
      attached = false
      attach(): void {
        this.attached = true
      }
      isAttached(): boolean {
        return this.attached
      }
      detach(): void {
        this.attached = false
      }
      async sendCommand(method: string): Promise<object> {
        return method === 'Network.getResponseBody'
          ? {
              body: 'data: {"type":"input_message"}\n',
              base64Encoded: false
            }
          : {}
      }
    }

    const debuggerApi = new FakeDebugger()
    let state = createDeviceState(new Date('2026-09-09T00:00:00.000Z'))
    const store = {
      update: vi.fn(async (updater: (current: typeof state) => typeof state) => {
        state = updater(state)
        return state
      })
    }
    const recorder = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordResponse: vi.fn().mockResolvedValue(undefined),
      recordWebSocket: vi.fn().mockResolvedValue(undefined),
      recordTarget: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => false,
      setEnabled: vi.fn(),
      getLogPath: () => null
    }
    const detector = new WorkDetector(
      {
        isDestroyed: () => false,
        getURL: () => 'https://chatgpt.com/c/other-conversation-id',
        debugger: debuggerApi
      } as never,
      'normal',
      store as never,
      recorder as never,
      vi.fn()
    )
    await detector.start()

    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'ambiguous-request',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: workPostData('ambiguous-operation-id')
      }
    })
    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'ambiguous-request',
      response: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        status: 200
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'ambiguous-request'
    })
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'failed-stream-status',
      request: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        method: 'GET'
      }
    })
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'failed-stream-status',
      response: {
        url: 'https://chatgpt.com/backend-api/conversation/conversation-id/stream_status',
        status: 200
      }
    })
    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'failed-stream-status'
    })

    await vi.waitFor(() => expect(state.pendingOperations).toHaveLength(1))
    expect(state.lastAcceptedAt).toBeNull()
    detector.dispose()
  })
})
