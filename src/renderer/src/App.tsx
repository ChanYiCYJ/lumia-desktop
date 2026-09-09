import { Component, type ErrorInfo, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { SiteProvider } from './lib/site'
import { ToastProvider } from './lib/toast'
import { AICenter } from './pages/AICenter'
import { TitleBar } from './components/TitleBar'

/**
 * 顶层错误边界：任何渲染/生命周期异常时显示错误卡片而非整窗空白。
 * TitleBar 在边界之外，顶栏不会被卸载；错误详情同时经 console.error
 * 落入主进程诊断日志（<userData>/logs/boot.log）。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[lumia] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-white p-6 dark:bg-gray-900">
          <div className="w-full max-w-lg rounded-2xl border border-red-200 bg-red-50/60 p-5 text-left dark:border-red-900/60 dark:bg-red-900/10">
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">界面渲染出错了</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              请把下方信息发给开发者（已同时记录到 用户数据目录/logs/boot.log）：
            </p>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/70 p-3 text-[11px] leading-relaxed text-red-700 dark:bg-gray-900/50 dark:text-red-300">
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-3 rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Lumia Desktop：仅保留 Agent 中心（/ai），其余一律重定向
// 用 HashRouter（#/ai）：打包版从 file:// 加载，BrowserRouter 的 history API
// 在 file:// + asar + Windows（Electron 39.8.x）下路由静默失效 → 界面只有顶栏、内容区空白。
// HashRouter 不依赖 history API，dev/预览/打包/windows 行为一致。
export default function App() {
  return (
    <HashRouter>
      <div className="flex h-screen flex-col overflow-hidden">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <AuthProvider>
            <SiteProvider>
              <ToastProvider>
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Navigate to="/ai" replace />} />
                    <Route path="/ai" element={<AICenter />} />
                    <Route path="/ai/:botId" element={<AICenter />} />
                    <Route path="*" element={<Navigate to="/ai" replace />} />
                  </Routes>
                </ErrorBoundary>
              </ToastProvider>
            </SiteProvider>
          </AuthProvider>
        </div>
      </div>
    </HashRouter>
  )
}
