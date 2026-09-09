import { Minus, Square, X } from 'lucide-react'

/**
 * 自绘标题栏（桌面端）：无边框窗口 + 拖拽区 + 窗口控制按钮。
 * 借鉴 Cherry Studio 等 Electron 客户端的常见做法（-webkit-app-region）。
 * 视觉：左侧品牌区（发光圆点 + 字标 + 副标题），右侧统一尺寸的窗口按钮，
 * 拖拽区不含按钮区域；亮暗色分别使用与下方内容衔接的中性底色 + 发丝分隔线。
 */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-gray-200/60 bg-gray-100/80 pl-3.5 pr-0 dark:border-gray-800/80 dark:bg-[#0b0e15]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 品牌：渐变圆点 + Lumia 字标 + 副标题 */}
      <span className="relative grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] bg-gradient-to-br from-gray-800 to-gray-600 shadow-sm dark:from-gray-100 dark:to-gray-400">
        <span className="h-1.5 w-1.5 rounded-full bg-white/90 dark:bg-gray-900/80" />
      </span>
      <span className="text-xs font-semibold tracking-wide text-gray-700 dark:text-gray-200">
        Lumia
      </span>
      <span className="hidden text-[10px] font-normal tracking-wide text-gray-400 sm:inline dark:text-gray-500">
        Agent Desktop
      </span>
      <span className="mx-1 hidden h-3.5 w-px bg-gray-200 sm:block dark:bg-gray-700/80" />
      <span className="hidden truncate text-[10px] text-gray-400/90 md:block dark:text-gray-500/80">
        AI Agent · 浏览 · 知识库 · 编辑器
      </span>
      <div
        className="ml-auto flex h-full items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          aria-label="最小化"
          title="最小化"
          className="grid h-full w-11 place-content-center text-gray-400 transition-colors hover:bg-gray-200/80 hover:text-gray-700 active:bg-gray-300/60 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          onClick={() => window.api?.windowControl('minimize')}
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>
        <button
          aria-label="最大化"
          title="最大化/还原"
          className="grid h-full w-11 place-content-center text-gray-400 transition-colors hover:bg-gray-200/80 hover:text-gray-700 active:bg-gray-300/60 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          onClick={() => window.api?.windowControl('maximize')}
        >
          <Square size={12} strokeWidth={1.8} />
        </button>
        <button
          aria-label="关闭"
          title="关闭"
          className="grid h-full w-11 place-content-center text-gray-400 transition-colors hover:bg-red-500 hover:text-white active:bg-red-600 dark:text-gray-500 dark:hover:bg-red-500 dark:hover:text-white"
          onClick={() => window.api?.windowControl('close')}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
