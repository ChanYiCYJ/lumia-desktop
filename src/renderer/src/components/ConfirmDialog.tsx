import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 友好确认弹窗（数据操作保护）：替代 window.confirm，带标题/说明/危险样式。
 * 复用 DataModal 弹窗视觉（createPortal + backdrop + 圆角面板 + 确认/取消）。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[97] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-sm rounded-3xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="p-5">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          {message && (
            <p className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              {message}
            </p>
          )}
          {children}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium text-white transition ${
              danger
                ? "bg-red-500 hover:bg-red-600"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
