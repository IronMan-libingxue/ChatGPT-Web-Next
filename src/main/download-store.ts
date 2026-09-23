import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadRecord, DownloadsSnapshot } from '../shared/types'
import { DOWNLOAD_RECORD_MAX_AGE_MS } from '../shared/types'
import { EncryptedJsonStore } from './encrypted-json-store'

interface PersistedDownloads {
  schemaVersion: 1
  records: DownloadRecord[]
}

export interface NewDownloadRecord {
  fileName: string
  savePath: string
  totalBytes: number | null
  windowKind: 'normal' | 'incognito'
}

export class DownloadStore {
  private readonly store: EncryptedJsonStore<PersistedDownloads>

  constructor(appDataPath: string, testEncryptionSecret?: string) {
    this.store = new EncryptedJsonStore(
      join(appDataPath, 'ChatGPT Web Next Device', 'downloads.bin'),
      () => ({ schemaVersion: 1, records: [] }),
      isPersistedDownloads,
      testEncryptionSecret
    )
  }

  async initialize(now = new Date()): Promise<void> {
    await this.store.initialize()
    await this.store.update((current) => ({
      ...current,
      records: pruneDownloadRecords(
        current.records.map((record) =>
          record.status === 'progressing'
            ? {
                ...record,
                status: 'interrupted' as const,
                updatedAt: now.toISOString(),
                completedAt: now.toISOString(),
                error: 'APP 退出时下载尚未完成'
              }
            : record
        ),
        now
      )
    }))
  }

  getSnapshot(now = new Date()): DownloadsSnapshot {
    const all = pruneDownloadRecords(this.store.get().records, now)
    return { recent: all.slice(0, 10), all, totalCount: all.length }
  }

  async add(input: NewDownloadRecord, now = new Date()): Promise<DownloadRecord> {
    const record: DownloadRecord = {
      id: randomUUID(),
      fileName: input.fileName,
      savePath: input.savePath,
      receivedBytes: 0,
      totalBytes: input.totalBytes,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      status: 'progressing',
      windowKind: input.windowKind,
      error: null
    }
    await this.store.update((current) => ({
      ...current,
      records: pruneDownloadRecords([record, ...current.records], now)
    }))
    return record
  }

  async update(id: string, patch: Partial<DownloadRecord>, now = new Date()): Promise<void> {
    await this.store.update((current) => ({
      ...current,
      records: pruneDownloadRecords(
        current.records.map((record) =>
          record.id === id
            ? { ...record, ...patch, id: record.id, updatedAt: now.toISOString() }
            : record
        ),
        now
      )
    }))
  }

  async clearFinished(): Promise<void> {
    await this.store.update((current) => ({
      ...current,
      records: current.records.filter((record) => record.status === 'progressing')
    }))
  }

  async pathForId(id: string): Promise<string | null> {
    const record = this.store.get().records.find((candidate) => candidate.id === id)
    if (!record) return null
    try {
      await access(record.savePath)
      return record.savePath
    } catch {
      return null
    }
  }

  getPath(): string {
    return this.store.getPath()
  }
}

export function pruneDownloadRecords(
  records: DownloadRecord[],
  now = new Date()
): DownloadRecord[] {
  const cutoff = now.getTime() - DOWNLOAD_RECORD_MAX_AGE_MS
  return records
    .filter((record) => Date.parse(record.startedAt) >= cutoff)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 50)
}

function isPersistedDownloads(value: unknown): value is PersistedDownloads {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedDownloads>
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.records) &&
    candidate.records.every(isDownloadRecord)
  )
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.fileName === 'string' &&
    typeof record.savePath === 'string' &&
    typeof record.receivedBytes === 'number' &&
    (record.totalBytes === null || typeof record.totalBytes === 'number') &&
    typeof record.startedAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.completedAt === null || typeof record.completedAt === 'string') &&
    ['progressing', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
      String(record.status)
    ) &&
    (record.windowKind === 'normal' || record.windowKind === 'incognito') &&
    (record.error === null || typeof record.error === 'string')
  )
}
