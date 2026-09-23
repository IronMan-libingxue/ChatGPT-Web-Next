import { describe, expect, it } from 'vitest'
import {
  analyzeConversationPost,
  decodeRequestBody,
  isConversationSubmission,
  streamStatusConversationId
} from '../chrome-work-pilot/src/detection'

function workBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'next',
    client_prepare_state: 'sent',
    conversation_mode: { kind: 'primary_assistant' },
    conversation_origin: 'tpp',
    model: 'gpt-5.6-sol-wm',
    conversation_id: 'conversation-secret',
    messages: [
      {
        id: 'operation-secret',
        author: { role: 'user' },
        content: { parts: ['正文不能进入验证状态'] }
      }
    ],
    ...overrides
  })
}

describe('Chrome Work pilot request detection', () => {
  it('matches the calibrated Work submission and returns only safe signals plus IDs', () => {
    const result = analyzeConversationPost(workBody())

    expect(result).toEqual({
      kind: 'matched-work',
      operationId: 'operation-secret',
      conversationId: 'conversation-secret',
      signals: {
        action: 'next',
        clientPrepareState: 'sent',
        conversationMode: 'primary_assistant',
        conversationOrigin: 'tpp',
        model: 'gpt-5.6-sol-wm',
        authorRole: 'user'
      }
    })
    expect(JSON.stringify(result)).not.toContain('正文不能进入验证状态')
  })

  it('ignores an ordinary chat submission', () => {
    const result = analyzeConversationPost(
      workBody({ conversation_origin: 'chat', model: 'gpt-5.6-sol' })
    )
    expect(result.kind).toBe('not-work')
  })

  it('stops for review when Work shape uses an uncalibrated model', () => {
    const result = analyzeConversationPost(workBody({ model: 'future-work-model' }))
    expect(result.kind).toBe('work-like-unmatched')
  })

  it('only observes the calibrated conversation submission URL', () => {
    expect(
      isConversationSubmission('POST', 'https://chatgpt.com/backend-api/f/conversation')
    ).toBe(true)
    expect(
      isConversationSubmission('POST', 'https://chatgpt.com/backend-api/f/conversation/prepare')
    ).toBe(false)
    expect(
      isConversationSubmission('GET', 'https://chatgpt.com/backend-api/f/conversation')
    ).toBe(false)
  })

  it('extracts the later server acceptance conversation ID', () => {
    expect(
      streamStatusConversationId(
        'GET',
        'https://chatgpt.com/backend-api/conversation/conversation%2Dsecret/stream_status'
      )
    ).toBe('conversation-secret')
    expect(
      streamStatusConversationId('GET', 'https://chatgpt.com/backend-api/conversations')
    ).toBeNull()
  })

  it('decodes a Chrome raw request body without retaining extra buffers', () => {
    const encoded = new TextEncoder().encode(workBody())
    const bytes = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    ) as ArrayBuffer
    const decoded = decodeRequestBody({ raw: [{ bytes }] })
    expect(analyzeConversationPost(decoded).kind).toBe('matched-work')
  })
})
