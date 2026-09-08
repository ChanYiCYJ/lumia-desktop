import { Minus, Square, X } from 'lucide-react'

/**
 * 自绘标题栏（桌面端）：无边框窗口 + 拖拽区 + 窗口控制按钮。
 * 借鉴 Cherry Studio 等 Electron 客户端的常见做法（-webkit-app-region）。
 */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 select-none items-center border-b border-gray-200/70 bg-gray-100/90 pl-3 dark:border-gray-800 dark:bg-gray-950/90"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="text-xs font-semibold tracking-wide text-gray-600 dark:text-gray-400">
        Lumia
      </span>
      <span className="ml-2 text-[11px] text-gray-400 dark:text-gray-600">Agent Desktop</span>
      <div
        className="ml-auto flex h-full items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          aria-label="最小化"
          title="最小化"
          className="grid h-full w-11 place-content-center text-gray-500 transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-800"
          onClick={() => window.api?.windowControl('minimize')}
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>
        <button
          aria-label="最大化"
          title="最大化/还原"
          className="grid h-full w-11 place-content-center text-gray-500 transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-800"
          onClick={() => window.api?.windowControl('maximize')}
        >
          <Square size={12} strokeWidth={1.8} />
        </button>
        <button
          aria-label="关闭"
          title="关闭"
          className="grid h-full w-11 place-content-center text-gray-500 transition-colors hover:bg-red-500 hover:text-white dark:text-gray-400 dark:hover:bg-red-500 dark:hover:text-white"
          onClick={() => window.api?.windowControl('close')}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
