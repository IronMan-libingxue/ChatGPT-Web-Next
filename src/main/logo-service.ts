import { join } from 'node:path'
import { app, nativeImage } from 'electron'
import type { LogoId } from '../shared/types'
import { DEFAULT_LOGO_ID } from './preferences-store'

export class LogoService {
  apply(logoId: LogoId): LogoId {
    if (process.platform !== 'darwin' || !app.dock) return logoId
    const selected = this.load(logoId)
    if (!selected.image.isEmpty()) {
      app.dock.setIcon(selected.image)
      return selected.id
    }
    const fallback = this.load(DEFAULT_LOGO_ID)
    if (!fallback.image.isEmpty()) app.dock.setIcon(fallback.image)
    return DEFAULT_LOGO_ID
  }

  getPath(logoId: LogoId): string {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'icons')
      : join(app.getAppPath(), 'resources', 'icons')
    return join(root, `${logoId}.png`)
  }

  private load(logoId: LogoId): { id: LogoId; image: Electron.NativeImage } {
    return { id: logoId, image: nativeImage.createFromPath(this.getPath(logoId)) }
  }
}
