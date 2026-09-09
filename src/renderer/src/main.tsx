import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './lib/theme'
import { aiChat } from './lib/ai'
import { getCachedLandingRoute } from './lib/site'
import { enableSecureStorage, migrateLocalSecrets } from './lib/secureStorage'
import './index.css'
import App from './App'

/* ── 启动错误显形（Windows 白屏排查用）────────────────────────────
 * 白屏多为「背景已画但 JS 没跑/抛错」，把未捕获错误直接红字显示在窗口里，
 * 避免"全白却无任何报错"。仅启动后 15s 内生效，正常运行时静默。
 */
const BOOT_GUARD_MS = 15_000
const bootAt = Date.now()
let bootErrorShown = false
function showBootError(err: unknown): void {
  if (bootErrorShown || Date.now() - bootAt > BOOT_GUARD_MS) return
  bootErrorShown = true
  console.error('[boot]', err)
  try {
    const text = err instanceof Error ? err.stack || err.message : String(err)
    let el = document.getElementById('boot-error') as HTMLDivElement | null
    if (!el) {
      el = document.createElement('div')
      el.id = 'boot-error'
      el.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#fff;color:#c0392b;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:18px;overflow:auto;'
      document.body?.appendChild(el)
    }
    el.style.display = 'block'
    el.textContent = 'Lumia Desktop 启动失败，请把下面内容发给开发者：\n\n' + text
  } catch {
    /* 兜底失败也忽略 */
  }
}
window.addEventListener('error', (e) => {
  if (e && e.error) showBootError(e.error)
})
window.addEventListener('unhandledrejection', (e) => showBootError(e.reason))

// 桌面端：API Key/Token 透明加密（safeStorage），先注入再迁移
enableSecureStorage()
migrateLocalSecrets()
// 诊断：preload 桥是否生效（false → 安全存储/本地搜索/TTS/Live2D 均静默降级）
console.log('[lumia] native bridge:', typeof window.api !== 'undefined' && !!window.api)

// 暴露给自定义 HTML 页面的全局 AI 接口
;(window as unknown as Record<string, unknown>).kimoAI = {
  chat: async (msg: string, system?: string) => aiChat(msg, system)
}

// 落地页即时跳转：用本地缓存的 route_map/default_route 同步决定首页去向，
// 在 React 挂载前改写 URL，避免每次访问都先显示"加载中"再重定向到落地页。
// 首次访问（无缓存）时跳过，由 Layout 等待设置加载后正常跳转。
const landingRoute = getCachedLandingRoute(window.location.hostname)
if (landingRoute && landingRoute !== '/' && window.location.pathname === '/') {
  window.history.replaceState(null, '', landingRoute)
}

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
} catch (err) {
  showBootError(err)
}
