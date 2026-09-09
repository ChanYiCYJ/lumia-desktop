/**
 * Agent 网络层 IPC 注册（本地引擎：搜索/抓取/图片/Notion/Live2D/TTS）
 * 来源：lumia-frontend worker.js 逻辑 + msedge-tts（MIT），AGPL-3.0
 */
import { ipcMain } from 'electron'
import * as engine from './engine.mjs'
import { synthesize } from './tts'
import { runLocalTool } from './tools'
import { mcpListTools, mcpCallTool, type McpServerConfig } from './mcp'
import { IPC } from '../../shared/ipc'

export function registerAgentIpc(): void {
  ipcMain.handle(IPC.Agent_Search, (_e, req) => engine.runSearch(req ?? {}))

  ipcMain.handle(IPC.Agent_Fetch, (_e, req) => engine.fetchPage(req ?? {}))

  ipcMain.handle(IPC.Agent_Image, (_e, req) => engine.searchImage(req ?? {}))

  ipcMain.handle(IPC.Agent_Notion, (_e, req) => engine.notionRequest(req ?? {}))

  ipcMain.handle(IPC.Agent_Tts, async (_e, req) => {
    const text = String(req?.text || '').slice(0, 600)
    const voice = req?.voice || 'zh-CN-XiaoxiaoNeural'
    // 远程模板 URL（含 {text}/{voice} 占位）优先：走主进程代理下载（免 CORS）
    const template = req?.url || ''
    if (template.startsWith('http')) {
      try {
        const target = template
          .replaceAll('{text}', encodeURIComponent(text))
          .replaceAll('{voice}', encodeURIComponent(voice))
        const res = await fetch(target)
        if (!res.ok) throw new Error('TTS upstream ' + res.status)
        const buf = Buffer.from(await res.arrayBuffer())
        return {
          ok: true,
          audio: buf.toString('base64'),
          contentType: res.headers.get('content-type') || 'audio/mpeg'
        }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    }
    // 本地 msedge-tts 合成
    const r = await synthesize(text, voice)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, audio: r.audio!.toString('base64'), contentType: r.contentType }
  })

  ipcMain.handle(IPC.Agent_Live2d, async (_e, req) => {
    const path = String(req?.path || '')
    const isApi = Boolean(req?.isApi)
    const isProxy = path.startsWith('proxy/')
    const r = isProxy
      ? await engine.live2dProxy(path.slice('proxy/'.length))
      : await engine.live2dAsset(path, isApi)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, dataUrl: `data:${r.contentType};base64,${r.buffer!.toString('base64')}` }
  })

  // 本机工具（终端/文件/剪贴板）—— AI 操作电脑能力
  ipcMain.handle(IPC.Agent_Tool, (_e, req) =>
    runLocalTool(req ?? { tool: '', args: {} })
  )

  // MCP 服务器（stdio JSON-RPC）—— 技能扩展（filesystem/git/任意 npx MCP）
  ipcMain.handle(IPC.Agent_Mcp, async (_e, req) => {
    const server = (req?.server || {}) as McpServerConfig
    const action = String(req?.action || 'list')
    if (action === 'list') return mcpListTools(server)
    if (action === 'call')
      return mcpCallTool(server, String(req?.tool || ''), (req?.args || {}) as Record<string, unknown>)
    return { ok: false, tools: [], error: `未知 MCP 动作: ${action}` }
  })
}
