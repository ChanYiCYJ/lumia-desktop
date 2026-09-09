/**
 * MCP (Model Context Protocol) 客户端 —— stdio JSON-RPC 2.0。
 * 两种用法：
 *  - 一次性（mcpListTools/mcpCallTool）：每次调用拉起子进程 → initialize → 调用 → 回收，
 *    适合「测试连接」/ 无状态服务器（filesystem/git/time 等）。
 *  - 长驻会话（mcpSessionConnect/mcpSessionCall）：按服务器 id 保活子进程，多次 tools/call
 *    共享同一进程与状态 —— Computer Use（浏览器自动化）等多步场景必须用它
 *    （导航→点击→输入跨步骤不丢浏览器）。
 * 安全：仅执行用户在「技能与 MCP」界面自行添加的命令；环境变量透传。
 * 复用：社区 MCP stdio 客户端通用模式（Cherry Studio AGPL-3.0 亦有同类思路），自研最小实现。
 */
import { spawn, exec } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args?: string[]
  /** add/test 时拉取的工具名列表（仅展示/注入用，不缓存执行能力） */
  tools?: string[]
  enabled?: boolean
  /** 首次连接前自动安装的 Playwright 浏览器（如 'chromium'；仅 Computer Use 预设设置） */
  browsers?: string
}

export interface McpCallResult {
  ok: boolean
  output: string
  error?: string
}

interface RpcPending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const RPC_TIMEOUT_MS = 15_000
/** 长驻会话调用超时：浏览器导航/无障碍快照可能明显慢于普通 MCP 工具 */
const SESSION_TIMEOUT_MS = 90_000
/** 首次自动安装 Playwright 浏览器超时（下载 Chromium 可能较慢） */
const BROWSER_INSTALL_TIMEOUT_MS = 300_000
/** tools/call 返回文本上限（browser_snapshot 的无障碍树可能很大） */
const MAX_MCP_OUTPUT = 120_000

function sanitizeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_yes: 'true' }
}

/** 截断过长工具输出（避免超大无障碍树撑爆内存/上下文） */
function clampOutput(s: string): string {
  if (!s) return ''
  return s.length <= MAX_MCP_OUTPUT ? s : s.slice(0, MAX_MCP_OUTPUT) + '\n…（输出过长已截断）'
}

class McpClient {
  private child: ReturnType<typeof spawn> | null = null
  private pending = new Map<number, RpcPending>()
  private nextId = 1
  private buf = ''

  constructor(
    private command: string,
    private args: string[] = [],
    private timeoutMs = RPC_TIMEOUT_MS
  ) {}

  /** 子进程是否仍在运行（长驻会话判活用） */
  alive(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let spawned = false
      // Windows 下裸命令（如 npx）spawn 不解析 PATHEXT → 补 .cmd（shell:false 时必需）
      const cmd =
        process.platform === 'win32' &&
        !this.command.includes('/') &&
        !this.command.includes('\\') &&
        !/\.(exe|cmd|bat|com)$/i.test(this.command)
          ? this.command + '.cmd'
          : this.command
      const child = spawn(cmd, this.args, {
        env: sanitizeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
      this.child = child
      let started = false
      const onData = (chunk: Buffer): void => {
        this.buf += chunk.toString('utf8')
        let idx: number
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim()
          this.buf = this.buf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as {
              id?: number
              method?: string
              result?: unknown
              error?: { message?: string }
            }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!
              this.pending.delete(msg.id)
              clearTimeout(p.timer)
              if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'))
              else p.resolve(msg.result)
            } else if (msg.id !== undefined && typeof msg.method === 'string') {
              // 服务端→客户端请求（roots/list、sampling/createMessage 等）：回空结果避免卡死
              // （本客户端不实现采样/roots，空结果对纯工具模式足够）
              this.child?.stdin?.write(
                JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'
              )
            }
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', (d: Buffer) => {
        // stderr 常用于日志，保留最后一段供故障排查
        this.errTail = (this.errTail + d.toString('utf8')).slice(-2000)
      })
      child.on('spawn', () => {
        spawned = true
        if (!started) {
          started = true
          resolve()
        }
      })
      child.on('error', (e) => {
        if (!started) {
          started = true
          reject(e)
        } else {
          this.failAll(new Error('MCP 进程已退出: ' + e.message))
        }
      })
      child.on('exit', (code) => {
        if (!spawned) return
        this.failAll(new Error(`MCP 进程退出（code=${code}）：${this.errTail.slice(-300) || ''}`))
      })
      setTimeout(() => {
        if (!started) {
          started = true
          child.kill()
          reject(new Error('MCP 启动超时'))
        }
      }, RPC_TIMEOUT_MS)
    })
  }

  private errTail = ''

  /** 发送无响应的通知（规范要求 notifications/* 不带 id） */
  private notify(method: string, params?: unknown): void {
    if (!this.child || !this.child.stdin) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** initialize + initialized 通知（会话开始前调用一次） */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lumia-desktop', version: '0.1.0' }
    })
    this.notify('notifications/initialized')
  }

  /** 列出该服务器工具名 */
  async listTools(): Promise<string[]> {
    const r = (await this.request('tools/list', undefined)) as {
      tools?: { name?: string }[]
    }
    return (r?.tools || []).map((t) => t.name || '').filter(Boolean)
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin) {
        reject(new Error('MCP 未启动'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('MCP 请求超时: ' + method))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    this.pending.clear()
  }

  close(): void {
    this.failAll(new Error('MCP 关闭'))
    this.child?.kill()
    this.child = null
  }
}

/** 初始化并列出工具（一次性） */
export async function mcpListTools(
  cfg: McpServerConfig
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const client = new McpClient(cfg.command, cfg.args || [])
  try {
    await client.start()
    await client.initialize()
    return { ok: true, tools: await client.listTools() }
  } catch (e) {
    return { ok: false, tools: [], error: String((e as Error)?.message || e) }
  } finally {
    client.close()
  }
}

/** 调用 MCP 工具 */
export async function mcpCallTool(
  cfg: McpServerConfig,
  tool: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const client = new McpClient(cfg.command, cfg.args || [])
  try {
    await client.start()
    await client.initialize()
    const r = (await client.request('tools/call', { name: tool, arguments: args })) as {
      content?: { type?: string; text?: string }[]
      isError?: boolean
    }
    const text = (r?.content || [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
    return {
      ok: !r?.isError,
      output: clampOutput(text) || '(无返回内容)',
      error: r?.isError ? '工具返回错误' : undefined
    }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  } finally {
    client.close()
  }
}

/* ------------------- 长驻会话（有状态 MCP：Computer Use 等） ------------------- */

interface McpSession {
  server: McpServerConfig
  client: McpClient
}

const sessions = new Map<string, McpSession>()

/** 首次连接前自动安装 Playwright 浏览器（仅 Computer Use 预设设置 browsers；装过有标记不再重复） */
async function ensureMcpBrowsers(server: McpServerConfig): Promise<string | null> {
  if (!server.browsers) return null
  const browser = /^[a-z0-9-]+$/i.test(server.browsers) ? server.browsers : 'chromium'
  const base = app?.getPath?.('userData') || join(tmpdir(), 'lumia-desktop')
  const dir = join(base, 'mcp-browsers')
  const key = (server.id || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_')
  const marker = join(dir, `${key}-${browser}.ok`)
  if (existsSync(marker)) return null
  await mkdir(dir, { recursive: true })
  const ok = await new Promise<boolean>((resolve) => {
    // 命令为硬编码（非用户输入），无注入面；与后续 @playwright/mcp 共用同一浏览器缓存目录
    exec(
      `npx -y playwright@latest install ${browser}`,
      {
        cwd: dir,
        timeout: BROWSER_INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: sanitizeEnv()
      },
      (err) => resolve(!err)
    )
  })
  if (!ok)
    return `自动安装浏览器 ${browser} 失败：请在终端手动执行「npx -y playwright@latest install ${browser}」后重试`
  try {
    await writeFile(marker, String(Date.now()))
  } catch {
    /* 标记写失败不影响使用（下次可能重复安装，可接受） */
  }
  return null
}

/** 建立/复用长驻会话，返回该服务器工具名（进程已退则自动重建） */
export async function mcpSessionConnect(
  server: McpServerConfig
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  try {
    const instErr = await ensureMcpBrowsers(server)
    if (instErr) return { ok: false, tools: [], error: instErr }
    const existing = sessions.get(server.id)
    if (existing && existing.client.alive()) {
      return { ok: true, tools: await existing.client.listTools() }
    }
    if (existing) {
      try {
        existing.client.close()
      } catch {
        /* 忽略 */
      }
      sessions.delete(server.id)
    }
    const client = new McpClient(server.command, server.args || [], SESSION_TIMEOUT_MS)
    await client.start()
    await client.initialize()
    const tools = await client.listTools()
    sessions.set(server.id, { server, client })
    return { ok: true, tools }
  } catch (e) {
    const stale = sessions.get(server.id)
    if (stale) {
      try {
        stale.client.close()
      } catch {
        /* 忽略 */
      }
      sessions.delete(server.id)
    }
    return { ok: false, tools: [], error: String((e as Error)?.message || e) }
  }
}

/** 通过长驻会话调用工具（多步共享浏览器等状态）；进程退出会自动重建一次 */
export async function mcpSessionCall(
  server: McpServerConfig,
  tool: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  try {
    let sess = sessions.get(server.id)
    if (!sess || !sess.client.alive()) {
      const c = await mcpSessionConnect(server)
      if (!c.ok) return { ok: false, output: '', error: c.error || 'MCP 未连接' }
      sess = sessions.get(server.id)!
    }
    const r = (await sess.client.request('tools/call', {
      name: tool,
      arguments: args
    })) as { content?: { type?: string; text?: string }[]; isError?: boolean }
    const text = (r?.content || [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
    return {
      ok: !r?.isError,
      output: clampOutput(text) || '(无返回内容)',
      error: r?.isError ? '工具返回错误' : undefined
    }
  } catch (e) {
    const sess = sessions.get(server.id)
    if (sess) {
      try {
        sess.client.close()
      } catch {
        /* 忽略 */
      }
      sessions.delete(server.id)
    }
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

/** 关闭指定服务器的长驻会话（停用/删除服务器时调用） */
export function mcpSessionClose(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.client.close()
  } catch {
    /* 忽略 */
  }
  sessions.delete(id)
}

/** 应用退出前清理全部长驻会话（避免残留浏览器/子进程） */
export function closeAllMcpSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.client.close()
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear()
}
