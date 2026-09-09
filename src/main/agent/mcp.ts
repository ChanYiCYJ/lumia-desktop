/**
 * MCP (Model Context Protocol) 客户端 —— stdio JSON-RPC 2.0 最小实现。
 * 每个调用拉起一次子进程（initialize → tools/list 或 tools/call），限时后回收，
 * 支持任意 MCP Server（filesystem/git/time 等 npx 包命令）。
 * 安全：仅执行用户在「技能与 MCP」界面自行添加的命令；环境变量透传。
 */
import { spawn } from 'child_process'

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args?: string[]
  /** add/test 时拉取的工具名列表（仅展示/注入用，不缓存执行能力） */
  tools?: string[]
  enabled?: boolean
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

function sanitizeEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

class McpClient {
  private child: ReturnType<typeof spawn> | null = null
  private pending = new Map<number, RpcPending>()
  private nextId = 1
  private buf = ''

  constructor(
    private command: string,
    private args: string[] = []
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let spawned = false
      const child = spawn(this.command, this.args, {
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
      }, RPC_TIMEOUT_MS)
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

/** 初始化并列出工具 */
export async function mcpListTools(
  cfg: McpServerConfig
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const client = new McpClient(cfg.command, cfg.args || [])
  try {
    await client.start()
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lumia-desktop', version: '0.1.0' }
    })
    await client.request('notifications/initialized', undefined)
    const r = (await client.request('tools/list', undefined)) as {
      tools?: { name?: string }[]
    }
    const tools = (r?.tools || []).map((t) => t.name || '').filter(Boolean)
    return { ok: true, tools }
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
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lumia-desktop', version: '0.1.0' }
    })
    await client.request('notifications/initialized', undefined)
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
      output: text || '(无返回内容)',
      error: r?.isError ? '工具返回错误' : undefined
    }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  } finally {
    client.close()
  }
}
