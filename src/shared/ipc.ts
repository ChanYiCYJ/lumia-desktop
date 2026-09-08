/**
 * IPC 通道与类型定义（借鉴 CherryHQ/cherry-studio src/shared/IpcChannel.ts 的
 * 「单一通道 + 路由」思想，按本项目需求精简；来源：AGPL-3.0）
 *
 * 约定：request 走 ipcRenderer.invoke(channel, payload)；
 * 事件走单一 channel（api:event）再按 name 分发（同 Cherry ipcApi.on）。
 */

/** 请求通道（invoke） */
export const IPC = {
  App_WindowControl: 'lumia:app:window-control',
  App_GetInfo: 'lumia:app:get-info',
  Storage_Get: 'lumia:storage:get',
  Storage_Set: 'lumia:storage:set',
  Storage_Delete: 'lumia:storage:delete',
  Storage_Keys: 'lumia:storage:keys',
  Secrets_Get: 'lumia:secrets:get',
  Secrets_Set: 'lumia:secrets:set',
  Secrets_Delete: 'lumia:secrets:delete',
  Secrets_EncryptSync: 'lumia:secrets:encrypt-sync',
  Secrets_DecryptSync: 'lumia:secrets:decrypt-sync',
  Agent_Search: 'lumia:agent:search',
  Agent_Fetch: 'lumia:agent:fetch',
  Agent_Image: 'lumia:agent:image',
  Agent_Notion: 'lumia:agent:notion',
  Agent_Tts: 'lumia:agent:tts',
  Agent_Live2d: 'lumia:agent:live2d',
  Dialog_SaveFile: 'lumia:dialog:save-file',
  Dialog_OpenFile: 'lumia:dialog:open-file'
} as const

/** 事件通道（preload.on 内部分发） */
export const IPC_EVENT = 'lumia:api:event'

export type WindowControlAction = 'minimize' | 'maximize' | 'close'

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  userDataPath: string
  electron: string
  chrome: string
  node: string
}

export interface SearchRequest {
  query: string
  engines?: string
  lang?: string
  provider?: string
  apiKey?: string
  instance?: string
  limit?: number
  fast?: boolean
}

export interface SearchItem {
  title: string
  url: string
  description?: string
  source?: string
  engine?: string
}

export interface SearchResponse {
  items: SearchItem[]
  truncated?: boolean
  tookMs?: number
}

export interface FetchRequest {
  url: string
  raw?: boolean
}

export interface FetchResponse {
  title?: string
  content?: string
  html?: string
  ogImage?: string
  images?: string[]
  error?: string
}

export interface ImageSearchRequest {
  keyword: string
  category?: string
  limit?: number
}

export interface ImageItem {
  title: string
  url: string
  thumbnail?: string
  source?: string
  type?: string
  width?: number
  height?: number
  tags?: string[]
}

export interface NotionRequest {
  path: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  token?: string
}

export interface TtsRequest {
  text: string
  voice?: string
  source?: 'builtin' | 'thirdparty' | 'remote'
  url?: string
}

export interface TtsResponse {
  ok: boolean
  audio?: ArrayBuffer
  error?: string
}

export interface Live2dRequest {
  path: string
  /** 模型名或资源路径 */
  target?: string
}

export interface SaveFileRequest {
  defaultName?: string
  content?: string | ArrayBuffer
  filters?: { name: string; extensions: string[] }[]
}
