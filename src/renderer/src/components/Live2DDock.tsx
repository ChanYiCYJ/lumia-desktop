// Live2DDock — 移动端悬浮迷你 Live2D（边聊天边看，带滑入动画）
// 仅在手机布局（lg:hidden）且 Agent 面板关闭时显示；点开进入 Agent 面板 Live2D tab。
// 与 Agent 面板共享 live2dCore 单例：本 dock 挂载时 attach 画布，卸载/面板打开时 detach。
import { useEffect, useRef, useState } from "react";
import { useSite } from "../lib/site";
import {
  attach,
  detach,
  getState,
  loadModel,
  subscribe,
  type Live2dCoreState,
} from "../lib/live2dCore";
import { characterNameOf, resolveLive2dModel } from "../lib/live2d";

const BIG_KEY = "kimo_live2d_big";
function loadBig(): boolean {
  try {
    return localStorage.getItem(BIG_KEY) === "1";
  } catch {
    return false;
  }
}
function saveBig(v: boolean): void {
  try {
    localStorage.setItem(BIG_KEY, v ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

export function Live2DDock({
  onOpen,
  onClose,
}: {
  onOpen: () => void;
  onClose: () => void;
}) {
  const { settings } = useSite();
  const containerRef = useRef<HTMLDivElement>(null);
  const [core, setCore] = useState<Live2dCoreState>(() => getState());
  const [big, setBig] = useState(loadBig);

  const toggleBig = () => {
    setBig((v) => {
      saveBig(!v);
      return !v;
    });
  };

  // 与 Agent 面板共享表情/加载状态
  useEffect(() => {
    const unsub = subscribe(() => setCore(getState()));
    return unsub;
  }, []);

  // 挂载时 attach 画布（单例 canvas re-parent）；卸载时 detach
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.offsetParent === null) return; // 隐藏实例（桌面 lg:hidden）不初始化
    attach(el);
    const s = getState();
    if (s.status === "idle" || s.status === "error") {
      loadModel(resolveLive2dModel(settings.live2d_model)).catch(() => {});
    }
    return () => detach(el);
  }, [settings.live2d_model]);

  return (
    <div
      className={
        "fixed z-40 lg:hidden " +
        (big
          ? "left-1/2 bottom-[150px] -translate-x-1/2"
          : "bottom-[150px] right-3")
      }
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        aria-label="打开 Live2D 面板"
        className={
          "relative animate-[kslideUp_0.35s_ease-out] cursor-pointer overflow-hidden rounded-2xl border border-gray-200 bg-white/90 shadow-lg backdrop-blur transition hover:scale-[1.02] active:scale-95 dark:border-gray-700 dark:bg-gray-900/90 " +
          (big ? "h-[26rem] w-[min(20rem,calc(100vw-1.5rem))]" : "h-32 w-24")
        }
        title="点开查看 Live2D"
      >
        <div ref={containerRef} className="h-full w-full">
          {core.status !== "ready" && (
            <div className="absolute inset-0 grid place-items-center">
              <span className="font-mono text-[10px] text-gray-400">
                $ 加载中…
              </span>
            </div>
          )}
        </div>
        {core.status === "ready" && (
          <span
            className={
              "pointer-events-none absolute inset-x-0 truncate px-1 text-center text-gray-500 dark:text-gray-400 " +
              (big ? "bottom-2 text-xs" : "bottom-0.5 text-[9px]")
            }
          >
            {characterNameOf(core.modelName)}
          </span>
        )}
      </div>
      {/* 大窗 / 小窗切换 */}
      <button
        onClick={toggleBig}
        aria-label={big ? "缩小 Live2D 窗口" : "放大 Live2D 大窗口"}
        title={big ? "缩小" : "大窗口"}
        className="absolute -left-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm transition hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
      >
        {big ? (
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"
            />
          </svg>
        ) : (
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8V5a2 2 0 012-2h3m10 0h3a2 2 0 012 2v3m0 10v3a2 2 0 01-2 2h-3m-10 0H5a2 2 0 01-2-2v-3"
            />
          </svg>
        )}
      </button>
      {/* 关闭（等价于「/」弹窗的 Live2D 开关） */}
      <button
        onClick={onClose}
        aria-label="关闭 Live2D"
        className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm transition hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
