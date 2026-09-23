import { hashIdentifier, type StructuralSummary } from './calibration-recorder'

export type WorkAcceptanceMode = 'stream-status'

export interface WorkDetectionRule {
  id: string
  method: string
  pathPattern: RegExp
  acceptanceMode: WorkAcceptanceMode
  operationIdPath: 'messages[].id' | 'parent_message_id'
  requiredRequestKeys: string[]
  requestSemanticValues: Record<string, string[]>
  workOrigins: string[]
  workModelSuffixes: string[]
  requiredResponseKeys: string[]
  responseSemanticValues: Record<string, string[]>
}

export interface DetectionEvent {
  method: string
  url: string
  summary: StructuralSummary
}

// Validated against a normal chat, a new Work task, a Work follow-up, a
// history-only visit, an offline draft, a real online submit and a real Work
// submission inside a personal project on 2026-09-09/10/13.
// Draft preparation is ignored. A submitted Work message is confirmed by its
// stream handoff or a successful stream-status check for the created conversation.
export const WORK_RULE_VERSION = '2026-09-13.work-project-stream-status.v8'
export const WORK_RULES: WorkDetectionRule[] = [
  {
    id: 'chatgpt-work-project-stream-status-v8',
    method: 'POST',
    pathPattern: /^\/backend-api\/f\/conversation\/?$/u,
    acceptanceMode: 'stream-status',
    operationIdPath: 'messages[].id',
    requiredRequestKeys: [
      'action',
      'client_prepare_state',
      'conversation_mode.kind',
      'messages[].author.role',
      'messages[].id'
    ],
    requestSemanticValues: {
      action: ['next'],
      client_prepare_state: ['sent', 'success'],
      'conversation_mode.kind': ['primary_assistant', 'gizmo_interaction'],
      'messages[].author.role': ['user']
    },
    workOrigins: ['tpp', 'work'],
    workModelSuffixes: ['-wm'],
    requiredResponseKeys: ['type', 'options', 'options[].type'],
    responseSemanticValues: {
      type: ['stream_handoff'],
      'options[].type': ['resume_sse_endpoint', 'subscribe_ws_topic']
    }
  }
]

export function isPotentialWorkRequest(method: string, url: string): boolean {
  const path = safePathname(url)
  return WORK_RULES.some(
    (rule) => rule.method === method.toUpperCase() && rule.pathPattern.test(path)
  )
}

export function matchWorkRequest(event: DetectionEvent): WorkDetectionRule | null {
  return (
    WORK_RULES.find((rule) => {
      const path = safePathname(event.url)
      return (
        rule.method === event.method.toUpperCase() &&
        rule.pathPattern.test(path) &&
        includesKeys(event.summary, rule.requiredRequestKeys) &&
        includesSemanticValues(event.summary, rule.requestSemanticValues) &&
        includesWorkIdentity(event.summary, rule)
      )
    }) ?? null
  )
}

function includesWorkIdentity(
  summary: StructuralSummary,
  rule: Pick<WorkDetectionRule, 'workOrigins' | 'workModelSuffixes'>
): boolean {
  const origins = summary.semanticValues.conversation_origin ?? []
  const models = summary.semanticValues.model ?? []
  const modes = summary.semanticValues['conversation_mode.kind'] ?? []
  const modelMatches = models.some((model) =>
    rule.workModelSuffixes.some((suffix) => model.endsWith(suffix))
  )
  // Personal-project traffic uses the same tpp origin for both ordinary and
  // Work conversations. In that mode the calibrated -wm model marker is the
  // discriminator; accepting the origin alone would falsely classify an
  // ordinary project chat as Work.
  if (modes.includes('gizmo_interaction')) return modelMatches
  return origins.some((origin) => rule.workOrigins.includes(origin)) || modelMatches
}

export function matchesAcceptance(
  rule: WorkDetectionRule,
  summary: StructuralSummary
): boolean {
  return (
    includesKeys(summary, rule.requiredResponseKeys) &&
    includesSemanticValues(summary, rule.responseSemanticValues)
  )
}

export function extractOperationHash(
  rule: WorkDetectionRule,
  body: string | undefined,
  summary: StructuralSummary
): string | null {
  const identifier = readOperationIdentifier(rule.operationIdPath, body)
  if (identifier) return hashIdentifier(identifier)
  return summary.identifierHashes[0] ?? null
}

function includesKeys(summary: StructuralSummary, keys: string[]): boolean {
  return keys.every((key) => summary.keyPaths.includes(key))
}

function includesSemanticValues(
  summary: StructuralSummary,
  expected: Record<string, string[]>
): boolean {
  return Object.entries(expected).every(([path, values]) => {
    const actual = summary.semanticValues[path] ?? []
    return values.some((value) => actual.includes(value))
  })
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return ''
  }
}

function readOperationIdentifier(
  path: WorkDetectionRule['operationIdPath'],
  body?: string
): string | null {
  if (!body) return null
  try {
    const value = JSON.parse(body) as {
      messages?: Array<{ id?: unknown }>
      parent_message_id?: unknown
    }
    if (path === 'parent_message_id') {
      return typeof value.parent_message_id === 'string' ? value.parent_message_id : null
    }
    const messageId = value.messages?.find((message) => typeof message.id === 'string')?.id
    return typeof messageId === 'string' ? messageId : null
  } catch {
    return null
  }
}
