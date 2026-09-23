import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { safeStorage } from 'electron'

export class EncryptedJsonStore<T> {
  private value: T
  private persistenceReady = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
    private readonly validate: (value: unknown) => value is T,
    private readonly testEncryptionSecret?: string
  ) {
    this.value = createDefault()
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    this.persistenceReady = this.testEncryptionSecret
      ? true
      : await safeStorage.isAsyncEncryptionAvailable()
    if (!this.persistenceReady) return

    try {
      const decrypted = await this.decrypt(await readFile(this.filePath))
      const parsed: unknown = JSON.parse(decrypted)
      if (!this.validate(parsed)) throw new Error('invalid encrypted record schema')
      this.value = parsed
    } catch (error) {
      if (!isMissingFile(error)) {
        try {
          await rename(this.filePath, `${this.filePath}.unreadable-${Date.now()}`)
        } catch {
          // Keep the original if it cannot be preserved under a backup name.
        }
      }
      this.value = this.createDefault()
      await this.persist()
    }
  }

  get(): T {
    return structuredClone(this.value)
  }

  getPath(): string {
    return this.filePath
  }

  async update(updater: (current: T) => T): Promise<T> {
    const next = updater(this.get())
    if (isDeepStrictEqual(next, this.value)) return this.get()
    this.value = next
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    if (!this.persistenceReady) return
    const serialized = JSON.stringify(this.value)
    this.writeQueue = this.writeQueue.then(async () => {
      const encrypted = await this.encrypt(serialized)
      const temporaryPath = `${this.filePath}.tmp-${process.pid}`
      await writeFile(temporaryPath, encrypted, { mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    })
    await this.writeQueue
  }

  private async encrypt(value: string): Promise<Buffer> {
    if (!this.testEncryptionSecret) return safeStorage.encryptStringAsync(value)
    const key = createHash('sha256').update(this.testEncryptionSecret).digest()
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from('CWNTEST2'), nonce, cipher.getAuthTag(), payload])
  }

  private async decrypt(value: Buffer): Promise<string> {
    if (!this.testEncryptionSecret) return (await safeStorage.decryptStringAsync(value)).result
    if (value.subarray(0, 8).toString('utf8') !== 'CWNTEST2') {
      throw new Error('invalid isolated test storage')
    }
    const key = createHash('sha256').update(this.testEncryptionSecret).digest()
    const nonce = value.subarray(8, 20)
    const authTag = value.subarray(20, 36)
    const payload = value.subarray(36)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
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
