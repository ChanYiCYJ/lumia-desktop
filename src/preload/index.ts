import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, IPC_EVENT, type AppInfo, type WindowControlAction } from '../shared/ipc'

/**
 * 渲染进程原生能力桥（借鉴 CherryHQ/cherry-studio src/preload/ipc.ts 的
 * ipcApi 模式：request + on 单一事件通道）。来源：AGPL-3.0。
 */
const api = {
  /** 窗口控制（最小化/最大化/关闭） */
  windowControl: (action: WindowControlAction): Promise<void> =>
    ipcRenderer.invoke(IPC.App_WindowControl, action),
  /** 应用与平台信息 */
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.App_GetInfo),

  /** 文件 KV 存储（userData/data/*.json，P4 数据层） */
  storageGet: (key: string): Promise<unknown> => ipcRenderer.invoke(IPC.Storage_Get, key),
  storageSet: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC.Storage_Set, key, value),
  storageDelete: (key: string): Promise<void> => ipcRenderer.invoke(IPC.Storage_Delete, key),
  storageKeys: (): Promise<string[]> => ipcRenderer.invoke(IPC.Storage_Keys),

  /** 密钥安全存储（safeStorage 加密，P4） */
  secretsGet: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC.Secrets_Get, key),
  secretsSet: (key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.Secrets_Set, key, value),
  secretsDelete: (key: string): Promise<void> => ipcRenderer.invoke(IPC.Secrets_Delete, key),
  /** 同步加解密（localStorage 透明加密层用；仅处理小字符串） */
  secretEncryptSync: (value: string): string =>
    ipcRenderer.sendSync(IPC.Secrets_EncryptSync, value),
  secretDecryptSync: (value: string): string =>
    ipcRenderer.sendSync(IPC.Secrets_DecryptSync, value),

  /** 网络层（P3 本地引擎 / 远程代理） */
  agentSearch: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Search, req),
  agentFetch: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Fetch, req),
  agentImage: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Image, req),
  agentNotion: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Notion, req),
  agentTts: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Tts, req),
  agentLive2d: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Live2d, req),
  /** 本机工具（终端/文件/剪贴板） */
  agentTool: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Tool, req),
  /** MCP 服务器（技能扩展） */
  agentMcp: (req: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.Agent_Mcp, req),

  /** 文件对话框（导入/导出） */
  dialogSaveFile: (req: unknown): Promise<string | null> =>
    ipcRenderer.invoke(IPC.Dialog_SaveFile, req),
  dialogOpenFile: (filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.Dialog_OpenFile, filters),

  /** 事件订阅（单一通道按 name 分发） */
  on: (event: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, name: string, payload: unknown): void => {
      if (name === event) callback(payload)
    }
    ipcRenderer.on(IPC_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC_EVENT, listener)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
