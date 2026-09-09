/**
 * 本机工具（Agent 操作电脑能力）：
 * 终端 / 文件读写 / 目录列表 / 剪贴板，由主进程安全执行（无 CORS、直接访问本机）。
 * 调用方（renderer）在执行 shell / 写文件等敏感工具前必须得到用户确认；
 * 本文件只保证「执行与限流」，不替代 UI 层的确认。
 */
import { exec } from 'child_process'
import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname } from 'path'

export interface ToolRequest {
  tool: string
  args?: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  output: string
  error?: string
}

const MAX_OUTPUT = 256 * 1024
const SHELL_TIMEOUT_MS = 20_000

function clamp(s: string): string {
  if (!s || s.length <= MAX_OUTPUT) return s || ''
  return s.slice(0, MAX_OUTPUT) + '\n…（输出过长已截断）'
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function runShell(cmd: string, cwd: string): Promise<ToolResult> {
  if (!cmd.trim()) return Promise.resolve({ ok: false, output: '', error: '命令为空' })
  return new Promise((resolve) => {
    exec(
      cmd,
      { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 2 },
      (err, stdout, stderr) => {
        const out = [stdout || '', stderr || ''].filter(Boolean).join('\n')
        resolve({
          ok: !err,
          output: clamp(out),
          error: err ? String(err?.message || err) : undefined
        })
      }
    )
  })
}

async function readFileTool(path: string): Promise<ToolResult> {
  try {
    const raw = await readFile(path, 'utf8')
    return { ok: true, output: clamp(raw) }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

async function writeFileTool(path: string, content: string): Promise<ToolResult> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return { ok: true, output: `已写入 ${path}（${content.length} 字符）` }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

async function listDirTool(path: string): Promise<ToolResult> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${e.isDirectory() ? 'd' : e.isFile() ? 'f' : '?'}  ${e.name}`)
    return { ok: true, output: clamp(lines.join('\n') || '（空目录）') }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

function clipboardRead(): ToolResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { clipboard } = require('electron')
    return { ok: true, output: clamp(clipboard.readText() || '（剪贴板为空）') }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

function clipboardWrite(text: string): ToolResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { clipboard } = require('electron')
    clipboard.writeText(text)
    return { ok: true, output: `已复制到剪贴板（${text.length} 字符）` }
  } catch (e) {
    return { ok: false, output: '', error: String((e as Error)?.message || e) }
  }
}

/** 执行本机工具（主进程入口） */
export async function runLocalTool(req: ToolRequest): Promise<ToolResult> {
  const tool = req?.tool || ''
  const args = req?.args || {}
  switch (tool) {
    case 'shell':
      return runShell(str(args.cmd), str(args.cwd) || homedir())
    case 'read_file':
      return readFileTool(str(args.path))
    case 'write_file':
      return writeFileTool(str(args.path), str(args.content))
    case 'list_dir':
      return listDirTool(str(args.path) || homedir())
    case 'clipboard_read':
      return clipboardRead()
    case 'clipboard_write':
      return clipboardWrite(str(args.text))
    default:
      return { ok: false, output: '', error: `未知工具: ${tool}` }
  }
}
