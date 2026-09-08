/**
 * 窗口管理（借鉴 CherryHQ/cherry-studio src/main/core/window 的思路：状态持久化 +
 * 控制），精简版。来源：AGPL-3.0
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { storageGet, storageSet } from './store'

const WINDOW_STATE_KEY = 'window-state'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

export function createMainWindow(icon?: string): BrowserWindow {
  const saved = (storageGet(WINDOW_STATE_KEY) as WindowState) || {}

  const win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    x: saved.x,
    y: saved.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // 无边框 + 自绘标题栏（renderer TitleBar 提供拖拽/控制按钮）
    frame: false,
    backgroundColor: '#f5f5f7',
    ...(process.platform === 'linux' && icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (saved.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())

  // 关闭时保存窗口状态
  const saveState = (): void => {
    if (win.isDestroyed()) return
    const bounds = win.getBounds()
    storageSet(WINDOW_STATE_KEY, {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized()
    } satisfies WindowState)
  }
  win.on('resize', saveState)
  win.on('move', saveState)
  win.on('close', saveState)

  win.webContents.setWindowOpenHandler((details) => {
    // 外部链接一律用系统浏览器打开
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  return win
}

/** 注册窗口控制 IPC（renderer 标题栏按钮） */
export function registerWindowIpc(): void {
  ipcMain.handle('lumia:app:window-control', (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })
}
