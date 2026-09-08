import type { ReactNode } from "react";

type BadgeTone = "violet" | "gray" | "blue" | "green" | "amber" | "red";

const TONES: Record<BadgeTone, string> = {
  violet:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30",
  gray: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
  blue: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30",
  green:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30",
  amber:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  red: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30",
};

export function Badge({
  children,
  tone = "violet",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      {icon && (
        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-gray-100 text-gray-400 dark:bg-gray-800">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium text-gray-700 dark:text-gray-300">
        {title}
      </h3>
      {description && (
        <p className="max-w-xs text-sm text-gray-400 dark:text-gray-500">
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl bg-gray-200/70 dark:bg-gray-800 ${className}`}
    />
  );
}

/* ===== 后台/通用共享设计 token（对齐 AI 前端精修风） ===== */

/** 主按钮（黑底白字；暗色下反转为浅色，与 AI 前端一致） */
export const btnPrimary =
  "flex items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 active:scale-[0.98] disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300";

/** 幽灵按钮（细边框灰字） */
export const ghostBtn =
  "flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800";

/** 输入框统一样式 */
export const inputCls =
  "w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-gray-400 focus:ring-2 focus:ring-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:placeholder:text-gray-500";

/** 列表操作小按钮（蓝 / 红 文字按钮） */
export const rowBtn = "rounded-lg px-3 py-1.5 text-xs font-medium transition";

/** 列表操作带边框按钮 */
export const rowBtnBorder =
  "rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800";

/** 后台页头：标题 + 副标题 + 右侧主操作按钮 */
export function PageHeader({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          {title}
        </h2>
        {desc && (
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {desc}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Notion「N」logo（官方品牌图标，用于替代 📓 emoji） */
export function NotionIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zM3.01 3.754l15.16-1.31c.56-.047.886.047.793.56L15.213 22.28c-.093.513-.373.652-.793.606L4.552 21.03c-.42-.047-.606-.233-.653-.653l-.934-16.074c-.047-.373.047-.606.045-.549z" />
    </svg>
  );
}

/** 圆角卡片（对齐 AI 前端：细边框 + 无阴影轻质感；暗色自动） */
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div className={`card ${hover ? "card-hover" : ""} ${className}`}>
      {children}
    </div>
  );
}

/** 行式开关（对齐 SettingsTab 的 h-5 w-9 紧凑开关） */
export function Switch({
  on,
  onChange,
  label,
  sub,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 py-1.5 text-left"
      role="switch"
      aria-checked={on}
    >
      {(label || sub) && (
        <span className="min-w-0">
          {label && (
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {label}
            </span>
          )}
          {sub && (
            <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
              {sub}
            </span>
          )}
        </span>
      )}
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          on ? "bg-gray-900 dark:bg-gray-200" : "bg-gray-300 dark:bg-gray-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}
