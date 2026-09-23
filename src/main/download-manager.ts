import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron'
import { DownloadStore } from './download-store'
import { isChatGptPageUrl } from './native-popup-policy'

interface ActiveDownload {
  id: string
  item: DownloadItem
  savePath: string
}

export class DownloadManager {
  private readonly attachedSessions = new Set<Session>()
  private readonly active = new Map<string, ActiveDownload>()
  private readonly forcedInterruptions = new Set<string>()
  private readonly reservedPaths = new Set<string>()

  constructor(
    private readonly store: DownloadStore,
    private readonly onChange: () => void,
    private readonly testAllowedOrigins = new Set<string>(),
    private readonly testAuthenticationOrigins = new Set<string>()
  ) {}

  attach(remoteSession: Session, windowKind: 'normal' | 'incognito'): void {
    if (this.attachedSessions.has(remoteSession)) return
    this.attachedSessions.add(remoteSession)
    remoteSession.on('will-download', (event, item, webContents) => {
      if (!this.isAllowedDownload(webContents)) {
        event.preventDefault()
        return
      }
      void this.start(item, windowKind).catch((error: unknown) => {
        item.cancel()
        console.error('Download setup failed', error instanceof Error ? error.message : String(error))
      })
    })
  }

  getSnapshot(): ReturnType<DownloadStore['getSnapshot']> {
    return this.store.getSnapshot()
  }

  async clearRecords(): Promise<void> {
    await this.store.clearFinished()
    this.onChange()
  }

  async reveal(downloadId: string): Promise<'revealed' | 'missing'> {
    const filePath = await this.store.pathForId(downloadId)
    if (!filePath) return 'missing'
    shell.showItemInFolder(filePath)
    return 'revealed'
  }

  async interruptAll(reason = '安全清理中断了下载'): Promise<void> {
    const downloads = [...this.active.values()]
    const updates: Promise<void>[] = []
    for (const active of downloads) {
      this.forcedInterruptions.add(active.id)
      active.item.cancel()
      this.reservedPaths.delete(active.savePath)
      updates.push(
        this.store.update(active.id, {
          status: 'interrupted',
          completedAt: new Date().toISOString(),
          receivedBytes: active.item.getReceivedBytes(),
          error: reason
        })
      )
      this.active.delete(active.id)
    }
    await Promise.allSettled(updates)
    if (downloads.length > 0) this.onChange()
  }

  private async start(item: DownloadItem, windowKind: 'normal' | 'incognito'): Promise<void> {
    const fileName = sanitizeFileName(item.getFilename())
    const savePath = uniqueSavePath(this.downloadDirectory(), fileName, this.reservedPaths)
    this.reservedPaths.add(savePath)
    item.setSavePath(savePath)
    const totalBytes = item.getTotalBytes()
    let record: Awaited<ReturnType<DownloadStore['add']>> | null = null
    let terminalState: string | null = null
    let resultPersisting = false
    const persistResult = (): void => {
      if (!record || !terminalState || resultPersisting) return
      resultPersisting = true
      const currentRecord = record
      const forcedInterruption = this.forcedInterruptions.delete(currentRecord.id)
      const status =
        forcedInterruption
          ? 'interrupted'
          : terminalState === 'completed'
            ? 'completed'
            : terminalState === 'cancelled'
              ? 'cancelled'
              : 'interrupted'
      void this.store
        .update(currentRecord.id, {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
          status,
          completedAt: new Date().toISOString(),
          error:
            status === 'completed'
              ? null
              : status === 'cancelled'
                ? '下载已取消'
                : '下载已中断'
        })
        .catch((error: unknown) =>
          console.error('Download result could not be saved', error instanceof Error ? error.message : String(error))
        )
        .finally(() => {
          this.active.delete(currentRecord.id)
          this.onChange()
        })
    }

    let lastPersistedAt = 0
    item.on('updated', (_event, state) => {
      const currentRecord = record
      if (!currentRecord) return
      const now = Date.now()
      if (now - lastPersistedAt < 250 && state === 'progressing') return
      lastPersistedAt = now
      void this.store
        .update(currentRecord.id, {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
          status: state === 'interrupted' ? 'interrupted' : 'progressing',
          error: state === 'interrupted' ? '下载已中断' : null
        })
        .then(() => this.onChange())
        .catch((error: unknown) =>
          console.error('Download progress could not be saved', error instanceof Error ? error.message : String(error))
        )
    })
    item.once('done', (_event, state) => {
      terminalState = state
      this.reservedPaths.delete(savePath)
      persistResult()
    })

    try {
      record = await this.store.add({
        fileName: basename(savePath),
        savePath,
        totalBytes: totalBytes > 0 ? totalBytes : null,
        windowKind
      })
    } catch (error) {
      this.reservedPaths.delete(savePath)
      throw error
    }
    this.active.set(record.id, { id: record.id, item, savePath })
    this.onChange()
    persistResult()
  }

  private downloadDirectory(): string {
    const downloads = app.getPath('downloads')
    const directory = process.platform === 'win32' ? join(downloads, 'ChatGPT Web Next') : downloads
    mkdirSync(directory, { recursive: true })
    return directory
  }

  private isAllowedDownload(webContents: WebContents | undefined): boolean {
    if (!webContents || webContents.isDestroyed()) return false
    const url = webContents.getURL()
    if (isChatGptPageUrl(url)) return true
    try {
      return this.testAllowedOrigins.has(new URL(url).origin)
        && !this.testAuthenticationOrigins.has(new URL(url).origin)
    } catch {
      return false
    }
  }
}

function sanitizeFileName(value: string): string {
  const withoutControls = [...basename(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
  const name = withoutControls.replaceAll(/[<>:"/\\|?*]/gu, '_').trim()
  return name || 'ChatGPT 下载文件'
}

function uniqueSavePath(
  directory: string,
  fileName: string,
  reservedPaths: ReadonlySet<string>
): string {
  const extension = extname(fileName)
  const stem = basename(fileName, extension)
  let candidate = join(directory, fileName)
  let suffix = 1
  while (existsSync(candidate) || reservedPaths.has(candidate)) {
    candidate = join(directory, `${stem} (${suffix})${extension}`)
    suffix += 1
  }
  return candidate
}
