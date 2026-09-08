// Live2DBackground — 手机沉浸 Live2D 的全屏角色背景
// 固定在 layout 之后（z-0），聊天区透明露出角色；角色放入圆角卡片（有边界更舒服），
// 底部预留浮空输入卡片空间。
import { useEffect, useRef, useState } from "react";
import { useSite } from "../lib/site";
import {
  attach,
  detach,
  getState,
  loadModel,
  setLive2dVerticalCenter,
  subscribe,
  type Live2dCoreState,
} from "../lib/live2dCore";
import { resolveLive2dModel } from "../lib/live2d";
import { Live2DLoading } from "./Live2DLoading";

export function Live2DBackground() {
  const { settings, loaded } = useSite();
  const ref = useRef<HTMLDivElement>(null);
  const [core, setCore] = useState<Live2dCoreState>(() => getState());

  useEffect(() => {
    const unsub = subscribe(() => setCore(getState()));
    return unsub;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.offsetParent === null) return; // 桌面 lg:hidden 不初始化
    // 手机沉浸全屏：角色垂直居中（避免顶到导航栏/不居中）
    setLive2dVerticalCenter(true);
    attach(el);
    const s = getState();
    if (s.status === "idle" || s.status === "error") {
      loadModel(resolveLive2dModel(settings.live2d_model)).catch(() => {});
    }
    return () => {
      setLive2dVerticalCenter(false);
      detach(el);
    };
  }, [settings.live2d_model]);

  const retry = () => {
    loadModel(resolveLive2dModel(settings.live2d_model)).catch(() => {});
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-0 animate-[kfade_0.4s_ease-out] bg-gray-100 lg:hidden dark:bg-gray-900">
      {/* 手机沉浸：Live2D 全屏放大展示（角色适配整个屏幕，无卡片边界更大气） */}
      {/* 打字机加载层：模型就绪后仍保留，直到站点设置加载完成再取消（避免站点未加载完就闪掉加载动画） */}
      <div ref={ref} className="absolute inset-0">
        {core.status === "error" ? (
          /* 加载失败：不再无限显示“正在召唤角色”，给出柔和提示 + 重试 */
          <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 animate-[kfade_0.2s_ease-out] bg-gray-50/95 dark:bg-gray-900/95">
            <p className="text-sm text-gray-400 dark:text-gray-500">
              角色加载失败
            </p>
            <button
              onClick={retry}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              点击重试
            </button>
          </div>
        ) : core.status !== "ready" || !loaded ? (
          <Live2DLoading text="正在召唤角色…" />
        ) : null}
      </div>
    </div>
  );
}
