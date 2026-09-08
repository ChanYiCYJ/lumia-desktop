/**
 * 本地模型 API 配置（非管理员可各自在本机浏览器填写自己的 endpoint/key/model）
 * 优先级：本地配置 > 机器人默认配置；仅保存在 localStorage，不会上传服务器。
 */

export interface LocalAIConfig {
  endpoint: string
  apiKey: string
  model: string
  /** 本地自定义提示词（覆盖默认人设，可选） */
  prompt?: string
}

const PREFIX = 'kimo_ai_local_'

export function getLocalCfg(pageId: number): LocalAIConfig {
  try {
    const r = JSON.parse(localStorage.getItem(PREFIX + pageId) || '')
    if (r && typeof r === 'object') {
      return {
        endpoint: typeof r.endpoint === 'string' ? r.endpoint : '',
        apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
        model: typeof r.model === 'string' ? r.model : '',
        prompt: typeof r.prompt === 'string' ? r.prompt : '',
      }
    }
  } catch { /* 忽略 */ }
  return { endpoint: '', apiKey: '', model: '', prompt: '' }
}

export function saveLocalCfg(pageId: number, c: LocalAIConfig): void {
  try {
    localStorage.setItem(PREFIX + pageId, JSON.stringify(c))
  } catch { /* 忽略 */ }
}

export function clearLocalCfg(pageId: number): void {
  try {
    localStorage.removeItem(PREFIX + pageId)
  } catch { /* 忽略 */ }
}

export function hasLocalCfg(pageId: number): boolean {
  const c = getLocalCfg(pageId)
  return !!(c.endpoint && c.apiKey && c.model)
}
