import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CalibrationRecorder,
  hashIdentifier,
  stripSensitiveUrl,
  summarizeBody
} from '../src/main/calibration-recorder'

describe('calibration redaction', () => {
  it('keeps structure but excludes message text and raw identifiers', () => {
    const body = JSON.stringify({
      mode: 'work',
      message: { id: 'message-secret-id', content: 'private conversation text' },
      metadata: { task_type: 'coding' }
    })
    const summary = summarizeBody(body)
    const serialized = JSON.stringify(summary)

    expect(summary.keyPaths).toContain('message.content')
    expect(summary.semanticValues.mode).toEqual(['work'])
    expect(summary.identifierHashes).toContain(hashIdentifier('message-secret-id'))
    expect(serialized).not.toContain('private conversation text')
    expect(serialized).not.toContain('message-secret-id')
    expect(serialized).not.toContain(hashIdentifier(body))
  })

  it('understands JSON data events without saving their raw data', () => {
    const body = 'event: message\ndata: {"type":"accepted","task_id":"abc-123","content":"secret"}\n\ndata: [DONE]\n'
    const summary = summarizeBody(body)
    expect(summary.format).toBe('event-stream')
    expect(summary.semanticValues.type).toEqual(['accepted'])
    expect(summary.identifierHashes).toContain(hashIdentifier('abc-123'))
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('does not retain unstructured text', () => {
    const summary = summarizeBody('plain private text')
    expect(summary.format).toBe('text')
    expect(summary.keyPaths).toEqual([])
    expect(JSON.stringify(summary)).not.toContain('plain private text')
  })

  it('drops natural-language semantic values while retaining safe category tokens', () => {
    const summary = summarizeBody(
      JSON.stringify({ mode: 'work', action: 'summarize my private document' })
    )
    expect(summary.semanticValues.mode).toEqual(['work'])
    expect(summary.semanticValues.action).toBeUndefined()
    expect(JSON.stringify(summary)).not.toContain('summarize my private document')
  })

  it('retains only safe preparation state tokens needed for anonymous calibration', () => {
    const summary = summarizeBody(
      JSON.stringify({
        client_prepare_dispatch: true,
        client_prepare_source: 'composer',
        client_prepare_state: 'ready',
        conversation_origin: 'work',
        partial_query: { author: { role: 'user' }, content: ['private prompt'] }
      })
    )
    expect(summary.semanticValues).toMatchObject({
      client_prepare_dispatch: ['true'],
      client_prepare_source: ['composer'],
      client_prepare_state: ['ready'],
      conversation_origin: ['work'],
      'partial_query.author.role': ['user']
    })
    expect(JSON.stringify(summary)).not.toContain('private prompt')
  })

  it('removes query strings and dynamic identifiers from recorded paths', () => {
    expect(
      stripSensitiveUrl(
        'https://chatgpt.com/backend-api/conversation/123e4567-e89b-12d3-a456-426614174000?token=secret'
      )
    ).toBe('https://chatgpt.com/backend-api/conversation/:id')
  })

  it('redacts long encoded path tokens including base64 padding', () => {
    expect(
      stripSensitiveUrl(
        'https://chatgpt.com/backend-api/estuary/public_content/enc/eyJpZCI6InVzZXItc2VjcmV0Iiwic2lnIjoic2VjcmV0In0=?download=1'
      )
    ).toBe('https://chatgpt.com/backend-api/estuary/public_content/enc/:id')
  })

  it('records target diagnostics without retaining private paths or raw ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatgpt-next-calibration-'))
    try {
      const recorder = new CalibrationRecorder(directory)
      await recorder.setEnabled(true)
      await recorder.recordTarget({
        event: 'attached',
        targetId: 'raw-private-target-id',
        targetType: 'service_worker',
        url: 'https://chatgpt.com/private/conversation/id?token=secret'
      })
      const path = recorder.getLogPath()
      expect(path).not.toBeNull()
      const log = await readFile(path!, 'utf8')
      expect(log).toContain('https://chatgpt.com')
      expect(log).toContain(hashIdentifier('raw-private-target-id'))
      expect(log).not.toContain('/private/conversation')
      expect(log).not.toContain('raw-private-target-id')
      expect(log).not.toContain('token=secret')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
