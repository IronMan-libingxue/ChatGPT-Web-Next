import { join } from 'node:path'
import type { LogoChoice, LogoId, PreferencesSnapshot } from '../shared/types'
import { EncryptedJsonStore } from './encrypted-json-store'

export const DEFAULT_LOGO_ID: LogoId = 'logo-121805'
export const LOGO_CHOICES: LogoChoice[] = [
  { id: 'logo-043714', label: '蓝紫安全' },
  { id: 'logo-121805', label: '银色安全（默认）' },
  { id: 'logo-122825', label: '橙色安全' },
  { id: 'logo-123336', label: '冰蓝安全' },
  { id: 'logo-124106', label: '金色安全' }
]

interface PersistedPreferences {
  schemaVersion: 1
  selectedLogoId: LogoId
}

export class PreferencesStore {
  private readonly store: EncryptedJsonStore<PersistedPreferences>

  constructor(appDataPath: string, testEncryptionSecret?: string) {
    this.store = new EncryptedJsonStore(
      join(appDataPath, 'ChatGPT Web Next Device', 'preferences.bin'),
      () => ({ schemaVersion: 1, selectedLogoId: DEFAULT_LOGO_ID }),
      isPreferences,
      testEncryptionSecret
    )
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
  }

  getSnapshot(): PreferencesSnapshot {
    return {
      selectedLogoId: this.store.get().selectedLogoId,
      logos: LOGO_CHOICES
    }
  }

  async select(logoId: LogoId): Promise<boolean> {
    if (!isLogoId(logoId)) return false
    await this.store.update((current) => ({ ...current, selectedLogoId: logoId }))
    return true
  }

  getPath(): string {
    return this.store.getPath()
  }
}

export function isLogoId(value: unknown): value is LogoId {
  return LOGO_CHOICES.some((choice) => choice.id === value)
}

function isPreferences(value: unknown): value is PersistedPreferences {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedPreferences>
  return candidate.schemaVersion === 1 && isLogoId(candidate.selectedLogoId)
}
