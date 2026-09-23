import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceStateStore } from '../src/main/device-state-store'

describe('Device state storage', () => {
  it('does not rewrite encrypted storage when an update makes no logical change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatgpt-web-next-device-store-'))
    try {
      const store = new DeviceStateStore(root, 'isolated-test-secret')
      await store.initialize()
      const stateBefore = store.getState()
      const encryptedBefore = await readFile(store.getPath())

      await store.update((state) => structuredClone(state))

      expect(store.getState()).toEqual(stateBefore)
      expect(await readFile(store.getPath())).toEqual(encryptedBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
