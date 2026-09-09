/**
 * 本机工具桥（renderer → 主进程）：
 * 终端/文件/剪贴板 经 window.api.agentTool（主进程执行，无 CORS）。
 * 敏感工具（shell/write_file）执行前必须过用户确认（AIChat pendingTool 模态）。
 */
import { isNative } from './remote'

export interface LocalToolRequest {
  tool: string
  args?: Record<string, unknown>
}

export interface LocalToolResult {
  ok: boolean
  output: string
  error?: string
}

/** 本机工具可用（preload 桥存在） */
export function hasLocalTools(): boolean {
  return isNative()
}

/** 执行本机工具；桥不可用/异常时返回失败而非抛错（不打断对话） */
export async function runLocalTool(req: LocalToolRequest): Promise<LocalToolResult> {
  if (!hasLocalTools()) return { ok: false, output: '', error: '本机工具不可用（非桌面/未加载桥）' }
  try {
    const r = (await window.api.agentTool(req)) as LocalToolResult
    return r || { ok: false, output: '', error: '工具无响应' }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}
