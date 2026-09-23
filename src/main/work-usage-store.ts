import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkUsageRecord } from '../shared/types'
import { WORK_RECORD_MAX_AGE_MS } from '../shared/types'
import { EncryptedJsonStore } from './encrypted-json-store'

interface PersistedWorkUsage {
  schemaVersion: 1
  records: WorkUsageRecord[]
}

export interface WorkUsageMetadata {
  accountName: string
  projectName: string
  chatName: string
}

export class WorkUsageStore {
  private readonly store: EncryptedJsonStore<PersistedWorkUsage>

  constructor(appDataPath: string, testEncryptionSecret?: string) {
    this.store = new EncryptedJsonStore(
      join(appDataPath, 'ChatGPT Web Next Device', 'work-usage.bin'),
      () => ({ schemaVersion: 1, records: [] }),
      isPersistedWorkUsage,
      testEncryptionSecret
    )
  }

  async initialize(now = new Date()): Promise<void> {
    await this.store.initialize()
    await this.prune(now)
  }

  getRecords(now = new Date()): WorkUsageRecord[] {
    return pruneRecords(this.store.get().records, now)
  }

  async add(
    operationHash: string,
    metadata: WorkUsageMetadata,
    triggeredAt = new Date()
  ): Promise<{ added: boolean; record: WorkUsageRecord | null }> {
    let addedRecord: WorkUsageRecord | null = null
    await this.store.update((current) => {
      const records = pruneRecords(current.records, triggeredAt)
      if (records.some((record) => record.operationHash === operationHash)) {
        return { ...current, records }
      }
      addedRecord = {
        id: randomUUID(),
        operationHash,
        accountName: cleanLabel(metadata.accountName, '未识别账号'),
        projectName: cleanLabel(metadata.projectName, '未归入项目'),
        chatName: cleanLabel(metadata.chatName, '未命名对话'),
        triggeredAt: triggeredAt.toISOString()
      }
      return { ...current, records: [addedRecord, ...records].slice(0, 10) }
    })
    return { added: addedRecord !== null, record: addedRecord }
  }

  async updateMetadata(operationHash: string, metadata: WorkUsageMetadata): Promise<void> {
    await this.store.update((current) => ({
      ...current,
      records: current.records.map((record) =>
        record.operationHash === operationHash
          ? {
              ...record,
              accountName: preferResolved(metadata.accountName, record.accountName, '未识别账号'),
              projectName: preferResolved(metadata.projectName, record.projectName, '未归入项目'),
              chatName: preferResolved(metadata.chatName, record.chatName, '未命名对话')
            }
          : record
      )
    }))
  }

  async prune(now = new Date()): Promise<void> {
    await this.store.update((current) => ({
      ...current,
      records: pruneRecords(current.records, now)
    }))
  }

  getPath(): string {
    return this.store.getPath()
  }
}

export function pruneRecords(records: WorkUsageRecord[], now = new Date()): WorkUsageRecord[] {
  const cutoff = now.getTime() - WORK_RECORD_MAX_AGE_MS
  return records
    .filter((record) => Date.parse(record.triggeredAt) >= cutoff)
    .sort((left, right) => Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt))
    .slice(0, 10)
}

function cleanLabel(value: string, fallback: string): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim().slice(0, 160)
  return normalized || fallback
}

function preferResolved(value: string, current: string, fallback: string): string {
  const candidate = cleanLabel(value, fallback)
  return candidate === fallback && current !== fallback ? current : candidate
}

function isPersistedWorkUsage(value: unknown): value is PersistedWorkUsage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedWorkUsage>
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.records) &&
    candidate.records.every(isWorkUsageRecord)
  )
}

function isWorkUsageRecord(value: unknown): value is WorkUsageRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.operationHash === 'string' &&
    typeof record.accountName === 'string' &&
    typeof record.projectName === 'string' &&
    typeof record.chatName === 'string' &&
    typeof record.triggeredAt === 'string'
  )
}
