import { describe, expect, it } from 'vitest'
import type { StructuralSummary } from '../src/main/calibration-recorder'
import {
  matchWorkRequest,
  matchesAcceptance,
  WORK_RULE_VERSION
} from '../src/main/work-rules'

function summary(input: Partial<StructuralSummary>): StructuralSummary {
  return {
    keyPaths: input.keyPaths ?? [],
    semanticValues: input.semanticValues ?? {},
    identifierHashes: input.identifierHashes ?? [],
    format: input.format ?? 'json'
  }
}

function observedWorkRequestSummary(): StructuralSummary {
  return summary({
    keyPaths: [
      'action',
      'client_prepare_state',
      'conversation_mode.kind',
      'conversation_origin',
      'model',
      'messages[].author.role',
      'messages[].id'
    ],
    semanticValues: {
      action: ['next'],
      client_prepare_state: ['sent'],
      'conversation_mode.kind': ['primary_assistant'],
      conversation_origin: ['tpp'],
      model: ['gpt-5.6-sol-wm'],
      'messages[].author.role': ['user']
    },
    identifierHashes: ['operation-hash']
  })
}

describe('calibrated Work detection rule', () => {
  it('matches the observed Work submission structure', () => {
    const rule = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      summary: observedWorkRequestSummary()
    })

    expect(WORK_RULE_VERSION).toBe('2026-09-13.work-project-stream-status.v8')
    expect(rule?.id).toBe('chatgpt-work-project-stream-status-v8')
  })

  it('matches the anonymously calibrated Work structure inside a personal project', () => {
    const projectWork = observedWorkRequestSummary()
    projectWork.semanticValues.client_prepare_state = ['success']
    projectWork.semanticValues['conversation_mode.kind'] = ['gizmo_interaction']

    expect(
      matchWorkRequest({
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        summary: projectWork
      })
    ).not.toBeNull()
  })

  it('accepts Work protocol variants without depending on one model rollout', () => {
    const changedModel = observedWorkRequestSummary()
    changedModel.semanticValues.model = ['gpt-7-next']
    const changedOrigin = observedWorkRequestSummary()
    changedOrigin.semanticValues.conversation_origin = ['composer']
    changedOrigin.semanticValues.model = ['gpt-6-astra-wm']

    expect(
      matchWorkRequest({
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        summary: changedModel
      })
    ).not.toBeNull()
    expect(
      matchWorkRequest({
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        summary: changedOrigin
      })
    ).not.toBeNull()
  })

  it('does not promote a prepared draft', () => {
    const rule = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
      summary: summary({
        keyPaths: [
          'action',
          'client_prepare_dispatch',
          'conversation_mode.kind',
          'conversation_origin',
          'model',
          'parent_message_id',
          'partial_query.id'
        ],
        semanticValues: {
          action: ['next'],
          model: ['gpt-5.6-sol-wm'],
          'conversation_mode.kind': ['primary_assistant']
        }
      })
    })

    expect(rule).toBeNull()
  })

  it('rejects normal chat and history-only traffic', () => {
    const normalChat = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      summary: summary({
        keyPaths: ['action', 'model', 'messages[].id'],
        semanticValues: {
          action: ['next'],
          model: ['gpt-5-6-thinking']
        },
        identifierHashes: ['normal-message']
      })
    })
    const historyRead = matchWorkRequest({
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/conversations/some-id',
      summary: summary({ format: 'empty' })
    })
    const nonWorkPrepare = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
      summary: summary({
        keyPaths: [
          'action',
          'client_prepare_dispatch',
          'conversation_mode.kind',
          'conversation_origin',
          'model',
          'parent_message_id',
          'partial_query.id'
        ],
        semanticValues: {
          action: ['next'],
          model: ['gpt-5.6-sol'],
          'conversation_mode.kind': ['primary_assistant']
        }
      })
    })
    const normalPrimaryAssistant = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      summary: summary({
        keyPaths: [
          'action',
          'client_prepare_state',
          'conversation_mode.kind',
          'conversation_origin',
          'model',
          'messages[].author.role',
          'messages[].id'
        ],
        semanticValues: {
          action: ['next'],
          client_prepare_state: ['sent'],
          'conversation_mode.kind': ['primary_assistant'],
          conversation_origin: ['composer'],
          model: ['gpt-6-astra'],
          'messages[].author.role': ['user']
        }
      })
    })
    const normalProjectChat = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      summary: summary({
        keyPaths: [
          'action',
          'client_prepare_state',
          'conversation_mode.kind',
          'conversation_origin',
          'model',
          'messages[].author.role',
          'messages[].id'
        ],
        semanticValues: {
          action: ['next'],
          client_prepare_state: ['success'],
          'conversation_mode.kind': ['gizmo_interaction'],
          conversation_origin: ['tpp'],
          model: ['gpt-5.6-sol'],
          'messages[].author.role': ['user']
        }
      })
    })

    expect(normalChat).toBeNull()
    expect(historyRead).toBeNull()
    expect(nonWorkPrepare).toBeNull()
    expect(normalPrimaryAssistant).toBeNull()
    expect(normalProjectChat).toBeNull()
  })

  it('requires the server stream handoff before accepting usage', () => {
    const rule = matchWorkRequest({
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      summary: observedWorkRequestSummary()
    })
    expect(rule).not.toBeNull()
    expect(
      matchesAcceptance(
        rule!,
        summary({
          keyPaths: ['type', 'options', 'options[].type'],
          semanticValues: {
            type: ['stream_handoff'],
            'options[].type': ['resume_sse_endpoint', 'subscribe_ws_topic']
          },
          format: 'event-stream'
        })
      )
    ).toBe(true)
    expect(
      matchesAcceptance(
        rule!,
        summary({
          keyPaths: ['type'],
          semanticValues: { type: ['input_message'] },
          format: 'event-stream'
        })
      )
    ).toBe(false)
  })
})
