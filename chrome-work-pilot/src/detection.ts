export const CHROME_WORK_RULE_VERSION = '2026-09-11.chrome-stream-status.v1'
export const ACCEPTANCE_WINDOW_MS = 90_000
export const PENDING_RETENTION_MS = 10 * 60_000

const KNOWN_WORK_MODELS = new Set(['gpt-5.6-sol-wm'])

export interface SafeWorkSignals {
  action?: string
  clientPrepareState?: string
  conversationMode?: string
  conversationOrigin?: string
  model?: string
  authorRole?: string
}

export type ConversationPostAnalysis =
  | {
      kind: 'matched-work'
      operationId: string
      conversationId: string | null
      signals: SafeWorkSignals
    }
  | {
      kind: 'work-like-unmatched'
      reason: string
      signals: SafeWorkSignals
    }
  | {
      kind: 'not-work'
      signals: SafeWorkSignals
    }
  | {
      kind: 'unreadable'
      reason: string
      signals: SafeWorkSignals
    }

interface ConversationBody {
  action?: unknown
  client_prepare_state?: unknown
  conversation_id?: unknown
  conversation_mode?: { kind?: unknown }
  conversation_origin?: unknown
  model?: unknown
  messages?: Array<{
    id?: unknown
    author?: { role?: unknown }
  }>
}

export interface ObservedRequestBody {
  error?: string
  formData?: Record<string, unknown[]>
  raw?: Array<{ bytes?: ArrayBuffer }>
}

export function isConversationSubmission(method: string, rawUrl: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  try {
    return /^\/backend-api\/f\/conversation\/?$/u.test(new URL(rawUrl).pathname)
  } catch {
    return false
  }
}

export function streamStatusConversationId(
  method: string,
  rawUrl: string
): string | null {
  if (method.toUpperCase() !== 'GET') return null
  try {
    const match = new URL(rawUrl).pathname.match(
      /^\/backend-api\/conversation\/([^/]+)\/stream_status\/?$/u
    )
    return match?.[1] ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

export function analyzeConversationPost(bodyText: string | undefined): ConversationPostAnalysis {
  if (!bodyText) {
    return {
      kind: 'unreadable',
      reason: '请求内容不可读取',
      signals: {}
    }
  }

  let body: ConversationBody
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        kind: 'unreadable',
        reason: '请求内容不是对象',
        signals: {}
      }
    }
    body = parsed as ConversationBody
  } catch {
    return {
      kind: 'unreadable',
      reason: '请求内容不是可识别的 JSON',
      signals: {}
    }
  }

  const userMessage = body.messages?.find(
    (message) => safeString(message.author?.role) === 'user'
  )
  const signals: SafeWorkSignals = {
    action: safeString(body.action),
    clientPrepareState: safeString(body.client_prepare_state),
    conversationMode: safeString(body.conversation_mode?.kind),
    conversationOrigin: safeString(body.conversation_origin),
    model: safeString(body.model),
    authorRole: safeString(userMessage?.author?.role)
  }

  const hasWorkShape =
    signals.action === 'next' &&
    signals.clientPrepareState === 'sent' &&
    signals.conversationMode === 'primary_assistant' &&
    signals.conversationOrigin === 'tpp' &&
    signals.authorRole === 'user'

  if (!hasWorkShape) return { kind: 'not-work', signals }

  if (!signals.model || !KNOWN_WORK_MODELS.has(signals.model)) {
    return {
      kind: 'work-like-unmatched',
      reason: `发现尚未校准的 Work 模型：${signals.model ?? '未知'}`,
      signals
    }
  }

  const operationId = safeString(userMessage?.id)
  if (!operationId) {
    return {
      kind: 'work-like-unmatched',
      reason: 'Work 请求缺少可匿名化的操作标识',
      signals
    }
  }

  return {
    kind: 'matched-work',
    operationId,
    conversationId: safeString(body.conversation_id) ?? null,
    signals
  }
}

export function decodeRequestBody(
  requestBody: ObservedRequestBody | undefined,
  maxBytes = 1024 * 1024
): string | undefined {
  if (!requestBody || requestBody.error) return undefined
  if (requestBody.formData) return JSON.stringify(requestBody.formData)
  if (!requestBody.raw?.length) return undefined

  const chunks: Uint8Array[] = []
  let total = 0
  for (const part of requestBody.raw) {
    if (!part.bytes || total >= maxBytes) continue
    const bytes = new Uint8Array(part.bytes)
    const remaining = maxBytes - total
    const chunk = bytes.subarray(0, remaining)
    chunks.push(chunk)
    total += chunk.byteLength
  }
  if (chunks.length === 0) return undefined

  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(combined)
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
