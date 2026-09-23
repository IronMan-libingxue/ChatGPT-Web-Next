import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  setIcon: vi.fn(),
  createFromPath: vi.fn((path: string) => ({
    isEmpty: () => path.endsWith('logo-043714.png')
  }))
}))

vi.mock('electron', () => ({
  app: {
    dock: { setIcon: electronMocks.setIcon },
    isPackaged: false,
    getAppPath: () => '/fixture-app'
  },
  nativeImage: { createFromPath: electronMocks.createFromPath },
  safeStorage: {}
}))

import { LogoService } from '../src/main/logo-service'
import {
  DEFAULT_LOGO_ID,
  LOGO_CHOICES,
  PreferencesStore
} from '../src/main/preferences-store'

const roots: string[] = []
afterEach(async () => {
  electronMocks.setIcon.mockClear()
  electronMocks.createFromPath.mockClear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('logo preferences', () => {
  it('ships five choices, defaults to 12_18_05, and persists a selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-logo-preferences-'))
    roots.push(root)
    const first = new PreferencesStore(root, 'logo-secret')
    await first.initialize()
    expect(LOGO_CHOICES).toHaveLength(5)
    expect(first.getSnapshot().selectedLogoId).toBe(DEFAULT_LOGO_ID)
    expect(await first.select('logo-124106')).toBe(true)

    const restarted = new PreferencesStore(root, 'logo-secret')
    await restarted.initialize()
    expect(restarted.getSnapshot().selectedLogoId).toBe('logo-124106')
    expect(await restarted.select('not-a-logo' as never)).toBe(false)
  })

  it('falls back to the default bundled icon when a selected runtime icon is missing', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const selected = new LogoService().apply('logo-043714')
      expect(selected).toBe(DEFAULT_LOGO_ID)
      expect(electronMocks.createFromPath).toHaveBeenCalledTimes(2)
      expect(electronMocks.setIcon).toHaveBeenCalledTimes(1)
    } finally {
      platform.mockRestore()
    }
  })

  it('backs up a corrupt preference and safely restores the default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-logo-corrupt-'))
    roots.push(root)
    const first = new PreferencesStore(root, 'logo-corrupt-secret')
    await first.initialize()
    await first.select('logo-124106')
    await writeFile(first.getPath(), 'corrupt-logo-preference')

    const recovered = new PreferencesStore(root, 'logo-corrupt-secret')
    await recovered.initialize()
    expect(recovered.getSnapshot().selectedLogoId).toBe(DEFAULT_LOGO_ID)
    const files = await readdir(join(root, 'ChatGPT Web Next Device'))
    expect(files.some((name) => name.startsWith('preferences.bin.unreadable-'))).toBe(true)
  })
})
