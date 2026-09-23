import type { Session, WebContents } from 'electron'
import type { DetectorHealth, PendingOperation, PersistedDeviceState } from '../shared/types'
import { prunePending, recordAccepted, recordPending, rejectPending } from '../shared/work-state'
import {
  CalibrationRecorder,
  hashIdentifier,
  summarizeBody,
  type StructuralSummary
} from './calibration-recorder'
import { DeviceStateStore } from './device-state-store'
import {
  extractOperationHash,
  isPotentialWorkRequest,
  matchWorkRequest,
  matchesAcceptance,
  WORK_RULES,
  WORK_RULE_VERSION,
  type WorkDetectionRule
} from './work-rules'

const ROOT_SESSION = 'root'
const CHILD_TARGET_TYPES = new Set(['iframe', 'service_worker', 'shared_worker', 'worker'])
const DISCOVERED_TARGET_TYPES = new Set(['service_worker', 'shared_worker', 'worker'])
const DISCOVERY_TARGET_FILTER = [
  { type: 'service_worker', exclude: false },
  { type: 'shared_worker', exclude: false },
  { type: 'worker', exclude: false },
  { exclude: true }
]
const WORK_REQUEST_FILTER = {
  urls: [
    'https://chatgpt.com/backend-api/f/conversation*',
    'https://*.chatgpt.com/backend-api/f/conversation*',
    'https://openai.com/backend-api/f/conversation*',
    'https://*.openai.com/backend-api/f/conversation*',
    'https://chatgpt.com/backend-api/conversation/*/stream_status*',
    'https://*.chatgpt.com/backend-api/conversation/*/stream_status*',
    'https://openai.com/backend-api/conversation/*/stream_status*',
    'https://*.openai.com/backend-api/conversation/*/stream_status*'
  ]
}
const MAX_UPLOAD_BODY_BYTES = 1024 * 1024
const WORK_STREAM_STATUS_WINDOW_MS = 60 * 1000
const AUTO_ATTACH_OPTIONS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true
}

interface CandidateOperation {
  operationHash: string
  rule: WorkDetectionRule
  responseStatus?: number
}

interface RequestWillBeSent {
  documentURL?: string
  requestId: string
  request: {
    url: string
    method: string
    postData?: string
    hasPostData?: boolean
  }
}

interface ResponseReceived {
  requestId: string
  response: {
    url: string
    status: number
  }
}

interface LoadingEvent {
  requestId: string
}

interface WebSocketFrameEvent {
  requestId: string
  response: {
    payloadData: string
  }
}

interface AttachedToTargetEvent {
  sessionId: string
  targetInfo: TargetInfo
  waitingForDebugger: boolean
}

interface DetachedFromTargetEvent {
  sessionId: string
  targetId?: string
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
  browserContextId?: string
}

interface TargetInfoEvent {
  targetInfo: TargetInfo
}

export interface WorkAcceptedEvent {
  operationHash: string
  acceptedAt: Date
}

export class WorkDetector {
  private health: DetectorHealth = 'unverified'
  private readonly candidates = new Map<string, CandidateOperation>()
  private readonly requestUrls = new Map<string, string>()
  private readonly requestMethods = new Map<string, string>()
  private readonly requestDocumentUrls = new Map<string, string>()
  private readonly responseStatuses = new Map<string, number>()
  private readonly sessionCandidates = new Map<number, CandidateOperation>()
  private readonly streamStatusCandidates = new Map<string, number>()
  private readonly streamStatusSuccesses = new Map<string, number>()
  private readonly targetSessions = new Map<string, TargetInfo>()
  private readonly targetSessionIds = new Map<string, string>()
  private readonly networkEnabledSessions = new Set<string>()
  private readonly attachingTargetIds = new Set<string>()
  private messageQueue: Promise<void> = Promise.resolve()
  private sessionObservationAttached = false
  private relatedObservationReady = false
  private rootBrowserContextId: string | undefined
  private observationGeneration = 0
  private authenticationPaused = false
  private disposed = false
  private started = false

  constructor(
    private readonly webContents: WebContents,
    private readonly windowKind: 'normal' | 'incognito',
    private readonly store: DeviceStateStore,
    private readonly recorder: CalibrationRecorder,
    private readonly onChange: () => void,
    private readonly remoteSession?: Session,
    private readonly onAccepted?: (event: WorkAcceptedEvent) => void | Promise<void>,
    private readonly prepareAcceptedState?: (
      state: PersistedDeviceState,
      event: WorkAcceptedEvent
    ) => PersistedDeviceState
  ) {}

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    const generation = ++this.observationGeneration
    this.authenticationPaused = false
    this.started = true
    this.clearTransientObservationState()
    try {
      if (!this.webContents.debugger.isAttached()) {
        this.webContents.debugger.attach()
      }
      this.webContents.debugger.off('message', this.handleMessage)
      this.webContents.debugger.off('detach', this.handleDetach)
      this.webContents.debugger.on('message', this.handleMessage)
      this.webContents.debugger.on('detach', this.handleDetach)
      this.attachSessionObservation()
      await this.enableTargetObservation()
      if (!this.isActiveGeneration(generation)) return
      this.relatedObservationReady = await this.enableRelatedTargetObservation()
      if (!this.isActiveGeneration(generation)) return
      this.health =
        WORK_RULES.length === 0
          ? 'unverified'
          : this.relatedObservationReady || this.sessionObservationAttached
            ? 'healthy'
            : 'degraded'
      if (WORK_RULES.length > 0) {
        await this.store.update((state) => ({
          ...prunePending(state),
          detectorRuleVersion: WORK_RULE_VERSION
        }))
      }
      if (!this.isActiveGeneration(generation)) return
      this.onChange()
    } catch {
      if (!this.isActiveGeneration(generation)) return
      this.started = false
      this.stopObservation()
      this.health = 'degraded'
      this.onChange()
    }
  }

  pauseForAuthentication(): void {
    if (this.disposed || this.authenticationPaused) return
    this.authenticationPaused = true
    this.observationGeneration += 1
    this.started = false
    this.health = 'unverified'
    this.clearTransientObservationState()
    this.stopObservation()
    this.onChange()
  }

  getHealth(): DetectorHealth {
    return this.health
  }

  reconcileCurrentPage(): void {
    if (this.disposed || !this.started) return
    this.enqueue(async () => {
      const conversationId = conversationIdFromPageUrl(this.webContents.getURL())
      if (!conversationId || !this.hasRecentStreamStatusSuccess(conversationId)) return
      this.streamStatusSuccesses.delete(conversationId)
      await this.acceptStreamStatusCandidates()
    })
  }

  async setCalibrationEnabled(enabled: boolean): Promise<void> {
    await this.recorder.setEnabled(enabled)
    if (enabled && this.started) {
      await this.recorder.recordTarget({
        event: this.relatedObservationReady ? 'observation-ready' : 'observation-fallback'
      })
      for (const targetInfo of this.targetSessions.values()) {
        await this.recorder.recordTarget({
          event: 'attached',
          targetId: targetInfo.targetId,
          targetType: targetInfo.type,
          url: targetInfo.url
        })
      }
    }
    this.onChange()
  }

  isCalibrationEnabled(): boolean {
    return this.recorder.isEnabled()
  }

  getCalibrationLogPath(): string | null {
    return this.recorder.getLogPath()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observationGeneration += 1
    this.started = false
    this.clearTransientObservationState()
    this.stopObservation()
  }

  private clearTransientObservationState(): void {
    this.candidates.clear()
    this.requestUrls.clear()
    this.requestMethods.clear()
    this.requestDocumentUrls.clear()
    this.responseStatuses.clear()
    this.sessionCandidates.clear()
    this.streamStatusCandidates.clear()
    this.streamStatusSuccesses.clear()
    this.targetSessions.clear()
    this.targetSessionIds.clear()
    this.networkEnabledSessions.clear()
    this.attachingTargetIds.clear()
    this.relatedObservationReady = false
    this.rootBrowserContextId = undefined
  }

  private stopObservation(): void {
    this.detachSessionObservation()
    if (this.webContents.isDestroyed()) return
    try {
      this.webContents.debugger.off('message', this.handleMessage)
      this.webContents.debugger.off('detach', this.handleDetach)
      if (this.webContents.debugger.isAttached()) {
        this.webContents.debugger.detach()
      }
    } catch {
      // The target can be destroyed between the guard and the debugger cleanup.
    }
  }

  private isActiveGeneration(generation: number): boolean {
    return !this.disposed && this.started && generation === this.observationGeneration
  }

  private readonly handleDetach = (): void => {
    if (this.disposed || !this.started) return
    this.started = false
    this.health = 'degraded'
    this.onChange()
  }

  private readonly handleMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    const generation = this.observationGeneration
    this.messageQueue = this.messageQueue
      .then(async () => {
        if (this.isActiveGeneration(generation)) {
          await this.routeMessage(method, params, sessionId)
        }
      })
      .catch(() => {
        if (!this.isActiveGeneration(generation)) return
        this.health = 'degraded'
        this.onChange()
      })
  }

  private async routeMessage(method: string, params: unknown, sessionId?: string): Promise<void> {
    switch (method) {
      case 'Target.attachedToTarget':
        await this.onAttachedToTarget(params as AttachedToTargetEvent)
        break
      case 'Target.detachedFromTarget':
        await this.onDetachedFromTarget(params as DetachedFromTargetEvent)
        break
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        await this.onTargetInfoChanged(params as TargetInfoEvent)
        break
      case 'Network.requestWillBeSent':
        await this.onRequest(params as RequestWillBeSent, sessionId)
        break
      case 'Network.responseReceived':
        await this.onResponse(params as ResponseReceived, sessionId)
        break
      case 'Network.loadingFinished':
        await this.onLoadingFinished(params as LoadingEvent, sessionId)
        break
      case 'Network.loadingFailed':
        await this.onLoadingFailed(params as LoadingEvent, sessionId)
        break
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived':
        await this.onWebSocketFrame(
          method === 'Network.webSocketFrameSent' ? 'websocket-sent' : 'websocket-received',
          params as WebSocketFrameEvent,
          sessionId
        )
        break
      default:
        break
    }
  }

  private async enableTargetObservation(sessionId?: string): Promise<void> {
    await this.webContents.debugger.sendCommand(
      'Network.enable',
      { maxPostDataSize: 1024 * 1024 },
      sessionId
    )
    await this.webContents.debugger.sendCommand(
      'Target.setAutoAttach',
      AUTO_ATTACH_OPTIONS,
      sessionId
    )
  }

  private async enableRelatedTargetObservation(): Promise<boolean> {
    try {
      const current = (await this.webContents.debugger.sendCommand(
        'Target.getTargetInfo'
      )) as { targetInfo?: TargetInfo }
      if (!current.targetInfo?.targetId || !current.targetInfo.browserContextId) return false
      this.rootBrowserContextId = current.targetInfo.browserContextId

      await this.webContents.debugger.sendCommand('Target.setDiscoverTargets', {
        discover: true,
        filter: DISCOVERY_TARGET_FILTER
      })
      await this.recorder.recordTarget({
        event: 'observation-ready',
        targetId: current.targetInfo.targetId,
        targetType: current.targetInfo.type,
        url: current.targetInfo.url
      })
      return true
    } catch {
      await this.recorder.recordTarget({ event: 'observation-fallback' })
      return false
    }
  }

  private async onAttachedToTarget(event: AttachedToTargetEvent): Promise<void> {
    this.targetSessions.set(event.sessionId, event.targetInfo)
    this.targetSessionIds.set(event.targetInfo.targetId, event.sessionId)
    await this.recorder.recordTarget({
      event: 'attached',
      targetId: event.targetInfo.targetId,
      targetType: event.targetInfo.type,
      url: event.targetInfo.url
    })
    try {
      if (
        CHILD_TARGET_TYPES.has(event.targetInfo.type) &&
        isObservedTargetUrl(event.targetInfo.url)
      ) {
        try {
          await this.enableTargetObservation(event.sessionId)
          this.networkEnabledSessions.add(event.sessionId)
          await this.recorder.recordTarget({
            event: 'network-enabled',
            targetId: event.targetInfo.targetId,
            targetType: event.targetInfo.type,
            url: event.targetInfo.url
          })
        } catch {
          await this.recorder.recordTarget({
            event: 'network-enable-failed',
            targetId: event.targetInfo.targetId,
            targetType: event.targetInfo.type,
            url: event.targetInfo.url
          })
        }
      }
    } finally {
      if (event.waitingForDebugger) {
        try {
          await this.webContents.debugger.sendCommand(
            'Runtime.runIfWaitingForDebugger',
            {},
            event.sessionId
          )
        } catch {
          // A short-lived worker may disappear before it can be resumed.
        }
      }
    }
  }

  private async onDetachedFromTarget(event: DetachedFromTargetEvent): Promise<void> {
    const targetInfo = this.targetSessions.get(event.sessionId)
    await this.recorder.recordTarget({
      event: 'detached',
      targetId: event.targetId ?? targetInfo?.targetId,
      targetType: targetInfo?.type,
      url: targetInfo?.url
    })
    this.clearSession(event.sessionId)
  }

  private async onTargetInfoChanged(event: TargetInfoEvent): Promise<void> {
    if (!this.shouldObserveDiscoveredTarget(event.targetInfo)) return
    const sessionId = this.targetSessionIds.get(event.targetInfo.targetId)
    await this.recorder.recordTarget({
      event: 'changed',
      targetId: event.targetInfo.targetId,
      targetType: event.targetInfo.type,
      url: event.targetInfo.url
    })
    if (!sessionId) {
      await this.attachDiscoveredTarget(event.targetInfo)
      return
    }
    this.targetSessions.set(sessionId, event.targetInfo)
    if (
      !this.networkEnabledSessions.has(sessionId) &&
      CHILD_TARGET_TYPES.has(event.targetInfo.type) &&
      isObservedTargetUrl(event.targetInfo.url)
    ) {
      try {
        await this.enableTargetObservation(sessionId)
        this.networkEnabledSessions.add(sessionId)
        await this.recorder.recordTarget({
          event: 'network-enabled',
          targetId: event.targetInfo.targetId,
          targetType: event.targetInfo.type,
          url: event.targetInfo.url
        })
      } catch {
        await this.recorder.recordTarget({
          event: 'network-enable-failed',
          targetId: event.targetInfo.targetId,
          targetType: event.targetInfo.type,
          url: event.targetInfo.url
        })
      }
    }
  }

  private shouldObserveDiscoveredTarget(targetInfo: TargetInfo): boolean {
    return (
      DISCOVERED_TARGET_TYPES.has(targetInfo.type) &&
      Boolean(this.rootBrowserContextId) &&
      targetInfo.browserContextId === this.rootBrowserContextId &&
      isObservedTargetUrl(targetInfo.url)
    )
  }

  private async attachDiscoveredTarget(targetInfo: TargetInfo): Promise<void> {
    if (
      this.targetSessionIds.has(targetInfo.targetId) ||
      this.attachingTargetIds.has(targetInfo.targetId)
    ) {
      return
    }
    this.attachingTargetIds.add(targetInfo.targetId)
    try {
      await this.webContents.debugger.sendCommand('Target.attachToTarget', {
        targetId: targetInfo.targetId,
        flatten: true
      })
    } catch {
      await this.recorder.recordTarget({
        event: 'network-enable-failed',
        targetId: targetInfo.targetId,
        targetType: targetInfo.type,
        url: targetInfo.url
      })
    } finally {
      this.attachingTargetIds.delete(targetInfo.targetId)
    }
  }

  private async onRequest(event: RequestWillBeSent, sessionId?: string): Promise<void> {
    const { requestId, request } = event
    const key = requestKey(requestId, sessionId)
    this.requestUrls.set(key, request.url)
    this.requestMethods.set(key, request.method)
    if (event.documentURL) this.requestDocumentUrls.set(key, event.documentURL)
    if (this.requestUrls.size > 2000) {
      const first = this.requestUrls.keys().next().value
      if (typeof first === 'string') {
        this.requestUrls.delete(first)
        this.requestMethods.delete(first)
        this.requestDocumentUrls.delete(first)
      }
    }

    let postData = request.postData
    if (
      !postData &&
      (request.hasPostData || isPotentialWorkRequest(request.method, request.url))
    ) {
      try {
        const result = (await this.webContents.debugger.sendCommand(
          'Network.getRequestPostData',
          { requestId },
          sessionId
        )) as { postData?: string }
        postData = result.postData
      } catch {
        // Some cached or already-running worker requests no longer expose their body.
      }
    }

    await this.recorder.recordRequest({
      requestId: key,
      method: request.method,
      url: request.url,
      body: postData,
      source: 'debugger'
    })

    const summary = summarizeBody(postData)
    const rule = matchWorkRequest({ method: request.method, url: request.url, summary })
    if (!rule) return

    const operationHash = extractOperationHash(rule, postData, summary)
    if (!operationHash) return
    const pending: PendingOperation = {
      operationHash,
      requestId: hashIdentifier(key),
      createdAt: new Date().toISOString(),
      windowKind: this.windowKind
    }
    const state = await this.store.update((current) => recordPending(current, pending))
    if (state.pendingOperations.some((operation) => operation.operationHash === operationHash)) {
      this.candidates.set(key, { operationHash, rule })
      if (rule.acceptanceMode === 'stream-status') {
        this.rememberStreamStatusCandidate(operationHash)
      }
    }
    this.onChange()
  }

  private async onResponse(event: ResponseReceived, sessionId?: string): Promise<void> {
    const key = requestKey(event.requestId, sessionId)
    this.responseStatuses.set(key, event.response.status)
    const candidate = this.candidates.get(key)
    if (candidate) candidate.responseStatus = event.response.status
  }

  private async onLoadingFinished(event: LoadingEvent, sessionId?: string): Promise<void> {
    const key = requestKey(event.requestId, sessionId)
    const url = this.requestUrls.get(key)
    let responseBody: string | undefined
    if (url && (this.recorder.isEnabled() || this.candidates.has(key))) {
      try {
        const response = (await this.webContents.debugger.sendCommand(
          'Network.getResponseBody',
          { requestId: event.requestId },
          sessionId
        )) as { body?: string; base64Encoded?: boolean }
        responseBody = response.body
        if (response.base64Encoded && responseBody) {
          responseBody = Buffer.from(responseBody, 'base64').toString('utf8')
        }
      } catch {
        // A streaming or background response may not expose a completed body.
      }
    }

    if (url) {
      await this.recorder.recordResponse({
        requestId: key,
        url,
        status: this.responseStatuses.get(key) ?? 0,
        body: responseBody,
        source: 'debugger'
      })
    }

    const candidate = this.candidates.get(key)
    if (candidate) {
      const summary: StructuralSummary = summarizeBody(responseBody)
      const acceptedStatus =
        typeof candidate.responseStatus === 'number' &&
        candidate.responseStatus >= 200 &&
        candidate.responseStatus < 300
      const explicitServerFailure =
        typeof candidate.responseStatus === 'number' && candidate.responseStatus >= 400

      if (acceptedStatus && matchesAcceptance(candidate.rule, summary)) {
        await this.acceptOperations([candidate.operationHash], new Date())
        this.streamStatusCandidates.delete(candidate.operationHash)
      } else if (explicitServerFailure) {
        await this.store.update((state) => rejectPending(state, candidate.operationHash))
        this.streamStatusCandidates.delete(candidate.operationHash)
      }

      this.candidates.delete(key)
      this.onChange()
    }

    if (url) {
      const conversationId = workStreamStatusConversationId(
        this.requestMethods.get(key),
        url,
        this.responseStatuses.get(key)
      )
      if (conversationId) {
        this.rememberStreamStatusSuccess(conversationId)
        if (
          pageMatchesConversation(this.webContents.getURL(), conversationId) ||
          pageMatchesConversation(this.requestDocumentUrls.get(key), conversationId)
        ) {
          this.streamStatusSuccesses.delete(conversationId)
          await this.acceptStreamStatusCandidates()
        }
      }
    }
    this.requestUrls.delete(key)
    this.requestMethods.delete(key)
    this.requestDocumentUrls.delete(key)
    this.responseStatuses.delete(key)
  }

  private async onLoadingFailed(event: LoadingEvent, sessionId?: string): Promise<void> {
    const key = requestKey(event.requestId, sessionId)
    const candidate = this.candidates.get(key)
    if (candidate) {
      this.candidates.delete(key)
      this.streamStatusCandidates.delete(candidate.operationHash)
      // Transport failure is ambiguous: keep the encrypted pending operation so a
      // background retry with the same operation identifier can confirm it later.
      this.onChange()
    }
    this.requestUrls.delete(key)
    this.requestMethods.delete(key)
    this.requestDocumentUrls.delete(key)
    this.responseStatuses.delete(key)
  }

  private async onWebSocketFrame(
    direction: 'websocket-sent' | 'websocket-received',
    event: WebSocketFrameEvent,
    sessionId?: string
  ): Promise<void> {
    const key = requestKey(event.requestId, sessionId)
    const url = this.requestUrls.get(key)
    if (!url) return
    await this.recorder.recordWebSocket(direction, key, url, event.response.payloadData)
  }

  private clearSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.requestUrls.keys()) {
      if (key.startsWith(prefix)) this.requestUrls.delete(key)
    }
    for (const key of this.requestMethods.keys()) {
      if (key.startsWith(prefix)) this.requestMethods.delete(key)
    }
    for (const key of this.requestDocumentUrls.keys()) {
      if (key.startsWith(prefix)) this.requestDocumentUrls.delete(key)
    }
    for (const key of this.responseStatuses.keys()) {
      if (key.startsWith(prefix)) this.responseStatuses.delete(key)
    }
    for (const key of this.candidates.keys()) {
      if (key.startsWith(prefix)) this.candidates.delete(key)
    }
    const targetInfo = this.targetSessions.get(sessionId)
    if (targetInfo) this.targetSessionIds.delete(targetInfo.targetId)
    this.targetSessions.delete(sessionId)
    this.networkEnabledSessions.delete(sessionId)
  }

  private attachSessionObservation(): void {
    if (!this.remoteSession || this.sessionObservationAttached) return
    this.remoteSession.webRequest.onBeforeRequest(
      WORK_REQUEST_FILTER,
      this.handleSessionBeforeRequest
    )
    this.remoteSession.webRequest.onCompleted(
      WORK_REQUEST_FILTER,
      this.handleSessionCompleted
    )
    this.remoteSession.webRequest.onErrorOccurred(
      WORK_REQUEST_FILTER,
      this.handleSessionError
    )
    this.sessionObservationAttached = true
  }

  private detachSessionObservation(): void {
    if (!this.remoteSession || !this.sessionObservationAttached) return
    this.remoteSession.webRequest.onBeforeRequest(WORK_REQUEST_FILTER, null)
    this.remoteSession.webRequest.onCompleted(WORK_REQUEST_FILTER, null)
    this.remoteSession.webRequest.onErrorOccurred(WORK_REQUEST_FILTER, null)
    this.sessionObservationAttached = false
  }

  private readonly handleSessionBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void
  ): void => {
    callback({})
    this.enqueue(async () => this.onSessionBeforeRequest(details))
  }

  private readonly handleSessionCompleted = (
    details: Electron.OnCompletedListenerDetails
  ): void => {
    this.enqueue(async () => this.onSessionCompleted(details))
  }

  private readonly handleSessionError = (
    details: Electron.OnErrorOccurredListenerDetails
  ): void => {
    this.enqueue(async () => this.onSessionError(details))
  }

  private enqueue(task: () => Promise<void>): void {
    const generation = this.observationGeneration
    this.messageQueue = this.messageQueue
      .then(async () => {
        if (this.isActiveGeneration(generation)) await task()
      })
      .catch(() => {
        if (!this.isActiveGeneration(generation)) return
        this.health = 'degraded'
        this.onChange()
      })
  }

  private async onSessionBeforeRequest(
    details: Electron.OnBeforeRequestListenerDetails
  ): Promise<void> {
    const body = await readUploadBody(this.remoteSession, details.uploadData)
    const key = `session-network\u0000${details.id}`
    await this.recorder.recordRequest({
      requestId: key,
      method: details.method,
      url: details.url,
      body,
      source: 'session-network',
      resourceType: details.resourceType,
      hasWebContents: typeof details.webContentsId === 'number'
    })

    const summary = summarizeBody(body)
    const rule = matchWorkRequest({ method: details.method, url: details.url, summary })
    if (!rule) return
    const operationHash = extractOperationHash(rule, body, summary)
    if (!operationHash) return
    const pending: PendingOperation = {
      operationHash,
      requestId: hashIdentifier(key),
      createdAt: new Date().toISOString(),
      windowKind: this.windowKind
    }
    const state = await this.store.update((current) => recordPending(current, pending))
    if (state.pendingOperations.some((operation) => operation.operationHash === operationHash)) {
      this.sessionCandidates.set(details.id, { operationHash, rule })
      if (rule.acceptanceMode === 'stream-status') {
        this.rememberStreamStatusCandidate(operationHash)
      }
    }
    this.onChange()
  }

  private async onSessionCompleted(
    details: Electron.OnCompletedListenerDetails
  ): Promise<void> {
    const key = `session-network\u0000${details.id}`
    await this.recorder.recordResponse({
      requestId: key,
      url: details.url,
      status: details.statusCode,
      source: 'session-network'
    })
    const conversationId = workStreamStatusConversationId(
      details.method,
      details.url,
      details.statusCode
    )
    if (conversationId) {
      this.rememberStreamStatusSuccess(conversationId)
      if (pageMatchesConversation(this.webContents.getURL(), conversationId)) {
        this.streamStatusSuccesses.delete(conversationId)
        await this.acceptStreamStatusCandidates()
      }
    }
    const candidate = this.sessionCandidates.get(details.id)
    if (candidate) {
      if (details.statusCode >= 400) {
        await this.store.update((state) => rejectPending(state, candidate.operationHash))
        this.streamStatusCandidates.delete(candidate.operationHash)
      }
      this.onChange()
    }
    this.sessionCandidates.delete(details.id)
  }

  private async onSessionError(
    details: Electron.OnErrorOccurredListenerDetails
  ): Promise<void> {
    const key = `session-network\u0000${details.id}`
    await this.recorder.recordResponse({
      requestId: key,
      url: details.url,
      status: 0,
      source: 'session-network'
    })
    // A transport error is ambiguous. Keep the encrypted pending operation, but
    // require a new local retry before accepting a later stream-status response.
    const candidate = this.sessionCandidates.get(details.id)
    if (candidate) this.streamStatusCandidates.delete(candidate.operationHash)
    this.sessionCandidates.delete(details.id)
    this.onChange()
  }

  private rememberStreamStatusCandidate(operationHash: string, now = Date.now()): void {
    this.streamStatusCandidates.set(operationHash, now)
    for (const [hash, observedAt] of this.streamStatusCandidates) {
      if (now - observedAt > WORK_STREAM_STATUS_WINDOW_MS) {
        this.streamStatusCandidates.delete(hash)
      }
    }
  }

  private rememberStreamStatusSuccess(conversationId: string, now = Date.now()): void {
    this.streamStatusSuccesses.set(conversationId, now)
    this.pruneStreamStatusSuccesses(now)
  }

  private hasRecentStreamStatusSuccess(conversationId: string, now = Date.now()): boolean {
    this.pruneStreamStatusSuccesses(now)
    return this.streamStatusSuccesses.has(conversationId)
  }

  private pruneStreamStatusSuccesses(now: number): void {
    for (const [conversationId, observedAt] of this.streamStatusSuccesses) {
      if (now - observedAt > WORK_STREAM_STATUS_WINDOW_MS) {
        this.streamStatusSuccesses.delete(conversationId)
      }
    }
  }

  private async acceptStreamStatusCandidates(now = new Date()): Promise<void> {
    const cutoff = now.getTime() - WORK_STREAM_STATUS_WINDOW_MS
    const accepted = [...this.streamStatusCandidates.entries()]
      .filter(([, observedAt]) => observedAt >= cutoff)
      .map(([operationHash]) => operationHash)
    this.streamStatusCandidates.clear()
    // A generic stream-status success does not identify which local operation it
    // belongs to. Only promote it when there is exactly one eligible submission;
    // otherwise keep every operation pending instead of guessing and triggering
    // the destructive safety flow from ambiguous evidence.
    if (accepted.length !== 1) return
    await this.acceptOperations(accepted, now)
    this.onChange()
  }

  private async acceptOperations(operationHashes: string[], acceptedAt: Date): Promise<void> {
    let fresh: string[] = []
    await this.store.update((state) => {
      fresh = operationHashes.filter(
        (operationHash) => !state.recentOperationHashes.includes(operationHash)
      )
      const acceptedState = operationHashes.reduce(
        (current, operationHash) => recordAccepted(current, operationHash, acceptedAt),
        state
      )
      return fresh.reduce(
        (current, operationHash) =>
          this.prepareAcceptedState?.(current, { operationHash, acceptedAt }) ?? current,
        acceptedState
      )
    })
    for (const operationHash of fresh) {
      await this.onAccepted?.({ operationHash, acceptedAt })
    }
  }
}

function requestKey(requestId: string, sessionId?: string): string {
  return `${sessionId ?? ROOT_SESSION}\u0000${requestId}`
}

function isObservedTargetUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return (
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com') ||
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com')
    )
  } catch {
    return false
  }
}

function workStreamStatusConversationId(
  method: string | undefined,
  url: string,
  status: number | undefined
): string | null {
  if (method?.toUpperCase() !== 'GET' || status !== 200) return null
  try {
    const streamMatch = new URL(url).pathname.match(
      /^\/backend-api\/conversation\/([^/]+)\/stream_status\/?$/u
    )
    return streamMatch?.[1] ?? null
  } catch {
    return null
  }
}

function conversationIdFromPageUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const pageMatch = new URL(value).pathname.match(/(?:^|\/)c\/([^/]+)\/?$/u)
    return pageMatch?.[1] ?? null
  } catch {
    return null
  }
}

function pageMatchesConversation(value: string | undefined, conversationId: string): boolean {
  return conversationIdFromPageUrl(value) === conversationId
}

async function readUploadBody(
  remoteSession: Session | undefined,
  uploadData: Electron.UploadData[] | undefined
): Promise<string | undefined> {
  if (!uploadData?.length) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for (const part of uploadData) {
    let chunk = part.bytes
    if ((!chunk || chunk.length === 0) && part.blobUUID && remoteSession) {
      try {
        chunk = await remoteSession.getBlobData(part.blobUUID)
      } catch {
        continue
      }
    }
    if (!chunk?.length) continue
    const remaining = MAX_UPLOAD_BODY_BYTES - size
    if (remaining <= 0) break
    chunks.push(chunk.subarray(0, remaining))
    size += Math.min(chunk.length, remaining)
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
}
