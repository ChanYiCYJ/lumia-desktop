// Live2D 加载占位 —— 恢复为站点的打字机加载动画（TypeWriter + $ loading ...），用户偏好原版
// 关键：加载/切换角色时带覆盖背景，完全盖住底下（旧角色淡出、画面残留不会露出，不突兀）
import { TypeWriter } from "./Spinner";

export function Live2DLoading({ text = "正在加载角色…" }: { text?: string }) {
  return (
    <div className="absolute inset-0 z-20 flex animate-[kfade_0.2s_ease-out] flex-col items-center justify-center gap-2 bg-gray-50/95 dark:bg-gray-900/95">
      <TypeWriter
        text={text}
        loop
        className="text-sm text-gray-500 dark:text-gray-400"
      />
      <p className="font-mono text-[10px] text-gray-300 dark:text-gray-600">
        $ loading ...
      </p>
    </div>
  );
}
