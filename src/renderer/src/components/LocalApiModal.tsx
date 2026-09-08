import { createPortal } from "react-dom";
import { LocalApiForm } from "./LocalApiForm";

interface LocalApiModalProps {
  open: boolean;
  onClose: () => void;
  pageId: number;
  botName: string;
  onSaved: () => void;
}

export function LocalApiModal({
  open,
  onClose,
  pageId,
  botName,
  onSaved,
}: LocalApiModalProps) {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-3xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            自定义模型 · {botName}
          </h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
            aria-label="关闭"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-3 p-4">
          <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
            <span className="font-medium">安全与使用规则</span>
          </p>
          <ul className="ml-5 list-disc space-y-1 rounded-xl bg-gray-50 p-3 text-xs leading-relaxed text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            <li>
              API Key 与提示词<b>仅保存在本机浏览器</b>
              （localStorage），不会上传服务器，请勿在公共电脑保存。
            </li>
            <li>
              接口需为 <b>OpenAI 兼容格式</b>
              （/v1/chat/completions），留空则使用站点默认配置。
            </li>
            <li>
              使用自定义 API 后，将<b>自动解除</b>
              默认的次数与冷却限制；请遵守所用服务的使用条款与当地法律。
            </li>
            <li>自定义提示词会覆盖默认人设，仅影响当前机器人、当前浏览器。</li>
          </ul>
          <LocalApiForm
            pageId={pageId}
            variant="modal"
            onSaved={() => {
              onSaved();
              onClose();
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
