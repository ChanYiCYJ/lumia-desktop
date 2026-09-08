/** engine.mjs 类型声明（本地引擎纯 JS 模块） */
export function runSearch(opts?: {
  query?: string
  engines?: string
  lang?: string
  provider?: string
  apiKey?: string
  instance?: string
  limit?: number
  fast?: boolean
}): Promise<{ items: unknown[] }>

export function fetchPage(opts?: {
  url?: string
  maxChars?: string | number
  raw?: boolean | string
}): Promise<Record<string, unknown>>

export function searchImage(opts?: {
  keyword?: string
  q?: string
  category?: string
  type?: string
  limit?: number
}): Promise<{ items: unknown[] }>

export function proxyImageRaw(path?: string): Promise<{
  ok: boolean
  contentType?: string
  buffer?: Buffer
  error?: string
}>

export function notionRequest(opts?: {
  path?: string
  method?: string
  body?: unknown
  token?: string
}): Promise<{ status: number; text: string }>

export function live2dAsset(
  pathname: string,
  isApi?: boolean
): Promise<{ ok: boolean; contentType?: string; buffer?: Buffer; error?: string }>

export function live2dProxy(url?: string): Promise<{
  ok: boolean
  contentType?: string
  buffer?: Buffer
  error?: string
}>
