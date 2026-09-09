/**
 * 渲染层 → 主进程原生能力桥（Electron）。
 * 仅当 window.api 存在（Electron）时使用；浏览器/测试环境自动回退原逻辑。
 */
export function isNative(): boolean {
  return (
    typeof window !== 'undefined' && !!window.api && typeof window.api.agentSearch === 'function'
  )
}

export function hasApi(): boolean {
  return isNative()
}

/** 搜索（本地引擎） */
export function search(req: {
  query: string
  engines?: string
  lang?: string
  provider?: string
  apiKey?: string
  instance?: string
  limit?: number
  fast?: boolean
}): Promise<unknown> {
  return window.api.agentSearch(req)
}

/** 网页抓取 */
export function fetchPage(req: {
  url: string
  maxChars?: string | number
  raw?: boolean | string
}): Promise<unknown> {
  return window.api.agentFetch(req)
}

/** 图片搜索 */
export function image(req: {
  keyword: string
  category?: string
  limit?: number
}): Promise<unknown> {
  return window.api.agentImage(req)
}

/** Notion REST */
export function notion(req: {
  path: string
  method?: string
  body?: unknown
  token?: string
}): Promise<unknown> {
  return window.api.agentNotion(req)
}

/** 本机工具（终端/文件/剪贴板） */
export function tool(req: { tool: string; args?: Record<string, unknown> }): Promise<unknown> {
  return window.api.agentTool(req)
}

/** TTS：返回 Blob URL（主进程合成/代理下载） */
export async function tts(req: {
  text: string
  voice?: string
  url?: string
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = (await window.api.agentTts(req)) as {
    ok: boolean
    audio?: string
    contentType?: string
    error?: string
  }
  if (!r.ok || !r.audio) return { ok: false, error: r.error || 'tts failed' }
  const bytes = Uint8Array.from(atob(r.audio), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: r.contentType || 'audio/webm' })
  return { ok: true, url: URL.createObjectURL(blob) }
}
