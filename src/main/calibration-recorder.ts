import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_DEPTH = 7
const MAX_KEYS = 240
const SEMANTIC_KEYS = new Set([
  'action',
  'client_prepare_dispatch',
  'client_prepare_source',
  'client_prepare_state',
  'conversation_origin',
  'event',
  'kind',
  'mode',
  'model',
  'operation',
  'role',
  'status',
  'task_type',
  'type'
])
const IDENTIFIER_KEY = /(?:^|_)(?:conversation|event|message|operation|request|task)?_?id$/iu

export interface StructuralSummary {
  keyPaths: string[]
  semanticValues: Record<string, string[]>
  identifierHashes: string[]
  format: 'json' | 'event-stream' | 'text' | 'empty'
}

interface CalibrationRecord {
  timestamp: string
  direction: 'request' | 'response' | 'websocket-sent' | 'websocket-received' | 'system'
  source?: 'debugger' | 'session-network' | 'target-observer'
  requestId?: string
  method?: string
  url?: string
  status?: number
  resourceType?: string
  hasWebContents?: boolean
  targetEvent?: CalibrationTargetEvent
  targetType?: string
  targetOrigin?: string
  targetId?: string
  summary?: StructuralSummary
  note?: string
}

export type CalibrationTargetEvent =
  | 'observation-ready'
  | 'observation-fallback'
  | 'attached'
  | 'changed'
  | 'network-enabled'
  | 'network-enable-failed'
  | 'detached'

export class CalibrationRecorder {
  private enabled = false
  private readonly logPath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(logsPath: string) {
    const day = new Date().toISOString().slice(0, 10)
    this.logPath = join(logsPath, `work-calibration-${day}.jsonl`)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getLogPath(): string | null {
    return this.enabled ? this.logPath : null
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (enabled) {
      await this.record({
        timestamp: new Date().toISOString(),
        direction: 'system',
        note: 'Calibration started. Headers, cookies, query strings and raw bodies are excluded.'
      })
    }
  }

  async recordRequest(input: {
    requestId: string
    method: string
    url: string
    body?: string
    source?: 'debugger' | 'session-network'
    resourceType?: string
    hasWebContents?: boolean
  }): Promise<void> {
    if (!this.enabled || !isObservedHost(input.url)) return
    await this.record({
      timestamp: new Date().toISOString(),
      direction: 'request',
      requestId: hashIdentifier(input.requestId),
      method: input.method,
      url: stripSensitiveUrl(input.url),
      source: input.source,
      resourceType: safeToken(input.resourceType),
      hasWebContents: input.hasWebContents,
      summary: summarizeBody(input.body)
    })
  }

  async recordResponse(input: {
    requestId: string
    url: string
    status: number
    body?: string
    source?: 'debugger' | 'session-network'
  }): Promise<void> {
    if (!this.enabled || !isObservedHost(input.url)) return
    await this.record({
      timestamp: new Date().toISOString(),
      direction: 'response',
      requestId: hashIdentifier(input.requestId),
      url: stripSensitiveUrl(input.url),
      status: input.status,
      source: input.source,
      summary: summarizeBody(input.body)
    })
  }

  async recordWebSocket(
    direction: 'websocket-sent' | 'websocket-received',
    requestId: string,
    url: string,
    payload: string
  ): Promise<void> {
    if (!this.enabled || !isObservedHost(url)) return
    await this.record({
      timestamp: new Date().toISOString(),
      direction,
      requestId: hashIdentifier(requestId),
      url: stripSensitiveUrl(url),
      summary: summarizeBody(payload)
    })
  }

  async recordTarget(input: {
    event: CalibrationTargetEvent
    targetId?: string
    targetType?: string
    url?: string
  }): Promise<void> {
    if (!this.enabled) return
    await this.record({
      timestamp: new Date().toISOString(),
      direction: 'system',
      source: 'target-observer',
      targetEvent: input.event,
      targetType: safeToken(input.targetType),
      targetOrigin: safeObservedOrigin(input.url),
      targetId: input.targetId ? hashIdentifier(input.targetId) : undefined
    })
  }

  private async record(record: CalibrationRecord): Promise<void> {
    if (!this.enabled) return
    const line = `${JSON.stringify(record)}\n`
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.logPath), { recursive: true, mode: 0o700 })
      await appendFile(this.logPath, line, { encoding: 'utf8', mode: 0o600 })
    })
    await this.writeQueue
  }
}

export function summarizeBody(body?: string): StructuralSummary {
  if (!body) {
    return {
      keyPaths: [],
      semanticValues: {},
      identifierHashes: [],
      format: 'empty'
    }
  }

  const result: StructuralSummary = {
    keyPaths: [],
    semanticValues: {},
    identifierHashes: [],
    format: 'text'
  }

  const jsonValues = parseStructuredValues(body)
  if (jsonValues.length === 0) return result
  result.format = body.includes('\ndata:') || body.startsWith('data:') ? 'event-stream' : 'json'

  for (const value of jsonValues) {
    walk(value, '', 0, result)
  }
  result.keyPaths = [...new Set(result.keyPaths)].sort().slice(0, MAX_KEYS)
  result.identifierHashes = [...new Set(result.identifierHashes)].slice(0, 64)
  return result
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseStructuredValues(body: string): unknown[] {
  try {
    return [JSON.parse(body) as unknown]
  } catch {
    const values: unknown[] = []
    for (const line of body.split(/\r?\n/u)) {
      const trimmed = line.startsWith('data:') ? line.slice(5).trim() : ''
      if (!trimmed || trimmed === '[DONE]') continue
      try {
        values.push(JSON.parse(trimmed) as unknown)
      } catch {
        // Non-JSON event-stream chunks are intentionally ignored.
      }
    }
    return values
  }
}

function walk(value: unknown, path: string, depth: number, result: StructuralSummary): void {
  if (depth > MAX_DEPTH || result.keyPaths.length >= MAX_KEYS) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) walk(item, `${path}[]`, depth + 1, result)
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    result.keyPaths.push(childPath)
    if (SEMANTIC_KEYS.has(key.toLowerCase()) && isSafeSemanticScalar(child)) {
      const normalized = String(child).slice(0, 96)
      result.semanticValues[childPath] = [
        ...new Set([...(result.semanticValues[childPath] ?? []), normalized])
      ]
    }
    if (IDENTIFIER_KEY.test(key) && typeof child === 'string') {
      result.identifierHashes.push(hashIdentifier(child))
    }
    walk(child, childPath, depth + 1, result)
  }
}

function isSafeSemanticScalar(value: unknown): value is string | number | boolean {
  return (
    (typeof value === 'string' && /^[a-z0-9_.:/-]{1,48}$/iu.test(value)) ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function safeToken(value?: string): string | undefined {
  return value && /^[a-z0-9_-]{1,48}$/iu.test(value) ? value : undefined
}

function safeObservedOrigin(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return isObservedHost(value) ? url.origin : 'other'
  } catch {
    return value === 'about:blank' ? 'about:blank' : 'other'
  }
}

export function stripSensitiveUrl(value: string): string {
  try {
    const url = new URL(value)
    const pathname = url.pathname
      .split('/')
      .map((segment) => (isDynamicPathSegment(segment) ? ':id' : segment))
      .join('/')
    return `${url.origin}${pathname}`
  } catch {
    return 'invalid-url'
  }
}

function isDynamicPathSegment(segment: string): boolean {
  return (
    /^\d+$/u.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment) ||
    /^[a-z0-9._~+=-]{20,}$/iu.test(segment) ||
    segment.includes('%')
  )
}

function isObservedHost(value: string): boolean {
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
