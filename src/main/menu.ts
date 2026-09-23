import { Menu, app } from 'electron'
import type { WindowManager } from './window-manager'

export function installApplicationMenu(manager: WindowManager): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置与状态…',
          accelerator: 'CommandOrControl+,',
          click: () => {
            const managed = manager.getFocused()
            if (managed) void manager.openSettings(managed)
          }
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建无痕窗口',
          accelerator: 'CommandOrControl+Shift+N',
          click: () => void manager.createWindow('incognito')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '显示',
      submenu: [
        {
          label: '刷新 ChatGPT',
          accelerator: 'CommandOrControl+R',
          click: () => {
            const managed = manager.getFocused()
            if (managed) manager.refresh(managed)
          }
        },
        {
          label: '忽略缓存并刷新',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => {
            const managed = manager.getFocused()
            if (managed) manager.refresh(managed, true)
          }
        },
        { type: 'separator' },
        {
          id: 'page-zoom-in',
          label: '放大 ChatGPT 网页',
          accelerator: 'CommandOrControl+Plus',
          click: () => {
            const managed = manager.getFocused()
            if (managed) manager.adjustPageZoom(managed, 0.1)
          }
        },
        {
          id: 'page-zoom-out',
          label: '缩小 ChatGPT 网页',
          accelerator: 'CommandOrControl+-',
          click: () => {
            const managed = manager.getFocused()
            if (managed) manager.adjustPageZoom(managed, -0.1)
          }
        },
        {
          id: 'page-zoom-reset',
          label: '恢复 ChatGPT 网页大小',
          accelerator: 'CommandOrControl+0',
          click: () => {
            const managed = manager.getFocused()
            if (managed) manager.resetPageZoom(managed)
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
