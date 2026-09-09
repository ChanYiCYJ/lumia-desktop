/**
 * 启动诊断：把渲染进程 console / 加载失败 / 进程崩溃 / React 挂载状态
 * 写到 <userData>/logs/boot.log，白屏时提供真实运行时证据。
 * 背景：Windows 上窗口能开但内容全白，且与 GPU 无关（v0.1.3 + --disable-gpu 依旧白屏）
 * —— 需要真实错误定位，不能继续盲改。ponytail: 日志只是诊断通道，定位后即可精简。
 */
import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

let logFile: string | null = null

/** 追加一行启动日志（失败不影响启动） */
export function logBoot(line: string): void {
  try {
    if (!logFile) {
      const dir = join(app.getPath('userData'), 'logs')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      logFile = join(dir, 'boot.log')
      appendFileSync(logFile, `\n===== ${new Date().toISOString()} =====\n`)
    }
    appendFileSync(logFile, `${line}\n`)
  } catch {
    /* 日志写失败不应阻塞启动 */
  }
}

/** 在窗口创建后调用：给窗口挂渲染诊断监听 */
export function enableRendererDiag(win: BrowserWindow): void {
  const wc = win.webContents

  win.once('ready-to-show', () =>
    logBoot('[win] ready-to-show（已出现首帧，若内容白屏则看下方 renderer 记录）')
  )

  // renderer console（兼容新式 details 单参 / 旧式 5 参两种签名）
  wc.on('console-message', ((...args: unknown[]) => {
    const first = args[0] as { message?: unknown; level?: unknown } | undefined
    let message = ''
    let level = 'log'
    if (first && typeof first === 'object' && 'message' in first) {
      message = typeof first.message === 'string' ? first.message : JSON.stringify(first.message)
      level = typeof first.level === 'string' ? first.level : level
    } else if (typeof args[2] === 'string') {
      message = args[2] // 旧式 (event, level, message, line, sourceId)
      level = String(args[1] ?? 'log')
    }
    logBoot(`[renderer:${level}] ${message}`)
  }) as unknown as (event: Electron.Event, ...rest: unknown[]) => void)

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) logBoot(`[did-fail-load] ${code} ${desc} ${url}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    logBoot(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  wc.on('did-finish-load', () => {
    logBoot(`[did-finish-load] ${wc.getURL()}`)
    probeRoot(wc)
  })
}

/** 页面加载后轮询探测 React 是否真的挂载（根节点有无内容），区分「白屏但 JS 没跑」 */
function probeRoot(wc: Electron.WebContents): void {
  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    wc.executeJavaScript(
      `(() => { const r = document.getElementById('root'); return { html: r ? r.innerHTML.length : -1, bodyText: (document.body.innerText || '').length, children: document.body ? document.body.children.length : -1, nativeApi: typeof window.api !== 'undefined' && !!window.api } })()`,
      true
    )
      .then((v) => {
        const s = v as { html: number; bodyText: number; children: number; nativeApi: boolean }
        if (s.html > 0 || s.bodyText > 0 || tries > 12) {
          clearInterval(timer)
          logBoot(
            s.html > 0 || s.bodyText > 0
              ? `[probe] root.html=${s.html} bodyText=${s.bodyText} children=${s.children} nativeApi=${s.nativeApi} → React 已挂载 ✅`
              : `[probe] root.html=${s.html} bodyText=${s.bodyText} children=${s.children} nativeApi=${s.nativeApi} → 根节点仍为空（白屏！见上方 [renderer:*] 错误）`
          )
        } else {
          logBoot(
            `[probe] ${tries}/8 root.html=${s.html} bodyText=${s.bodyText} nativeApi=${s.nativeApi}（等待挂载…）`
          )
        }
      })
      .catch((err) => {
        clearInterval(timer)
        logBoot(`[probe] executeJavaScript 失败: ${String(err)}（渲染进程可能已崩溃/未就绪）`)
      })
  }, 800)
}
