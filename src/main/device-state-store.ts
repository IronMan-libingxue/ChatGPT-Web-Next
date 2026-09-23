import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { safeStorage } from 'electron'
import type { PersistedDeviceState, StorageStatus } from '../shared/types'
import { createDeviceState, normalizeDeviceState } from '../shared/work-state'

type StateUpdater = (state: PersistedDeviceState) => PersistedDeviceState

export class DeviceStateStore {
  private readonly statePath: string
  private state: PersistedDeviceState = createDeviceState()
  private warning: string | null = null
  private status: StorageStatus = 'initializing'
  private persistenceReady = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    appDataPath: string,
    private readonly testEncryptionSecret?: string
  ) {
    this.statePath = join(appDataPath, 'ChatGPT Web Next Device', 'device-state.bin')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    this.persistenceReady = this.testEncryptionSecret
      ? true
      : await safeStorage.isAsyncEncryptionAvailable()

    if (!this.persistenceReady) {
      this.status = 'unavailable'
      this.warning = '系统加密当前不可用；本次运行不会把设备状态写入磁盘。'
      return
    }
    this.warning = null

    try {
      const encrypted = await readFile(this.statePath)
      const decrypted = await this.decrypt(encrypted)
      const parsed: unknown = JSON.parse(decrypted.result)
      const normalized = normalizeDeviceState(parsed)
      if (!normalized) throw new Error('invalid device state schema')
      this.state = normalized
      if (decrypted.shouldReEncrypt || (parsed as { schemaVersion?: number }).schemaVersion !== 2) {
        await this.persist()
      }
    } catch (error) {
      if (isMissingFile(error)) {
        await this.persist()
        this.status = 'ready'
        return
      }

      const backup = `${this.statePath}.unreadable-${Date.now()}`
      try {
        await rename(this.statePath, backup)
      } catch {
        // Preserve the original when it cannot be renamed.
      }
      this.state = createDeviceState()
      this.warning = '原设备记录无法读取，已保留备份并建立新的本机记录。'
      await this.persist()
    }
    this.status = 'ready'
  }

  getState(): PersistedDeviceState {
    return structuredClone(this.state)
  }

  getWarning(): string | null {
    return this.warning
  }

  getStatus(): StorageStatus {
    return this.status
  }

  markInitializationFailed(): void {
    this.status = 'error'
    this.warning = '本机加密记录初始化失败；本次运行不会把设备状态写入磁盘。'
  }

  getPath(): string {
    return this.statePath
  }

  async update(updater: StateUpdater): Promise<PersistedDeviceState> {
    const nextState = updater(this.getState())
    if (isDeepStrictEqual(nextState, this.state)) return this.getState()
    this.state = nextState
    await this.persist()
    return this.getState()
  }

  async touchClock(now = new Date()): Promise<void> {
    await this.update((state) => ({ ...state, lastWallClockAt: now.toISOString() }))
  }

  private async persist(): Promise<void> {
    if (!this.persistenceReady) return
    const serialized = JSON.stringify(this.state)

    this.writeQueue = this.writeQueue.then(async () => {
      const encrypted = await this.encrypt(serialized)
      const temporaryPath = `${this.statePath}.tmp-${process.pid}`
      await writeFile(temporaryPath, encrypted, { mode: 0o600 })
      await rename(temporaryPath, this.statePath)
    })
    await this.writeQueue
  }

  private async encrypt(value: string): Promise<Buffer> {
    if (!this.testEncryptionSecret) return safeStorage.encryptStringAsync(value)

    const key = createHash('sha256').update(this.testEncryptionSecret).digest()
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from('CWNTEST1'), nonce, cipher.getAuthTag(), payload])
  }

  private async decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    if (!this.testEncryptionSecret) return safeStorage.decryptStringAsync(value)

    if (value.subarray(0, 8).toString('utf8') !== 'CWNTEST1') {
      throw new Error('invalid isolated test storage')
    }
    const key = createHash('sha256').update(this.testEncryptionSecret).digest()
    const nonce = value.subarray(8, 20)
    const authTag = value.subarray(20, 36)
    const payload = value.subarray(36)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    const result = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
    return { result, shouldReEncrypt: false }
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
  )
}
