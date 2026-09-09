/**
 * MCP 服务器配置与调用（renderer 侧）：
 * 配置存 localStorage（kimo_mcp_servers），执行走主进程 stdio JSON-RPC。
 * AI 工具命名：mcp_<serverId>_<tool>（便于 [TOOL:] 协议路由）。
 */
import { isNative } from './remote'

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args?: string[]
  /** 保存/测试时拉取的工具名（仅展示与提示词注入） */
  tools?: string[]
  enabled?: boolean
}

const KEY = 'kimo_mcp_servers'

export function loadMcpServers(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? (arr as McpServerConfig[]) : []
  } catch {
    return []
  }
}

export function saveMcpServers(list: McpServerConfig[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 忽略 */
  }
}

export function mcpId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** sanitize 为工具名前缀（ASCII） */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24)
}

export function buildMcpToolName(server: McpServerConfig, tool: string): string {
  return `mcp_${sanitize(server.id)}_${tool}`
}

/** 解析 mcp_<id>_<tool> → { serverId, tool } */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  const m = name.match(/^mcp_([A-Za-z0-9_]+)_(.+)$/)
  return m ? { serverId: m[1], tool: m[2] } : null
}

export async function mcpListTools(
  server: McpServerConfig
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  if (!isNative()) return { ok: false, tools: [], error: 'MCP 仅在桌面版可用' }
  try {
    const r = (await window.api.agentMcp({ action: 'list', server })) as {
      ok: boolean
      tools: string[]
      error?: string
    }
    return r || { ok: false, tools: [], error: 'MCP 无响应' }
  } catch (e) {
    return { ok: false, tools: [], error: String((e as Error)?.message || e) }
  }
}

export async function mcpCall(
  server: McpServerConfig,
  tool: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!isNative()) return { ok: false, output: '', error: 'MCP 仅在桌面版可用' }
  try {
    const r = (await window.api.agentMcp({ action: 'call', server, tool, args })) as {
      ok: boolean
      output: string
      error?: string
    }
    return r || { ok: false, output: '', error: 'MCP 无响应' }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}
