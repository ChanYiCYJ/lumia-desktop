import { app, ipcMain, BrowserWindow, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createMainWindow, registerWindowIpc } from './core/window'
import { storageGet, storageSet, storageDelete, storageKeys } from './core/store'
import { secretsGet, secretsSet, secretsDelete } from './secrets'
import { safeStorageEncrypt, safeStorageDecrypt } from './secrets'
import { registerAgentIpc } from './agent/index'
import { registerLumiaProtocols } from './protocol'
import { applyGpuCompat, watchGpuCompat } from './gpu'
import { IPC, type AppInfo } from '../shared/ipc'

// Windows/远程桌面 GPU 白屏自愈：须在 app ready 前决定是否软渲
applyGpuCompat()

// 自定义特权协议（必须在 app ready 前声明）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumia-live2d',
    privileges: { secure: true, supportFetchAPI: true, stream: true }
  }
])

// 单实例锁（借鉴 Cherry preboot/singleInstance 思路）：二次启动聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  function registerIpc(): void {
    registerWindowIpc()

    ipcMain.handle(IPC.App_GetInfo, (): AppInfo => {
      return {
        version: app.getVersion(),
        platform: process.platform,
        userDataPath: app.getPath('userData'),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      }
    })

    // 文件 KV 存储
    ipcMain.handle(IPC.Storage_Get, (_e, key: string) => storageGet(key))
    ipcMain.handle(IPC.Storage_Set, (_e, key: string, value: unknown) => {
      storageSet(key, value)
    })
    ipcMain.handle(IPC.Storage_Delete, (_e, key: string) => storageDelete(key))
    ipcMain.handle(IPC.Storage_Keys, () => storageKeys())

    // 密钥安全存储
    ipcMain.handle(IPC.Secrets_Get, (_e, key: string) => secretsGet(key))
    ipcMain.handle(IPC.Secrets_Set, (_e, key: string, value: string) => secretsSet(key, value))
    ipcMain.handle(IPC.Secrets_Delete, (_e, key: string) => secretsDelete(key))

    // 同步加解密（renderer localStorage 透明加密层）
    ipcMain.on(IPC.Secrets_EncryptSync, (event, value: string) => {
      event.returnValue = safeStorageEncrypt(value)
    })
    ipcMain.on(IPC.Secrets_DecryptSync, (event, value: string) => {
      event.returnValue = safeStorageDecrypt(value)
    })

    // 文件对话框（导入/导出）
    ipcMain.handle(
      IPC.Dialog_SaveFile,
      async (
        _e,
        req: {
          defaultName?: string
          content?: string | ArrayBuffer
          filters?: { name: string; extensions: string[] }[]
        }
      ) => {
        const { canceled, filePath } = await dialog.showSaveDialog({
          defaultPath: req.defaultName,
          filters: req.filters
        })
        if (canceled || !filePath) return null
        const { writeFile } = await import('fs/promises')
        const data =
          typeof req.content === 'string'
            ? req.content
            : new Uint8Array(req.content ?? new ArrayBuffer(0))
        await writeFile(filePath, data)
        return filePath
      }
    )
    ipcMain.handle(
      IPC.Dialog_OpenFile,
      async (_e, filters?: { name: string; extensions: string[] }[]) => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters
        })
        return canceled || !filePaths.length ? null : filePaths[0]
      }
    )
  }

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.lumia.desktop')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpc()
    registerAgentIpc()
    registerLumiaProtocols()

    // GPU 启动异常 → 自动软渲重启（须在窗口创建前挂监听）
    watchGpuCompat()

    const mainWindow = createMainWindow(icon)
    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) {
        const w = createMainWindow(icon)
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
          w.loadURL(process.env['ELECTRON_RENDERER_URL'])
        } else {
          w.loadFile(join(__dirname, '../renderer/index.html'))
        }
      }
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
