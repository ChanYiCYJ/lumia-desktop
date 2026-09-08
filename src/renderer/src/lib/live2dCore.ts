// ===== Live2D Agent — 单例控制器（唯一 PIXI 实例）=====
// 职责：
//  - 动态注入 Cubism2 运行时（/lib/live2dcubismcore.min.js + /lib/live2d.min.js）
//  - 动态 import pixi.js + pixi-live2d-display/cubism2（避免把 ~1MB 打进主 bundle）
//  - 持有唯一 PIXI.Application + Live2DModel；canvas 可 re-parent 到不同容器
//  - 表情平滑过渡（easeInOutCubic 插值 setParamFloat）+ 自动复位（借鉴 SoulLink）
//  - 纹理 404 探测 → 透明 PNG 兜底（防破图）
// AgentPanel 桌面 + 移动双实例时，靠「最后 attach 的容器」获得 canvas（只有一个 PIXI app）。

import {
  EMOTION_MOTIONS,
  EMOTION_PRESETS,
  buildLive2dSettings,
  fetchBuildData,
  fetchThirdPartyModelSafe,
  parseActionCommands,
  pickTapReaction,
  resolveHitRegion,
  smoothMouth,
  fluxToMouthWidth,
  lowRatioToMouthRound,
  rmsToMouthScale,
  analyzeSpeechBreaks,
  analyzeFrequencyBands,
  bandEnergiesToMouthParams,
  adaptiveRmsGain,
  LOOK_TARGETS,
  type Emotion,
  type LookDirection,
  type SpeechBreak,
} from "./live2d";
// 低性能设备检测：用于降分辨率/限帧率/流式期间暂停渲染等降级策略
import { isLowPerfDevice } from "./perf";

export type Live2dStatus = "idle" | "loading" | "ready" | "error";

export interface Live2dCoreState {
  status: Live2dStatus;
  error?: string;
  emotion: Emotion;
  modelName: string;
}

const RUNTIME_SCRIPTS = ["/lib/live2dcubismcore.min.js", "/lib/live2d.min.js"];

const TRANSPARENT_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p7fJ4sAAAAASUVORK5CYII=";

// ---- 模块级单例状态 ----
let app: any = null; // PIXI.Application
let model: any = null; // Live2DModel
let canvas: HTMLCanvasElement | null = null;
let attachedEl: HTMLElement | null = null;
let engineCache: { PIXI: any; Live2DModel: any } | null = null;
let runtimePromise: Promise<void> | null = null;
let state: Live2dCoreState = {
  status: "idle",
  emotion: "neutral",
  modelName: "",
};
const listeners = new Set<() => void>();
let animationId = 0;
let resetTimer: number | null = null;
let ro: ResizeObserver | null = null;
/** 低性能设备（进程内缓存）：创建 PIXI 时决定分辨率/抗锯齿/帧率降级 */
let lowPerf = false;
/** 主线程繁忙（AI 流式生成）时的渲染暂停标记 */
let busy = false;
/** 当前模型真实存在的表情参数集合（getParamIndex 探测），null=未探测 */
let availableParams: Set<string> | null = null;
/** 当前模型自带动作名集合（settings.motions 的 key） */
let motionNames: Set<string> | null = null;
/** 当前模型基础（未缩放）尺寸：model.width 会随 scale 变化，直接用它算缩放会反馈漂移 */
let modelBaseW = 1;
let modelBaseH = 1; /** 模型本地边界顶部偏移（loadModel 时缓存一次——拖拽中模型播动作会改变 getLocalBounds，若每帧重算会让 model.y 跳动导致“一闪一闪”） */
let baseTopOffset = 0;
/** 角色垂直居中模式（手机沉浸全屏用）：默认顶部对齐（dock/面板防裁头），沉浸时垂直居中避免顶到导航栏 */
let centerVertically = false;
/** 设置垂直居中模式（手机沉浸背景挂载时开启、卸载时复位），强制重新 fit */
export function setLive2dVerticalCenter(v: boolean): void {
  if (centerVertically === v) return;
  centerVertically = v;
  lastFitW = 0;
  lastFitH = 0;
  scheduleFit();
}
/** 上次 fit 的画布尺寸（尺寸未变时跳过，减少拖拽中每帧无谓 resize/闪烁） */
let lastFitW = 0;
let lastFitH = 0; /** 角色切换淡入动画 id */
let fadeId = 0;
/** 正在淡出（等待销毁）的旧模型——切换角色交叉淡化，避免瞬间消失的突兀空窗 */
let fadingModel: any = null;
/** 眨眼 / 随机小动作（让角色更"活"，不像木偶） */
let blinkTimer: number | null = null;
let ambientTimer: number | null = null;
let blinkId = 0;
/** 上次情绪表达时间（ambient 给情绪让位） */
let lastEmotionAt = 0;
/** 表情防抖：记录上次 setEmotion 调用的名称与时间，防止流式回复中频繁切换导致表情抽搐 */
let lastSetEmotionName = "" as string;
let lastSetEmotionTime = 0;
/** 上次 ambient 播的动作（避免连续重复） */
let lastAmbientMotion = "";
/** 强情绪连播第二个动作的定时器（换情绪/卸载时清理） */
let sequenceTimer: number | null = null;
/**
 * 动作优先级（pixi-live2d-display MotionPriority：IDLE=1 / NORMAL=2 / FORCE=3）。
 * 情绪与 AI 动作指令用 FORCE（永不被 ambient 打断）；ambient 随机小动作用 NORMAL
 * （让位给情绪）——避免"点一下角色，眨眼小动作把情绪动作顶掉"的抢播。
 */
const MOTION_PRIORITY_NORMAL = 2;
const MOTION_PRIORITY_FORCE = 3;

function setState(patch: Partial<Live2dCoreState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function getState(): Live2dCoreState {
  return state;
}

/**
 * 触发订阅者通知（不改 state）：供「角色档案生成完成」等外部事件强制刷新订阅组件
 * （如 LoreDetail 需要重新读 loadLore 显示新档案）。
 */
export function emitLive2dState(): void {
  listeners.forEach((fn) => fn());
}
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- 运行时注入 ----
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-live2d-src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.live2dSrc = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Live2D 运行时加载失败: ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureRuntime(): Promise<void> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    for (const src of RUNTIME_SCRIPTS) {
      await loadScript(src);
    }
  })();
  return runtimePromise;
}

async function ensureEngine(): Promise<{ PIXI: any; Live2DModel: any }> {
  if (engineCache) return engineCache;
  await ensureRuntime();
  const PIXI: any = await import("pixi.js");
  // pixi-live2d-display 依赖 window.PIXI 全局
  (window as any).PIXI = PIXI;
  // 注意：默认入口（index，含 cubism2+cubism4）当前在线上渲染为空白（双运行时注册被
  // 树摇/注册时序影响），bestdori 全部为 Cubism2 .moc，故固定用 cubism2 子路径（稳定渲染）。
  // Cubism3/4 加载链路（buildLive2dSettingsFromModel3/fetchThirdPartyModelSafe）已就绪，
  // 待 index bundle 渲染问题解决后可切回：import("pixi-live2d-display")
  const mod: any = await import("pixi-live2d-display/cubism2");
  engineCache = { PIXI, Live2DModel: mod.Live2DModel };
  return engineCache;
}

// ---- 工具 ----
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function canLoadImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function getCoreModel(): any {
  return model?.internalModel?.coreModel || null;
}

// ---- 尺寸适配（rAF 防抖 + 尺寸钳制，避免拖动面板时渲染异常）----
let fitPending = false;
function scheduleFit(): void {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    fitModel();
  });
}

function fitModel(): void {
  if (!app || !model || !attachedEl) return;
  const w = attachedEl.clientWidth;
  const h = attachedEl.clientHeight;
  // 拖动/收起瞬间容器可能为 0 或极小，跳过以免画布/模型异常
  if (!w || !h || w < 24 || h < 24) return;
  // 尺寸未变则跳过（拖拽中避免每帧无谓 resize/闪烁）
  if (w === lastFitW && h === lastFitH) return;
  lastFitW = w;
  lastFitH = h;
  try {
    app.renderer.resize(w, h);
  } catch {}
  if (canvas) {
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  const mw0 = modelBaseW || 1;
  const mh0 = modelBaseH || 1;
  let mw = mw0;
  let mh = mh0;
  // 基础（未缩放）尺寸异常时（如模型刚就绪 internalModel 尺寸未暴露 → 回落为 1），
  // 用当前显示尺寸反推真实基础尺寸，避免缩放算出微小模型导致"空白"。
  if (mw < 10 || mh < 10) {
    try {
      const sx = model.scale?.x || 1;
      const sy = model.scale?.y || 1;
      if (model.width && model.width > 10 && sx > 0) mw = model.width / sx;
      if (model.height && model.height > 10 && sy > 0) mh = model.height / sy;
      if (mw > 10 && mh > 10) {
        modelBaseW = mw;
        modelBaseH = mh;
      }
    } catch {}
  }
  let s = Math.min(w / mw, h / mh) * 0.88;
  if (!Number.isFinite(s) || s <= 0) s = 1;
  // 只保留上限钳制（防极小容器比例爆炸）；不要设下限——大纹理模型在窄面板下计算出的
  // 合理缩放会 <0.2，强行抬到 0.2 会让角色超出容器被裁（电脑版"生硬/有极限"根因）
  if (s > 3) s = 3;
  model.scale.set(s, s);
  // 水平居中
  model.x = w / 2;
  if (centerVertically) {
    // 手机沉浸全屏：角色主体略偏上居中——底部空间留给浮空对话卡片，
    // 长回复限高滚动时不再遮挡角色脸部/上半身（底部腿部可被卡片覆盖）
    model.y = h * 0.42 - baseTopOffset * s;
  } else {
    // 默认：让角色可见区顶部留 ~5% 边距（Live2D 角色头部常贴近画布顶，
    // 垂直居中会在小窗如手机 dock 裁头——故 dock/面板用顶部对齐）
    const topMargin = Math.max(4, h * 0.05);
    model.y = topMargin + (mh * s) / 2 - baseTopOffset * s;
  }
  // 安全钳制：角色中心始终保持在画布内（防止拖拽/尺寸异常时角色被“拖到画布外”消失）
  const halfH = (mh * s) / 2;
  if (Number.isFinite(halfH) && halfH > 0) {
    const minCy = halfH * 0.4;
    const maxCy = h - halfH * 0.4;
    if (model.y < minCy) model.y = minCy;
    else if (model.y > maxCy) model.y = maxCy;
  }
}

/** 播放情感对应的模型自带动作（真实动作控制）；返回是否播了动作 */
function playEmotionMotion(emotion: Emotion): boolean {
  if (!model) return false;
  const names = motionNames;
  if (!names) return false;
  const candidates = (EMOTION_MOTIONS[emotion] || []).filter((n) =>
    names.has(n),
  );
  if (!candidates.length || typeof model.motion !== "function") return false;
  // 从可用动作里随机选一个：同一种情绪每次动作不同，避免"只会一个动作"
  const a = candidates[Math.floor(Math.random() * candidates.length)];
  // 强情绪连播第二个不同动作，更生动（neutral 不连播）
  let b: string | null = null;
  if (candidates.length > 1 && emotion !== "neutral") {
    let other = candidates[Math.floor(Math.random() * candidates.length)];
    if (other === a)
      other = candidates[(candidates.indexOf(a) + 1) % candidates.length];
    b = other;
  }
  try {
    // FORCE：情绪动作永不被 ambient（NORMAL）打断
    model.motion(a, 0, MOTION_PRIORITY_FORCE).catch(() => {});
    if (b) {
      if (sequenceTimer) clearTimeout(sequenceTimer);
      const target = b;
      sequenceTimer = window.setTimeout(() => {
        sequenceTimer = null;
        try {
          model?.motion(target, 0, MOTION_PRIORITY_FORCE).catch(() => {});
        } catch {}
      }, 500);
    }
    return true;
  } catch {
    return false;
  }
}

/** 表情（播放动作 + 参数微调 + 自动复位） */
export function setEmotion(emotion: Emotion): void {
  // 防抖保护：同情绪 500ms 内去重，不同情绪至少 200ms 间隔（防止流式回复中频繁切换导致表情抽搐）
  const now = Date.now();
  if (
    (emotion === lastSetEmotionName && now - lastSetEmotionTime < 500) ||
    (emotion !== lastSetEmotionName && now - lastSetEmotionTime < 200)
  ) {
    return;
  }
  lastSetEmotionName = emotion;
  lastSetEmotionTime = now;
  setState({ emotion });
  lastEmotionAt = now;
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
  const core = getCoreModel();
  playEmotionMotion(emotion);
  // 自动复位（thinking 持续到回复结束；wink/neutral 不复位）
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (emotion !== "neutral" && emotion !== "wink" && emotion !== "thinking") {
    resetTimer = window.setTimeout(() => {
      resetTimer = null;
      setEmotion("neutral");
    }, 3000);
  }
  if (!core) return; // 参数微调始终执行（配合动作让面部表情更明显，动作+表情叠加更灵动）
  const preset = EMOTION_PRESETS[emotion];
  const entries = Object.entries(preset.params);
  // 只对模型真实存在的参数做表情（防止 setParamFloat 静默失败）
  const params = availableParams;
  const targets = params ? entries.filter(([id]) => params.has(id)) : entries;
  if (targets.length === 0) return;
  const from: Record<string, number> = {};
  for (const [id] of targets) {
    try {
      const v = core.getParamFloat ? core.getParamFloat(id) : 0;
      from[id] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      from[id] = 0;
    }
  }
  const duration = Math.max(120, preset.duration);
  const start = performance.now();
  // Mouth form cross-fade: after speech ends, blend lipSync-neutral to emotion ~300ms
  const lipEnd = lastLipSyncEnd;
  const mouthW =
    lipEnd && Date.now() - lipEnd < 300
      ? Math.min(1, (Date.now() - lipEnd) / 300)
      : 1;
  if (animationId) cancelAnimationFrame(animationId);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const k = easeInOutCubic(t);
    for (const [id, to] of targets) {
      // 朗读（lipSync 驱动）中：所有嘴部参数（开合 + 嘴型）由 lipSync 接管，表情不覆盖——
      // 否则 happy 的 ParamMouthForm=0.8 微笑嘴型会盖过张嘴（视觉“微笑、嘴巴没张开”）
      if (lipSyncActive && MOUTH_LIP_PARAMS.includes(id)) continue;
      const fromV = from[id] ?? 0;
      try {
        const w = MOUTH_LIP_PARAMS.includes(id) ? mouthW : 1;
        core.setParamFloat(id, fromV + (to - fromV) * k * w);
      } catch {}
    }
    if (t < 1) {
      animationId = requestAnimationFrame(step);
    } else {
      animationId = 0;
    }
  };
  animationId = requestAnimationFrame(step);
}

export function randomEmotion(): Emotion {
  const list: Emotion[] = [
    "happy",
    "sad",
    "angry",
    "surprised",
    "shy",
    "thinking",
    "sleepy",
    "wink",
  ];
  return list[Math.floor(Math.random() * list.length)];
}

// ---- 模型加载 ----
export async function loadModel(name: string): Promise<void> {
  const clean = (name || "").trim();
  if (!clean) return;
  if (state.status === "loading") return; // 防并发重复
  if (state.status === "ready" && state.modelName === clean) return; // 幂等
  setState({ status: "loading", error: undefined, modelName: clean });
  availableParams = null;
  motionNames = null;
  stopAmbient();
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
  modelBaseW = 1;
  modelBaseH = 1;
  try {
    const { PIXI, Live2DModel } = await ensureEngine();
    // 第三方 model.json/model3.json 网址 → 走第三方加载；否则 bestdori 模型名
    const settings = /^https?:\/\//i.test(clean)
      ? await fetchThirdPartyModelSafe(clean)
      : buildLive2dSettings(clean, await fetchBuildData(clean));

    // 纹理 404 探测 → 透明 PNG 兜底（防破图）
    const checks = await Promise.all(
      (settings.textures || []).map((u) => canLoadImage(u)),
    );
    let firstValid = TRANSPARENT_PNG_DATA_URL;
    const idx = checks.findIndex(Boolean);
    if (idx >= 0) firstValid = settings.textures[idx];
    settings.textures = (settings.textures || []).map((u, i) =>
      checks[i] ? u : firstValid,
    );

    if (!app) {
      canvas = document.createElement("canvas");
      // 用当前容器尺寸初始化，避免 PIXI 默认 800×600 撑爆窄容器（配合容器 min-w-0/overflow-hidden）
      const cw = attachedEl ? Math.max(1, attachedEl.clientWidth) : 1;
      const ch = attachedEl ? Math.max(1, attachedEl.clientHeight) : 1;
      // 低性能设备降级：分辨率固定 1x（不跟随 devicePixelRatio）+ 关闭抗锯齿，显著降低 GPU/CPU 负载
      lowPerf = isLowPerfDevice();
      app = new PIXI.Application({
        view: canvas,
        transparent: true,
        antialias: !lowPerf,
        autoStart: true,
        // 关键：必须与 pixi-live2d-display 的 Live2DModel.update（内部注册在
        // PIXI.Ticker.shared）共用同一 ticker。否则渲染跑在独立的 app.ticker 上，
        // 与 Ticker.shared 是两个各自 rAF 的循环——每帧交替执行，渲染经常读到
        // 「模型 idle 刚把口型置 0、lipSync 还没来得及设值」的中间态 → 口型闪烁
        // （实测 draw 探针相邻帧跳变最大 0.634，朗读时嘴大幅抖动）。
        // sharedTicker 后同一循环内顺序固定：render(读上一帧 lipSync 值)→模型
        // update→lipSync(设新值)，渲染始终读到平滑连续的口型值。
        sharedTicker: true,
        width: cw,
        height: ch,
        resolution: lowPerf
          ? 1
          : Math.min(
              Math.max(1, window.devicePixelRatio || 1),
              // 沉浸全屏（centerVertically）钳制 ≤1.5 减 GPU 负载；其余 ≤2x（Retina 足够）
              centerVertically ? 1.5 : 2,
            ),
        autoDensity: true,
      });
      app.stage.sortableChildren = true;
      // 低性能设备限制渲染帧率（30fps 对角色展示足够，减半 GPU 负载）
      if (lowPerf && app.ticker && typeof app.ticker.maxFPS === "number") {
        app.ticker.maxFPS = 30;
      }
      if (attachedEl) attachedEl.appendChild(canvas);
    }

    // 旧模型淡出（不“啪”地消失），新模型就绪后再淡入 → 交叉淡化，无突兀空窗
    fadeOutOldModel();
    const m = await Live2DModel.from(settings);
    model = m;
    // 新模型未 hook 过 internalModel.update：下次朗读时重新 hook（旧模型的 hook 随其销毁失效）
    lipSyncUpdateHooked = false;
    // 记录基础（未缩放）尺寸：model.width 会随 scale 变化，用它算缩放会产生反馈漂移（拖拽占比出错根因）
    modelBaseW = m.internalModel?.width || m.width || 1;
    modelBaseH = m.internalModel?.height || m.height || 1;
    try {
      m.autoInteract = false;
      m.interactive = false;
    } catch {}
    m.anchor.set(0.5, 0.5);
    // 切换角色/重载时重置用户拖拽旋转（新模型姿态从 0 开始）
    userRot = 0;
    try {
      m.rotation = 0;
    } catch {}
    // 缓存模型本地边界顶部偏移（拖拽中动作变形不再导致 model.y 跳动闪烁）
    try {
      const b = m.getLocalBounds ? m.getLocalBounds() : null;
      if (b && Number.isFinite(b.top)) baseTopOffset = b.top || 0;
    } catch {
      baseTopOffset = 0;
    }
    lastFitW = 0; // 强制下次 fit 执行（新模型按新尺寸适配）
    lastFitH = 0;
    // 先置透明再加入舞台：避免 addChild 到 fadeModelIn 首帧之间 PIXI 渲染一帧不透明角色（加载完成后闪一下）
    try {
      m.alpha = 0;
    } catch {}
    app.stage.addChild(m);
    // 角色切换/首次加载淡入（不生硬）
    fadeModelIn(m);

    // 禁用自动空闲动作：否则空闲动画每帧覆盖表情参数，表情看不出变化
    try {
      const mm = m?.internalModel?.motionManager;
      if (mm) {
        mm.stopAllMotions?.();
        if (mm.groups) mm.groups.idle = undefined;
      }
    } catch {}
    // 探测模型真实存在的表情参数（Cubism2 getParamIndex），表情只作用于存在的参数
    try {
      const core = m?.internalModel?.coreModel;
      if (core && typeof core.getParamIndex === "function") {
        const set = new Set<string>();
        for (const p of Object.values(EMOTION_PRESETS)) {
          for (const id of Object.keys(p.params)) {
            try {
              if (core.getParamIndex(id) >= 0) set.add(id);
            } catch {}
          }
        }
        availableParams = set;
      }
    } catch {}

    // 记录模型自带动作名（用于情感→动作播放的真实控制）
    motionNames = new Set(Object.keys(settings.motions));
    // 后台预取常用动作文件（降低首次播放动作的网络延迟；低性能设备跳过）
    prefetchMotions(settings, motionNames);
    // 预取表情文件（如有），降低首次切换表情的网络延迟
    prefetchExpressions(settings);

    scheduleFit();
    setState({ status: "ready", error: undefined, modelName: clean });
    startAmbient();
    if (state.emotion !== "neutral") setEmotion(state.emotion);
  } catch (e) {
    setState({
      status: "error",
      error: e instanceof Error ? e.message : "模型加载失败",
    });
  }
}

// ---- 让角色更"活"：眨眼 + 随机小动作（情绪表达中自动让位）----
const AMBIENT_MOTIONS = [
  "idle01",
  "idle02",
  "idle03",
  "nod01",
  "nod02",
  "eeto01",
  "jaan01",
  "wink01",
  "wink02",
  "niyaniya01",
  "smile01",
  "sing01",
  "bye01",
  "shame01",
  "shame02",
  "look01",
  "look02",
];

function startAmbient(): void {
  if (blinkTimer) clearTimeout(blinkTimer);
  if (ambientTimer) clearTimeout(ambientTimer);
  const scheduleBlink = () => {
    blinkTimer = window.setTimeout(
      () => {
        blinkTimer = null;
        blink();
        scheduleBlink();
      },
      2000 + Math.random() * 4000,
    );
  };
  const scheduleMove = () => {
    ambientTimer = window.setTimeout(
      () => {
        ambientTimer = null;
        playAmbientMotion();
        scheduleMove();
      },
      3000 + Math.random() * 4000, // 3~7s 一个随机小动作，更活泼灵动
    );
  };
  scheduleBlink();
  scheduleMove();
}

function stopAmbient(): void {
  if (blinkTimer) clearTimeout(blinkTimer);
  if (ambientTimer) clearTimeout(ambientTimer);
  blinkTimer = null;
  ambientTimer = null;
  if (blinkId) cancelAnimationFrame(blinkId);
  blinkId = 0;
}

// ---- 说话模式环境动画（朗读期间保留眨眼+身体微动，不让角色"死站着"）----
let speakBlinkTimer: number | null = null;
let speakSwayId = 0;

function startSpeakingAmbient(): void {
  // 说话期间眨眼继续（保持角色灵动，不像木偶）
  const scheduleBlink = () => {
    speakBlinkTimer = window.setTimeout(
      () => {
        speakBlinkTimer = null;
        blink();
        scheduleBlink();
      },
      2000 + Math.random() * 4000,
    );
  };
  scheduleBlink();
  // 身体微摇摆：模拟真人说话时重心微调（±2° ParamBodyAngleZ，~3s 周期）
  startSpeakingSway();
}

function stopSpeakingAmbient(): void {
  if (speakBlinkTimer) clearTimeout(speakBlinkTimer);
  speakBlinkTimer = null;
  stopSpeakingSway();
}

function startSpeakingSway(): void {
  if (speakSwayId) cancelAnimationFrame(speakSwayId);
  const core = getCoreModel();
  if (!core) return;
  // 借鉴官方 Cubism2InternalModel.updateNaturalMovements：呼吸+多角度正弦联动
  const hasBreath = paramExists(core, "ParamBreath");
  const hasAngleX = paramExists(core, "ParamAngleX");
  const hasAngleY = paramExists(core, "ParamAngleY");
  const hasAngleZ = paramExists(core, "ParamAngleZ");
  const hasBodyX = paramExists(core, "ParamBodyAngleX");
  if (!hasBreath && !hasAngleX && !hasAngleY && !hasAngleZ && !hasBodyX) return;
  // Randomized phase offsets +-20% amplitude jitter per session (not robotic)
  const px = Math.random() * Math.PI * 2;
  const py = Math.random() * Math.PI * 2;
  const pz = Math.random() * Math.PI * 2;
  const pb = Math.random() * Math.PI * 2;
  const pr = Math.random() * Math.PI * 2;
  const aj = 0.8 + Math.random() * 0.4;
  const start = performance.now();
  const step = (now: number) => {
    if (!lipSyncActive) {
      speakSwayId = 0;
      if (hasAngleX)
        try {
          core.setParamFloat("ParamAngleX", 0);
        } catch {}
      if (hasAngleY)
        try {
          core.setParamFloat("ParamAngleY", 0);
        } catch {}
      if (hasAngleZ)
        try {
          core.setParamFloat("ParamAngleZ", 0);
        } catch {}
      if (hasBodyX)
        try {
          core.setParamFloat("ParamBodyAngleX", 0);
        } catch {}
      if (hasBreath)
        try {
          core.setParamFloat("ParamBreath", 0.5);
        } catch {}
      return;
    }
    const t = ((now - start) / 1000) * 2 * Math.PI;
    const a = 0.7 * aj;
    if (hasAngleX)
      try {
        core.setParamFloat("ParamAngleX", 15 * Math.sin(t / 6.53 + px) * a);
      } catch {}
    if (hasAngleY)
      try {
        core.setParamFloat("ParamAngleY", 8 * Math.sin(t / 3.53 + py) * a);
      } catch {}
    if (hasAngleZ)
      try {
        core.setParamFloat("ParamAngleZ", 10 * Math.sin(t / 5.53 + pz) * a);
      } catch {}
    if (hasBodyX)
      try {
        core.setParamFloat("ParamBodyAngleX", 4 * Math.sin(t / 15.53 + pb) * a);
      } catch {}
    if (hasBreath)
      try {
        core.setParamFloat("ParamBreath", 0.5 + 0.5 * Math.sin(t / 3.23 + pr));
      } catch {}
    speakSwayId = requestAnimationFrame(step);
  };
  speakSwayId = requestAnimationFrame(step);
}

function stopSpeakingSway(): void {
  if (speakSwayId) cancelAnimationFrame(speakSwayId);
  speakSwayId = 0;
  const core = getCoreModel();
  if (!core) return;
  if (paramExists(core, "ParamAngleX"))
    try {
      core.setParamFloat("ParamAngleX", 0);
    } catch {}
  if (paramExists(core, "ParamAngleY"))
    try {
      core.setParamFloat("ParamAngleY", 0);
    } catch {}
  if (paramExists(core, "ParamAngleZ"))
    try {
      core.setParamFloat("ParamAngleZ", 0);
    } catch {}
  if (paramExists(core, "ParamBodyAngleX"))
    try {
      core.setParamFloat("ParamBodyAngleX", 0);
    } catch {}
  if (paramExists(core, "ParamBreath"))
    try {
      core.setParamFloat("ParamBreath", 0.5);
    } catch {}
}

/** 快速眨眼（ParamEyeLOpen/ParamEyeROpen），仿官方 Live2DEyeBlink 状态机：
 *  Idle(2-6s)→Closing(100ms)→Closed(50ms)→Opening(150ms)→Idle */
function blink(): void {
  if (!attachedEl) return;
  const core = getCoreModel();
  if (!core || !availableParams) return;
  const hasL = availableParams.has("ParamEyeLOpen");
  const hasR = availableParams.has("ParamEyeROpen");
  if (!hasL && !hasR) return;
  const getV = (id: string): number => {
    try {
      const v = core.getParamFloat ? core.getParamFloat(id) : 1;
      return typeof v === "number" && Number.isFinite(v) ? v : 1;
    } catch {
      return 1;
    }
  };
  const fromL = hasL ? getV("ParamEyeLOpen") : 1;
  const fromR = hasR ? getV("ParamEyeROpen") : 1;
  const CLOSE = 100,
    SHUT = 50,
    OPEN = 150;
  const total = CLOSE + SHUT + OPEN;
  const start = performance.now();
  if (blinkId) cancelAnimationFrame(blinkId);
  const step = (now: number) => {
    const el = Math.min(total, now - start);
    let v: number;
    if (el < CLOSE) {
      v = 1 - el / CLOSE;
    } else if (el < CLOSE + SHUT) {
      v = 0;
    } else {
      v = (el - CLOSE - SHUT) / OPEN;
    }
    if (hasL) {
      try {
        core.setParamFloat("ParamEyeLOpen", fromL * v);
      } catch {}
    }
    if (hasR) {
      try {
        core.setParamFloat("ParamEyeROpen", fromR * v);
      } catch {}
    }
    if (el < total) blinkId = requestAnimationFrame(step);
    else blinkId = 0;
  };
  blinkId = requestAnimationFrame(step);
}

/** 情绪空闲时随机播一个小动作（让角色不像木偶） */
function playAmbientMotion(): void {
  if (!attachedEl || !model) return;
  const names = motionNames;
  if (!names) return;
  if (state.emotion !== "neutral") return; // 情绪表达中不打扰
  if (Date.now() - lastEmotionAt < 2500) return; // 情绪刚复位，给点安静
  const pool = AMBIENT_MOTIONS.filter((n) => names.has(n));
  if (!pool.length) return;
  // 避免连续两次同一个动作（看起来只会一个动作）
  let name = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && name === lastAmbientMotion) {
    name = pool[(pool.indexOf(name) + 1) % pool.length];
  }
  lastAmbientMotion = name;
  try {
    // NORMAL：ambient 小动作让位给情绪（FORCE）与 AI 指令（FORCE）
    model.motion(name, 0, MOTION_PRIORITY_NORMAL).catch(() => {});
  } catch {}
}

/**
 * 预取常用动作文件（后台预热浏览器缓存，降低首次播放动作的网络延迟）。
 * 只预取「情绪/环境会用到的」动作；低性能设备跳过（省流量与带宽）。
 */
function prefetchMotions(settings: any, names: Set<string> | null): void {
  try {
    if (!settings?.motions || lowPerf) return;
    const want = new Set<string>();
    for (const arr of Object.values(EMOTION_MOTIONS)) {
      for (const n of arr) want.add(n);
    }
    for (const n of AMBIENT_MOTIONS) want.add(n);
    const urls: string[] = [];
    for (const n of want) {
      if (!names || names.has(n)) {
        const f = settings.motions[n]?.[0]?.file;
        if (f && /^https?:\/\//i.test(f)) urls.push(f);
      }
    }
    // 并发 2 条，逐条 fetch 预热 HTTP 缓存（no-cors 只入缓存不影响功能；失败静默）
    let i = 0;
    const next = () => {
      if (i >= urls.length) return;
      const u = urls[i++];
      try {
        fetch(u, { mode: "no-cors" })
          .catch(() => {})
          .finally(next);
      } catch {
        next();
      }
    };
    for (let k = 0; k < 2 && k < urls.length; k++) next();
  } catch {
    /* 预取失败不影响模型 */
  }
}

/**
 * 预取表情文件（后台预热浏览器缓存，降低首次切换表情的网络延迟）。
 */
function prefetchExpressions(settings: any): void {
  try {
    const exps: { name: string; file: string }[] = settings?.expressions || [];
    if (!exps.length || lowPerf) return;
    let i = 0;
    const next = () => {
      if (i >= exps.length) return;
      const url = exps[i++].file;
      try {
        fetch(url, { mode: "no-cors" })
          .catch(() => {})
          .finally(next);
      } catch {
        next();
      }
    };
    for (let k = 0; k < 2 && k < exps.length; k++) next();
  } catch {
    /* 预取失败不影响模型 */
  }
}

/** 旧模型平滑淡出后销毁（切换角色/重载不突兀）；新模型淡入时两者交叉淡化 */
function fadeOutOldModel(): void {
  if (fadingModel) {
    try {
      app?.stage?.removeChild(fadingModel);
      fadingModel.destroy({ texture: false, baseTexture: false });
    } catch {}
    fadingModel = null;
  }
  if (!model) return;
  const oldM = model;
  model = null; // 先摘引用，避免淡出期间被误用/二次销毁
  fadingModel = oldM;
  const start = performance.now();
  const DURATION = 240;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION);
    try {
      oldM.alpha = Math.max(0, 1 - t);
    } catch {}
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      try {
        app?.stage?.removeChild(oldM);
        oldM.destroy({ texture: false, baseTexture: false });
      } catch {}
      if (fadingModel === oldM) fadingModel = null;
    }
  };
  requestAnimationFrame(step);
}

/** 角色切换/首次加载淡入（alpha 0→1，不生硬） */
function fadeModelIn(m: any): void {
  if (fadeId) cancelAnimationFrame(fadeId);
  const start = performance.now();
  const DURATION = 340;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION);
    const k = 1 - Math.pow(1 - t, 3); // easeOutCubic
    try {
      m.alpha = k;
    } catch {}
    if (t < 1) fadeId = requestAnimationFrame(step);
    else fadeId = 0;
  };
  fadeId = requestAnimationFrame(step);
}

// ---- 渲染循环集中控制：页面不可见 / 无容器 / 主线程忙时停 ticker（性能优化）----
// 原先 PIXI ticker 常驻全帧率渲染（切后台/收起面板仍在跑），这里统一收敛：
// ticker 仅在「有 attach 容器 + 页面可见 + 未 busy」时运行。
let documentVisible = true;
let visibilityBound = false;

function syncTicker(): void {
  if (!app?.ticker) return;
  const run = !!attachedEl && documentVisible && !busy;
  try {
    if (run) app.ticker.start();
    else app.ticker.stop();
  } catch {}
}

/** 绑定页面可见性监听（一次即可）：切后台停渲染/动画，回前台恢复 */
function bindVisibility(): void {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    documentVisible = document.visibilityState !== "hidden";
    if (documentVisible) {
      if (attachedEl) {
        startAmbient();
        startGaze();
      }
    } else {
      stopAmbient();
      stopGaze();
    }
    syncTicker();
  });
}

// ---- 点击/触摸交互：命中反应 + 拖拽旋转（参考 pixi-live2d-display hit-testing 与 live2d-widget drag）----
// 不依赖 pixi 的 autoInteract（其 auto-focus 会驱动眼睛注视，与既有 blink/gaze 冲突），
// 改为在 attach 容器上自绑 pointer 事件：
//   - 点按（位移 < 阈值）= tap → 按角色包围盒上下分头/身 → 播反应动作 + 表情
//   - 拖动（位移 ≥ 阈值）= drag → model.rotation 跟随（±MAX_USER_ROT），松开缓动回正
// 桌面鼠标与手机触摸都走 PointerEvent（两端都启用，符合用户确认）。

const TAP_DRAG_THRESHOLD_PX = 8;
/** 拖拽旋转上限（弧度，±25°），避免转得离谱 */
const MAX_USER_ROT = (25 * Math.PI) / 180;
let userRot = 0;
let userRotAnimId = 0;
let pointerActive = false;
let pointerMoved = false;
let pointerStartX = 0;
let pointerStartY = 0;
let lastHitAt = 0;
/** 交互防抖：两次命中反应的最小间隔（ms），防连点刷屏 */
const HIT_DEBOUNCE_MS = 1200;

function onPointerDown(e: PointerEvent): void {
  if (!attachedEl || !model) return;
  pointerActive = true;
  pointerMoved = false;
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  if (userRotAnimId) cancelAnimationFrame(userRotAnimId);
  userRotAnimId = 0;
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerActive || !model) return;
  const dx = e.clientX - pointerStartX;
  const dy = e.clientY - pointerStartY;
  const dist = Math.hypot(dx, dy);
  if (!pointerMoved) {
    if (dist < TAP_DRAG_THRESHOLD_PX) return;
    pointerMoved = true; // 超过阈值 → 判定为拖拽（不再算 tap）
  }
  userRot = Math.max(-MAX_USER_ROT, Math.min(MAX_USER_ROT, dx * 0.008));
  try {
    model.rotation = userRot;
  } catch {}
}

function onPointerUp(e: PointerEvent): void {
  if (!pointerActive) return;
  pointerActive = false;
  const wasTap = !pointerMoved;
  pointerMoved = false;
  if (wasTap) {
    handleTap(e.clientX, e.clientY);
  }
  easeRotBack();
}

/** 点按命中：按角色包围盒分头/身 → 反应动作 + 表情（防连点） */
function handleTap(clientX: number, clientY: number): void {
  if (!attachedEl || !model) return;
  const now = performance.now();
  if (now - lastHitAt < HIT_DEBOUNCE_MS) return;
  lastHitAt = now;
  const r = attachedEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // 逻辑坐标 == CSS 像素（autoDensity）；model.x/y 即画布内中心
  const px = clientX - r.left;
  const py = clientY - r.top;
  const s = model.scale?.x ?? 1;
  const region = resolveHitRegion(
    px,
    py,
    model.x,
    model.y,
    modelBaseW * s,
    modelBaseH * s,
  );
  if (!region) return;
  const reaction = pickTapReaction(region);
  // setEmotion 会播放对应情绪动作（EMOTION_MOTIONS）——与 TAP_REACTIONS 动作一致，
  // 直接复用避免重复播动作；参数表情叠加由 setEmotion 内部完成。
  setEmotion(reaction.emotion);
}

/** 松开后把旋转缓动回正（spring 感，控制权还给动作播放） */
function easeRotBack(): void {
  if (userRotAnimId) cancelAnimationFrame(userRotAnimId);
  const from = userRot;
  if (Math.abs(from) < 0.001) return;
  const start = performance.now();
  const DURATION = 500;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION);
    const k = 1 - Math.pow(1 - t, 3); // easeOutCubic
    userRot = from * (1 - k);
    try {
      if (model) model.rotation = userRot;
    } catch {}
    if (t < 1) userRotAnimId = requestAnimationFrame(step);
    else userRotAnimId = 0;
  };
  userRotAnimId = requestAnimationFrame(step);
}

function setupInteraction(): void {
  if (!attachedEl) return;
  attachedEl.addEventListener("pointerdown", onPointerDown);
  attachedEl.addEventListener("pointermove", onPointerMove);
  attachedEl.addEventListener("pointerup", onPointerUp);
  attachedEl.addEventListener("pointercancel", onPointerUp);
}

function teardownInteraction(): void {
  if (!attachedEl) return;
  attachedEl.removeEventListener("pointerdown", onPointerDown);
  attachedEl.removeEventListener("pointermove", onPointerMove);
  attachedEl.removeEventListener("pointerup", onPointerUp);
  attachedEl.removeEventListener("pointercancel", onPointerUp);
  pointerActive = false;
  if (userRotAnimId) cancelAnimationFrame(userRotAnimId);
  userRotAnimId = 0;
}

// ---- 挂载 / 卸载 ----
export function attach(container: HTMLElement): void {
  attachedEl = container;
  if (canvas) {
    try {
      container.appendChild(canvas);
    } catch {}
  }
  scheduleFit();
  if (!ro && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => scheduleFit());
    ro.observe(container);
  }
  bindVisibility();
  setupInteraction();
  startAmbient();
  startGaze();
  syncTicker(); // 有容器 + 可见 + 未 busy → 恢复渲染
}

export function detach(container: HTMLElement): void {
  if (attachedEl === container) attachedEl = null;
  if (canvas && canvas.parentElement === container) {
    try {
      container.removeChild(canvas);
    } catch {}
  }
  stopAmbient();
  stopGaze();
  teardownInteraction();
  syncTicker(); // 无 attach 容器 → 停 PIXI 渲染，避免白耗 GPU
}

/**
 * 主线程繁忙降级（低性能设备在 AI 流式生成期间调用）：
 * 暂停 PIXI 渲染循环与 ambient 小动作，把主线程让给 React 重渲染；结束后恢复。
 * 非低性能设备帧率/分辨率足够，一般不调用，调用也无害。
 */
export function setLive2dBusy(v: boolean): void {
  if (busy === v) return;
  busy = v;
  if (!app) return;
  if (v) {
    stopAmbient();
  } else if (documentVisible && attachedEl) {
    startAmbient();
  }
  syncTicker();
}

export function dispose(): void {
  if (ro) {
    try {
      ro.disconnect();
    } catch {}
    ro = null;
  }
  stopAmbient();
  if (animationId) cancelAnimationFrame(animationId);
  if (fadeId) cancelAnimationFrame(fadeId);
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
  if (resetTimer) clearTimeout(resetTimer);
  if (fadingModel) {
    try {
      app?.stage?.removeChild(fadingModel);
      fadingModel.destroy();
    } catch {}
    fadingModel = null;
  }
  if (model) {
    try {
      model.destroy();
    } catch {}
    model = null;
  }
  if (app) {
    try {
      app.destroy(true, { children: true, texture: true, baseTexture: true });
    } catch {}
    app = null;
  }
  if (canvas) {
    canvas = null;
  }
  stopSpeaking();
  stopSpeakingAmbient();
  stopGaze();
  teardownInteraction();
  // 清理音频口型资源（AudioContext/Audio 元素）
  audioEl = null;
  audioAnalyser = null;
  audioEndedCb = null;
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {}
    audioCtx = null;
  }
  if (cmdAnimId) cancelAnimationFrame(cmdAnimId);
  cmdAnimId = 0;
  if (lookAnimId) cancelAnimationFrame(lookAnimId);
  lookAnimId = 0;
  attachedEl = null;
  setState({ status: "idle", emotion: "neutral", modelName: "" });
}

// ---- AI 动作指令执行（[PARAM:…] / [MOTION:…] / [EXPRESSION:…]）----
// 解析由 live2d.ts 的 parseActionCommands 完成；这里只负责执行：
//   参数 → 平滑插值（独立 cmdAnimId，与表情动画互不打断）
//   动作 → 播模型自带动作（存在才播）
//   表情预设 → 切换（模型有才切）

let cmdAnimId = 0;
/** [LOOK:] 头部视线动画 id（结束时回正） */
let lookAnimId = 0;

function paramExists(core: any, id: string): boolean {
  try {
    return (
      typeof core.getParamIndex === "function" && core.getParamIndex(id) >= 0
    );
  } catch {
    return false;
  }
}

/** 执行 AI 回复里的动作指令（参数/动作/表情预设），无指令则什么都不做 */
export function applyActionCommands(text: string): void {
  const cmds = parseActionCommands(text);
  if (!cmds.params.length && !cmds.motion && !cmds.expression && !cmds.look)
    return;
  // 动作：只播模型真实存在的动作（FORCE 优先级，不被 ambient 打断）
  if (cmds.motion && motionNames?.has(cmds.motion) && model?.motion) {
    try {
      model.motion(cmds.motion, 0, MOTION_PRIORITY_FORCE).catch(() => {});
    } catch {}
  }
  // 表情预设：pixi-live2d-display 的 model.expression(name)
  if (cmds.expression && typeof model?.expression === "function") {
    try {
      model.expression(cmds.expression).catch(() => {});
    } catch {}
  }
  // 视线：驱动 ParamAngleX/Y 短时转头/点头（不打断动作；结束后回正）
  if (cmds.look) {
    applyLook(cmds.look);
  }
  // 参数：平滑插值到目标值（只作用于真实存在的参数）
  const core = getCoreModel();
  if (!core || !cmds.params.length) return;
  const targets = cmds.params.filter((p) => paramExists(core, p.id));
  if (!targets.length) return;
  const from: Record<string, number> = {};
  for (const p of targets) {
    try {
      const v = core.getParamFloat ? core.getParamFloat(p.id) : 0;
      from[p.id] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      from[p.id] = 0;
    }
  }
  const duration = 420;
  const start = performance.now();
  if (cmdAnimId) cancelAnimationFrame(cmdAnimId);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const k = easeInOutCubic(t);
    for (const p of targets) {
      const f = from[p.id] ?? 0;
      try {
        core.setParamFloat(p.id, f + (p.value - f) * k);
      } catch {}
    }
    if (t < 1) cmdAnimId = requestAnimationFrame(step);
    else cmdAnimId = 0;
  };
  cmdAnimId = requestAnimationFrame(step);
}

/** 视线指令执行：ParamAngleX/Y 平滑转到位 → 保持 ~900ms → 缓动回正（不打断动作/表情） */
function applyLook(dir: LookDirection): void {
  const core = getCoreModel();
  if (!core) return;
  const hasX = paramExists(core, "ParamAngleX");
  const hasY = paramExists(core, "ParamAngleY");
  if (!hasX && !hasY) return;
  const target = LOOK_TARGETS[dir] || LOOK_TARGETS.center;
  if (lookAnimId) cancelAnimationFrame(lookAnimId);
  const EASE = 260;
  const HOLD = 900;
  const BACK = 360;
  const read = (id: string): number => {
    try {
      const v = core.getParamFloat ? core.getParamFloat(id) : 0;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };
  const fromX = hasX ? read("ParamAngleX") : 0;
  const fromY = hasY ? read("ParamAngleY") : 0;
  const start = performance.now();
  const step = (now: number) => {
    const el = now - start;
    // 阶段一：ease 到目标；阶段二：保持；阶段三：回正
    let x = fromX;
    let y = fromY;
    if (el < EASE) {
      const k = easeInOutCubic(el / EASE);
      x = fromX + (target.x - fromX) * k;
      y = fromY + (target.y - fromY) * k;
    } else if (el < EASE + HOLD) {
      x = target.x;
      y = target.y;
    } else if (el < EASE + HOLD + BACK) {
      const k = easeInOutCubic((el - EASE - HOLD) / BACK);
      x = target.x * (1 - k);
      y = target.y * (1 - k);
    } else {
      lookAnimId = 0;
      x = 0;
      y = 0;
    }
    if (hasX) {
      try {
        core.setParamFloat("ParamAngleX", x);
      } catch {}
    }
    if (hasY) {
      try {
        core.setParamFloat("ParamAngleY", y);
      } catch {}
    }
    if (lookAnimId !== 0) lookAnimId = requestAnimationFrame(step);
  };
  lookAnimId = requestAnimationFrame(step);
}

// ---- 口型同步（真实音频波形驱动 ParamMouthOpenY）----
// 仅音频 TTS 模式（speakAudio 用 Web Audio AnalyserNode 的 RMS 波形驱动）；浏览器语音已移除。

let lipSyncId = 0;
/**
 * 口型驱动参数候选：不同模型命名不同——
 *  标准 Cubism2 示例：ParamMouthOpenY；邦邦/商业模型：PARAM_MOUTH_OPEN_Y（大写命名才是实际驱动嘴的）。
 * 驱动时对「模型存在」的候选参数都设值，兼容各模型命名。
 */
const MOUTH_PARAMS: readonly string[] = [
  "ParamMouthOpenY",
  "PARAM_MOUTH_OPEN_Y",
];

/** 朗读（lipSync）期间表情/动作不应控制的嘴部参数：开合 + 嘴型。
 *  实测发现邦邦模型还有 PARAM_MOUTH_FORM_01 等嘴型参数会被表情动作锁定（=1），
 *  即使 PARAM_MOUTH_OPEN_Y 张开，视觉嘴仍呈微笑/特定嘴型“嘴巴没张开”。
 *  朗读时必须由 lipSync 接管所有嘴部参数（开合由波形驱动、嘴型归零中性）。 */
const MOUTH_LIP_PARAMS: readonly string[] = [
  "ParamMouthOpenY",
  "PARAM_MOUTH_OPEN_Y",
  "ParamMouthForm",
  "PARAM_MOUTH_FORM_01",
  "PARAM_MOUTH_FORM_02",
  "PARAM_MOUTH_SCALE",
  "PARAM_MOUTH_FORM",
  "PARAM_MOUTH_OPEN",
];

/** 朗读时把所有非开合的嘴部参数（嘴型等）归零（中性），
 *  让 PARAM_MOUTH_OPEN_Y 的开合真正驱动视觉嘴（不被微笑/嘴型锁定盖过） */
function resetMouthFormNeutral(core: any): void {
  for (const p of MOUTH_LIP_PARAMS) {
    // 开合参数由 lipSync 设波形值，不归零
    if (p === "ParamMouthOpenY" || p === "PARAM_MOUTH_OPEN_Y") continue;
    try {
      if (paramExists(core, p)) core.setParamFloat(p, 0);
    } catch {}
  }
}

/** 返回模型上实际存在的口型参数（至少一个才认为可对口型） */
function getMouthParams(core: any): string[] {
  const list: string[] = [];
  for (const p of MOUTH_PARAMS) {
    if (paramExists(core, p)) list.push(p);
  }
  return list;
}

/** 停止口型同步并复位嘴部 */
export function stopSpeaking(): void {
  if (lipSyncId) cancelAnimationFrame(lipSyncId);
  lipSyncId = 0;
  stopAudioLipSync();
  // 口型平滑回落（而非“啪”地归零），读完/停止更自然
  fadeMouthToZero();
  // 说话结束：恢复环境动作（眨眼/小动作），角色恢复“活”态
  stopSpeakingAmbient();
  startAmbient();
  lipSyncActive = false;
  lastLipSyncEnd = performance.now();
}

/**
 * 朗读即将开始前调用（playTTS/试听入口）：标记 lipSync 激活 + 口型进入准备态微张。
 * 让随后触发的表情动画不覆盖嘴部开合（lipSync 优先），避免「朗读第一时刻」口型被表情
 * 固定（EMOTION_PRESETS 里 happy/surprised/sleepy 带 ParamMouthOpenY，会锁嘴 3 秒）
 * 导致口型不加载/卡住。实际音频就绪后由 speakAudio/speakAudioBuffer 接管波形驱动。
 *
 * 注意：准备态用固定微张（PREP_MOUTH_OPEN=0.2），不做呼吸动画——避免用户误以为口型已开始同步。
 */
export function prepareSpeaking(): void {
  lipSyncActive = true;
  const core = getCoreModel();
  const mouthParams = core ? getMouthParams(core) : [];
  if (!mouthParams.length) return;
  mouthSmooth = PREP_MOUTH_OPEN;
  rmsSmooth = 0.05;
  const session = ++speakSession;
  addLipSyncToTicker(
    buildLipSyncStep(
      () => session === speakSession && lipSyncActive,
      core,
      mouthParams,
      () => null,
      () => null,
    ),
  );
}

// ---- 真实音频口型同步（Web Audio AnalyserNode 波形 RMS 驱动，参考官方 MotionSync 思路 + l2d 的 RMS 方案）----
// 拿「可播放的音频 URL」用波形实时驱动 ParamMouthOpenY，嘴部随真实声音节奏开合。
// 移动端注意：AudioContext 可能处于 suspended（自动播放限制），MediaElementSource 会把音频
// 路由到 Web Audio 图 → 上下文挂起 = 静音且无波形，故统一在用户手势时 resume。

let audioCtx: AudioContext | null = null;
let audioEl: HTMLAudioElement | null = null;
let audioBufferSrc: AudioBufferSourceNode | null = null;
let audioAnalyser: AnalyserNode | null = null;
let freqAnalyser: AnalyserNode | null = null;
let rmsHistory: number[] = [];
let cachedGain = 1.0;
let gainRefreshAt = 0;
let lipSyncAudioId = 0;
let audioEndedCb: (() => void) | null = null;
/** 是否正在朗读（lipSync 驱动中）：此时表情动画不覆盖嘴部开合参数，
 *  避免朗读开头嘴被表情锁定（如 happy 把 ParamMouthOpenY 固定 0.2 保持 3 秒）→ 口型不加载 */
let lipSyncActive = false;
let lastLipSyncEnd = 0;
/** 朗读会话 id：每次 speakAudio/speakAudioBuffer/prepareSpeaking 递增，
 *  用于旧 step 失效（快速连播/停止时旧准备态/波形 step 不覆盖新朗读） */
let speakSession = 0;
/** 口型关键帧（毫秒偏移 → mouth 值）；离线预生成，播放时按时间轴查表，朗读中不再实时生成 */
interface MouthKeyFrame {
  t: number;
  /** PARAM_MOUTH_OPEN_Y 张嘴幅度 */
  openY: number;
  /** PARAM_MOUTH_FORM_01 嘴型宽度（-0.6~0.6，正=宽/辅音，负=圆/元音） */
  width: number;
  /** PARAM_MOUTH_FORM_02 嘴型圆度（-0.4~0.5，正=圆/元音，负=扁/辅音） */
  round: number;
  /** PARAM_MOUTH_SCALE 嘴部缩放（0.9~1.15） */
  scale: number;
}
/** 当前播放的口型序列（decode 完成、播放前离线生成） */
let mouthSeq: MouthKeyFrame[] = [];
/** 序列播放起始（AudioContext.currentTime） */
let mouthSeqStart = 0;
/** 序列所属 AudioContext（查表用） */
let mouthSeqCtx: AudioContext | null = null;
/** 朗读中口型「说话态」最低开口（停顿/静音时的嘴型基线）。
 *  0.3=30% 开度在模型上仍是明显张嘴，但比说话低 → 口型在 0.3(停顿)↔0.9(说话)
 *  之间有明显起伏，体现“换气换词”的节奏感；朗读结束才回落 0 */
const LIP_SYNC_MIN_OPEN = 0.32;
/** 准备态（等待 TTS 就绪）嘴部固定微张值：比说话态低（0.2 vs 0.3），清晰传达"正在准备、尚未开始朗读"，
 *  不做呼吸动画避免误导用户以为口型已开始。 */
const PREP_MOUTH_OPEN = 0.2;
/** 嘴部平滑值（攻击快/释放慢，贴合音节且避免波形抖动造成口型闪烁） */
let mouthSmooth = 0;
/** RMS 短期平滑值（减波形瞬时抖动，让口型曲线更连贯自然） */
let rmsSmooth = 0;
/** 口型结束平滑回落动画 id（读完后自然闭嘴） */
let mouthFadeId = 0;
/** 口型驱动回调：挂到当前模型 internalModel.update 之后（motion/idle 覆盖参数后、
 *  绘制前设置口型 → 渲染必然读到 lipSync 值，不再被模型每帧重置成 0） */
let lipSyncHookRef: (() => void) | null = null;
/** 回退模式：注册在 PIXI.Ticker.shared / rAF 上的口型回调 */
let lipSyncTickerRef: (() => void) | null = null;
/** 当前模型 internalModel.update 是否已 hook（切换角色/重载时重置，对新模型重新 hook） */
let lipSyncUpdateHooked = false;

/**
 * 注册口型驱动回调。首选 hook 模型 internalModel.update：
 * pixi-live2d-display 每帧 _render 内部顺序为 internalModel.update（motion/expression
 * 会重置 ParamMouthOpenY→0）→ internalModel.draw（绘制）。在其 update 之后、draw 之前
 * 设置口型，绘制就读到最新值——这是「渲染读到 0 → 嘴不动/闪烁」的根治（无论渲染在哪个
 * ticker 循环都正确）。模型不可用时回退到 PIXI.Ticker.shared / rAF。
 */
function addLipSyncToTicker(fn: () => void): void {
  // hook 目标是 Live2DModel.internalModel（Cubism 模型）——pixi-live2d-display
  // 每帧 _render 里调用 its.update() 更新参数与 motion。注意不能拿 getCoreModel()
  // （= internalModel.coreModel）再取 .internalModel：那是 undefined，会导致永远
  // 回退到 Ticker.shared，口型设置被 motion 每帧覆盖为 0（嘴不动/闪烁的根因）。
  const im = model?.internalModel;
  if (im && typeof im.update === "function") {
    lipSyncHookRef = fn;
    if (!lipSyncUpdateHooked) {
      const orig = im.update;
      im.update = function (...args: unknown[]) {
        try {
          orig.apply(this, args);
        } catch {}
        try {
          lipSyncHookRef?.();
        } catch {}
      };
      lipSyncUpdateHooked = true;
    }
    lipSyncAudioId = 1; // 标记运行中
    return;
  }
  // 回退：注册到共享 ticker（与模型 update 同循环，lipSync 后注册后执行仍可被渲染读到）
  lipSyncTickerRef = fn;
  try {
    const T = (window as any).PIXI?.Ticker?.shared;
    if (T && typeof T.add === "function") {
      T.add(fn);
      lipSyncAudioId = 1; // 标记运行中（ticker 模式）
      return;
    }
  } catch {}
  // 无 PIXI ticker（如测试环境）用 rAF
  lipSyncAudioId = requestAnimationFrame(fn);
}

function removeLipSyncFromTicker(): void {
  lipSyncHookRef = null;
  if (lipSyncTickerRef) {
    try {
      const T = (window as any).PIXI?.Ticker?.shared;
      if (T && typeof T.remove === "function") T.remove(lipSyncTickerRef);
    } catch {}
    lipSyncTickerRef = null;
  }
  if (lipSyncAudioId && !lipSyncTickerRef && !lipSyncHookRef) {
    cancelAnimationFrame(lipSyncAudioId);
  }
  lipSyncAudioId = 0;
}

/** 确保 AudioContext 处于 running（移动端自动播放限制：手势后 resume，后续自动朗读才能出声） */
function ensureAudioCtxRunning(): void {
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

// 全局手势 hook：首次/每次交互都尝试 resume（无 AudioContext 时为 no-op，开销极小）
if (typeof window !== "undefined") {
  const hook = () => ensureAudioCtxRunning();
  window.addEventListener("pointerdown", hook);
  window.addEventListener("touchstart", hook);
  window.addEventListener("keydown", hook);
}

function stopAudioLipSync(): void {
  removeLipSyncFromTicker();
  if (audioEl) {
    try {
      audioEl.onended = null;
      audioEl.pause();
    } catch {}
  }
  if (audioBufferSrc) {
    try {
      audioBufferSrc.onended = null;
      audioBufferSrc.stop();
    } catch {}
    audioBufferSrc = null;
  }
  // 保留 audioCtx 供下次复用；仅断开分析器引用
  audioAnalyser = null;
  freqAnalyser = null;
  rmsHistory = [];
  cachedGain = 1.0;
  audioEndedCb = null;
  mouthSmooth = 0;
  // 清除预生成口型序列（下次朗读重新生成）
  mouthSeq = [];
  mouthSeqCtx = null;
}

/**
 * 构建口型驱动 step（注册到模型 internalModel.update 之后）。
 * 多维度驱动：RMS→张嘴幅度 + 频谱→嘴宽/圆度/缩放（独立平滑，避免统一速度的橡胶感）。
 * @param freqRef 可选频谱分析器（getByteFrequencyData），null=降级纯RMS模式
 */
function buildLipSyncStep(
  isActive: () => boolean,
  core: any,
  mouthParams: string[],
  analyserRef: () => AnalyserNode | null,
  freqRef: () => AnalyserNode | null,
): () => void {
  const data = new Uint8Array(512);
  const freqData = new Uint8Array(512);
  let widthSmooth = 0;
  let roundSmooth = 0;
  let scaleSmooth = 1.0;
  let stillSince = 0;
  return () => {
    if (!isActive()) {
      removeLipSyncFromTicker();
      return;
    }
    const analyser = analyserRef();
    if (!analyser) {
      // 准备态（音频未就绪/解码中）：固定微张 PREP_MOUTH_OPEN=0.2，不做呼吸动画。
      // 原因：呼吸动画（0.3↔0.42 正弦）会让用户误以为口型已开始同步，但实际音频尚未就绪
      // → 看到嘴在动却听不到声音/对不上 → "开头口型异常"。固定微张清晰传达"正在准备、尚未朗读"。
      if (mouthParams.length > 0) {
        mouthSmooth = PREP_MOUTH_OPEN;
        rmsSmooth = 0;
        for (const p of mouthParams) {
          try {
            core.setParamFloat(p, PREP_MOUTH_OPEN);
          } catch {}
        }
      }
      resetMouthFormNeutral(core);
      widthSmooth = 0;
      roundSmooth = 0;
      scaleSmooth = 1.0;
      return;
    }
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    if (mouthParams.length > 0) {
      // RMS history for adaptive gain (refresh every ~500ms)
      rmsHistory.push(rms);
      if (rmsHistory.length > 60) rmsHistory.shift();
      const now = performance.now();
      if (now - gainRefreshAt > 500 && rmsHistory.length >= 10) {
        cachedGain = adaptiveRmsGain(rmsHistory);
        gainRefreshAt = now;
      }
      // RMS 短期平滑：减波形瞬时抖动，同时快速跟随（0.5 原 0.65）让不同词幅度差异更明显
      rmsSmooth += (rms - rmsSmooth) * 0.5;
      const grms = Math.min(1, rmsSmooth * cachedGain);
      // hold=LIP_SYNC_MIN_OPEN：说话期间嘴巴最小保持张嘴（不闭合），随声音自然张合；
      // 不设 voiceStarted 等待——朗读一开始口型就是说话态，开头静音/轻声也保持张嘴，不再“闭合”
      mouthSmooth = smoothMouth(mouthSmooth, grms, { hold: LIP_SYNC_MIN_OPEN });
      // 朗读中保持「说话态」最低开口：静音/停顿也保持明显张嘴，杜绝「闭合」；朗读结束才回落 0
      if (mouthSmooth < LIP_SYNC_MIN_OPEN) mouthSmooth = LIP_SYNC_MIN_OPEN;
      for (const p of mouthParams) {
        try {
          core.setParamFloat(p, mouthSmooth);
        } catch {}
      }
    }

    // Spectrum -> mouth form (width/round/scale) with independent easing
    const freqA = freqRef();
    if (freqA) {
      freqA.getByteFrequencyData(freqData);
      const bands = analyzeFrequencyBands(
        freqData,
        audioCtx?.sampleRate || 44100,
      );
      const mp = bandEnergiesToMouthParams(bands, rmsSmooth * cachedGain);
      widthSmooth += (mp.width - widthSmooth) * 0.35;
      roundSmooth += (mp.round - roundSmooth) * 0.4;
      scaleSmooth += (mp.scale - scaleSmooth) * 0.15;
      setMouthFormParams(core, widthSmooth, roundSmooth, scaleSmooth);
    } else {
      // No spectrum: fall back to neutral mouth form
      resetMouthFormNeutral(core);
    }

    // Pause breath: subtle sine when mouth stays low >500ms
    if (mouthSmooth < 0.35) {
      if (stillSince === 0) stillSince = performance.now();
      const d = performance.now() - stillSince;
      if (d > 500 && mouthParams.length > 0) {
        const b = 0.03 * Math.sin((d / 2500) * 2 * Math.PI);
        for (const p of mouthParams) {
          try {
            core.setParamFloat(p, mouthSmooth + b);
          } catch {}
        }
      }
    } else {
      stillSince = 0;
    }
  };
}

/**
 * 离线分析 AudioBuffer 波形，预生成完整口型序列（20ms 一帧）。
 * 与实时 RMS 驱动同逻辑（rmsSmooth 平滑 + smoothMouth + 0.1 说话态下限），但**一次性在
 * 播放前算完** → 朗读时只按时间轴查表驱动，朗读中无「生成口型」过程、不会中途闭合。
 */
function buildMouthSequence(audioBuf: AudioBuffer): MouthKeyFrame[] {
  const sr = audioBuf.sampleRate;
  const ch = audioBuf.numberOfChannels > 0 ? audioBuf.getChannelData(0) : null;
  if (!ch || !sr) return [];
  const frameMs = 20;
  const frameLen = Math.max(1, Math.floor((sr * frameMs) / 1000));
  const seq: MouthKeyFrame[] = [];
  let rmsS = 0,
    mouth = LIP_SYNC_MIN_OPEN;
  let widthS = 0,
    roundS = 0,
    scaleS = 1.0;
  for (let off = 0; off < ch.length; off += frameLen) {
    const end = Math.min(ch.length, off + frameLen);
    const n = end - off;
    let sum = 0,
      diffSum = 0;
    let prev = off > 0 ? ch[off - 1] : ch[off];
    // 简单低通 IIR（移动平均代理）
    let lpAcc = off > 0 ? ch[off - 1] : ch[off];
    let lpSum = 0;
    for (let i = off; i < end; i++) {
      const v = ch[i];
      sum += v * v;
      diffSum += (v - prev) * (v - prev);
      lpAcc = lpAcc * 0.9 + v * 0.1;
      lpSum += lpAcc * lpAcc;
      prev = v;
    }
    const rms = Math.sqrt(sum / n);
    const flux = Math.sqrt(diffSum / n); // 高频能量（瞬态/辅音）
    const lowRms = Math.sqrt(lpSum / n); // 低频能量（元音体）
    const t = (off / sr) * 1000;
    rmsS += (rms - rmsS) * 0.65;
    mouth = smoothMouth(mouth, rmsS, { hold: LIP_SYNC_MIN_OPEN });
    if (mouth < LIP_SYNC_MIN_OPEN) mouth = LIP_SYNC_MIN_OPEN;
    // 高频比 → 嘴型宽度
    const fr = rms > 0.001 ? Math.min(3, flux / rms) : 0.8;
    widthS += (fluxToMouthWidth(fr) - widthS) * 0.4;
    // 低频比 → 嘴型圆度
    const lr = rms > 0.001 ? Math.min(1, lowRms / rms) : 0.5;
    roundS += (lowRatioToMouthRound(lr) - roundS) * 0.4;
    // RMS → 缩放
    scaleS += (rmsToMouthScale(rmsS) - scaleS) * 0.3;
    seq.push({ t, openY: mouth, width: widthS, round: roundS, scale: scaleS });
  }
  return seq;
}

/** 设置嘴型参数到预生成的多维度值。width→FORM_01, round→FORM_02, scale→SCALE。 */
function setMouthFormParams(core: any, w: number, r: number, s: number): void {
  // PARAM_MOUTH_FORM_01: 嘴型宽度（辅音宽/元音圆）
  const widthParams = ["PARAM_MOUTH_FORM_01", "ParamMouthForm"];
  for (const p of widthParams) {
    try {
      if (paramExists(core, p)) core.setParamFloat(p, w);
    } catch {}
  }
  // PARAM_MOUTH_FORM_02: 嘴型圆度（元音圆/辅音扁）——独立维度
  if (paramExists(core, "PARAM_MOUTH_FORM_02")) {
    try {
      core.setParamFloat("PARAM_MOUTH_FORM_02", r);
    } catch {}
  }
  // PARAM_MOUTH_SCALE: 整体缩放
  if (paramExists(core, "PARAM_MOUTH_SCALE")) {
    try {
      core.setParamFloat("PARAM_MOUTH_SCALE", s);
    } catch {}
  }
}

/**
 * 按时间轴查表驱动口型（播放预生成序列，不再实时计算波形）。
 * 序列在播放前已生成，朗读全程口型连续、无「生成中闭合」。
 * 用游标递增查表（cur 单调递增，摊销 O(1)），消除逐帧线性查找的卡顿感。
 */
function buildSeqLipSyncStep(
  isActive: () => boolean,
  core: any,
  mouthParams: string[],
  breaks: SpeechBreak[] = [],
): () => void {
  let cursor = 0;
  let breakIdx = 0;
  let lastBreakT = -1;
  return () => {
    if (!isActive()) {
      removeLipSyncFromTicker();
      return;
    }
    const ctx = mouthSeqCtx;
    if (!ctx || !mouthSeq.length) {
      if (mouthParams.length > 0) {
        mouthSmooth = LIP_SYNC_MIN_OPEN;
        for (const p of mouthParams) {
          try {
            core.setParamFloat(p, LIP_SYNC_MIN_OPEN);
          } catch {}
        }
      }
      return;
    }
    const cur = (ctx.currentTime - mouthSeqStart) * 1000;
    let oy = cursor > 0 ? mouthSeq[cursor - 1].openY : LIP_SYNC_MIN_OPEN;
    let w = cursor > 0 ? mouthSeq[cursor - 1].width : 0;
    let r = cursor > 0 ? mouthSeq[cursor - 1].round : 0;
    let sc = cursor > 0 ? mouthSeq[cursor - 1].scale : 1.0;
    while (cursor < mouthSeq.length && mouthSeq[cursor].t <= cur) {
      oy = mouthSeq[cursor].openY;
      w = mouthSeq[cursor].width;
      r = mouthSeq[cursor].round;
      sc = mouthSeq[cursor].scale;
      cursor++;
    }
    mouthSmooth = oy;
    for (const p of mouthParams) {
      try {
        core.setParamFloat(p, oy);
      } catch {}
    }
    setMouthFormParams(core, w, r, sc);
    // 短语边界触发微点头：过边界点时 ParamAngleX 做 ±3° 交替微动（~400ms ease）
    if (breaks.length && breakIdx < breaks.length) {
      const b = breaks[breakIdx];
      if (cur >= b.t && b.t !== lastBreakT) {
        lastBreakT = b.t;
        breakIdx++;
        // 交替左右方向微点头
        const dir = breakIdx % 2 === 1 ? 3 : -3; // left/right alternate
        triggerMicroNod(core, dir);
      }
    }
  };
}

/** 微点头：ParamAngleX 快速 ease 到目标角度再回正（~400ms 总时长，不干扰口型循环） */
function triggerMicroNod(core: any, targetAngle: number): void {
  if (!paramExists(core, "ParamAngleX")) return;
  const start = performance.now();
  const DUR = 400;
  const readAngle = (): number => {
    try {
      const v = core.getParamFloat("ParamAngleX");
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };
  const from = readAngle();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DUR);
    // easeOutCubic: to target then back
    const k =
      t < 0.5
        ? easeInOutCubic(t * 2) // 0→1: go to target
        : 1 - easeInOutCubic((t - 0.5) * 2); // 1→0: return
    try {
      core.setParamFloat("ParamAngleX", from + targetAngle * k);
    } catch {}
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 口型平滑回落：从当前开口平滑降到 0（约 220ms easeOut），替代“啪”地闭合 */
function fadeMouthToZero(): void {
  if (mouthFadeId) cancelAnimationFrame(mouthFadeId);
  const core = getCoreModel();
  if (!core) return;
  const mouthParams = getMouthParams(core);
  if (!mouthParams.length) return;
  let fromOpen = 0,
    fromW = 0,
    fromR = 0,
    fromSc = 1;
  try {
    fromOpen = core.getParamFloat ? core.getParamFloat(mouthParams[0]) : 0;
    const wp = ["PARAM_MOUTH_FORM_01", "ParamMouthForm"];
    for (const p of wp) {
      try {
        if (paramExists(core, p)) {
          fromW = core.getParamFloat(p);
          break;
        }
      } catch {}
    }
    if (paramExists(core, "PARAM_MOUTH_FORM_02"))
      try {
        fromR = core.getParamFloat("PARAM_MOUTH_FORM_02");
      } catch {}
    if (paramExists(core, "PARAM_MOUTH_SCALE"))
      try {
        fromSc = core.getParamFloat("PARAM_MOUTH_SCALE");
      } catch {}
  } catch {}
  const doFade = Number.isFinite(fromOpen) && fromOpen > 0.02;
  if (!doFade) {
    for (const p of mouthParams) {
      try {
        core.setParamFloat(p, 0);
      } catch {}
    }
    setMouthFormParams(core, 0, 0, 1);
    return;
  }
  const start = performance.now();
  const DUR = 220;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DUR);
    const e = 1 - (1 - t) * (1 - t);
    for (const p of mouthParams) {
      try {
        core.setParamFloat(p, fromOpen * (1 - e));
      } catch {}
    }
    setMouthFormParams(
      core,
      fromW * (1 - e),
      fromR * (1 - e),
      fromSc + (1 - fromSc) * e,
    );
    if (t < 1) mouthFadeId = requestAnimationFrame(step);
    else mouthFadeId = 0;
  };
  mouthFadeId = requestAnimationFrame(step);
}

/**
 * 播放音频并用真实波形驱动口型（Web Audio AnalyserNode RMS → ParamMouthOpenY，带平滑）。
 * @param url 音频 URL（同源 / 经 worker 代理均可）
 * @param opts.volume 音量 0~1（默认 1）
 * @param opts.onEnd 播放结束回调（AIChat 用来收尾/清状态）
 * @returns 是否成功进入真实音频口型（模型无口型参数时仍播放声音但返回 false）
 */
export function speakAudio(
  url: string,
  opts?: { volume?: number; onEnd?: () => void },
): boolean {
  stopSpeaking();
  lipSyncActive = true; // 朗读进行中：表情动画不覆盖嘴部开合
  if (!url) return false;
  try {
    if (!audioCtx) {
      const AC: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return false;
      audioCtx = new AC();
    }
    // 移动端/自动播放：确保上下文 running，否则 MediaElementSource 路由到挂起上下文会静音
    ensureAudioCtxRunning();
    // 说话期间暂停环境动作（眨眼/小动作）：它们的 motion 每帧会覆盖 ParamMouthOpenY，
    // 导致口型被压回 0——这是“嘴不动”的根因
    stopAmbient();
    startSpeakingAmbient();
    audioEl = new Audio();
    audioEl.src = url;
    audioEl.volume = Math.max(0, Math.min(1, opts?.volume ?? 1));
    // 每个 audio 元素只能 createMediaElementSource 一次（本次新建元素 → 新建 source+analyser）
    // 注意：一旦走 MediaElementSource，该元素音频只从 Web Audio 图输出 → 必须 connect(destination)
    const source = audioCtx.createMediaElementSource(audioEl);
    audioAnalyser = audioCtx.createAnalyser();
    audioAnalyser.fftSize = 512;
    source.connect(audioAnalyser);
    audioAnalyser.connect(audioCtx.destination);
    // Frequency analyser for multi-param mouth form (width/round/scale)
    // Low-perf devices skip: spectrum analysis has measurable cost
    if (!lowPerf) {
      freqAnalyser = audioCtx.createAnalyser();
      freqAnalyser.fftSize = 512;
      freqAnalyser.smoothingTimeConstant = 0.5;
      source.connect(freqAnalyser);
    }
    audioEndedCb = opts?.onEnd || null;
    audioEl.onended = () => {
      stopSpeaking();
      const cb = audioEndedCb;
      audioEndedCb = null;
      cb?.();
    };
    // 口型参数存在才跑波形循环；不存在则纯播放声音
    const core = getCoreModel();
    const mouthParams = core ? getMouthParams(core) : [];
    const session = ++speakSession;
    // 注册 lipSync step（analyserRef 指向模块级 audioAnalyser）：
    // play 前音频缓冲（无波形）→ 准备态固定微张 PREP_MOUTH_OPEN；出声后无缝切到波形驱动
    // Start rmsSmooth at 0.05 (~target 0.2) so mouth doesn't close then reopen
    mouthSmooth = PREP_MOUTH_OPEN;
    rmsSmooth = 0.05;
    addLipSyncToTicker(
      buildLipSyncStep(
        () => session === speakSession && lipSyncActive && !!audioEl,
        core,
        mouthParams,
        () => audioAnalyser,
        () => freqAnalyser,
      ),
    );
    const el = audioEl; // 本函数新建的 Audio，非空；供播放用
    // 先等 AudioContext resume 完成再 play：移动端手势内 resume 是异步的，
    // 不等就 play 可能被自动播放策略拦（静音/无声）→ 波形拿不到 → 口型不动。
    const play = () => {
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    };
    if (audioCtx.state === "suspended") {
      audioCtx.resume().then(play).catch(play);
    } else {
      play();
    }
    return mouthParams.length > 0;
  } catch {
    return false;
  }
}

/**
 * 用已解码的音频播放并驱动口型（AudioBufferSourceNode 路径，速度优化）。
 * 对齐开源 @liyao1520/live2d-motionSync 的 `play(AudioBuffer)` 思路：
 * 先 decodeAudioData 为 AudioBuffer 再播放 → 播放起点精确、口型第一帧即可同步。
 * 命中 TTS 缓存时优先走此路径（见 ttsCache.ts）；`speakAudio(url)` 保留给第三方/未缓存 URL。
 * @param buffer 音频 ArrayBuffer（mp3/wav 等任意可解码格式）
 * @param opts.volume 音量 0~1（默认 1）
 * @param opts.onEnd 播放结束回调
 * @returns 是否进入播放流程（decode 是异步的，失败会静默收尾并触发 onEnd 兜底）
 */
export function speakAudioBuffer(
  buffer: ArrayBuffer,
  opts?: { volume?: number; onEnd?: () => void },
): boolean {
  stopSpeaking();
  lipSyncActive = true; // 朗读进行中：表情动画不覆盖嘴部开合
  if (!buffer || buffer.byteLength === 0) return false;
  const onEndCb = opts?.onEnd;
  const volume = Math.max(0, Math.min(1, opts?.volume ?? 1));
  const finish = () => {
    stopSpeaking();
    if (onEndCb) onEndCb();
  };
  try {
    if (!audioCtx) {
      const AC: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return false;
      audioCtx = new AC();
    }
    // 移动端/自动播放：确保上下文 running，否则 AudioBufferSource 挂起上下文会静音
    ensureAudioCtxRunning();
    // 说话期间暂停 idle 动作（其 motion 每帧覆盖口型参数），但保留眨眼+身体微动
    // （startSpeakingAmbient 接管环境动画，避免角色"死站着"）
    stopAmbient();
    startSpeakingAmbient();
    const ctx = audioCtx;
    // 关键：decodeAudioData 会 detach（transfer）传入的 ArrayBuffer。
    // 缓存（ttsCache）复用的是同一份 buffer，必须拷贝再解码，否则解码一次后
    // 原 buffer 变空 → 后续缓存朗读幅度异常/无声。
    let srcBuf = buffer;
    try {
      srcBuf = buffer.slice(0);
    } catch {
      srcBuf = buffer;
    }
    const core = getCoreModel();
    const mouthParams = core ? getMouthParams(core) : [];
    const session = ++speakSession;
    // decode 期间 audioAnalyser=null → 准备态固定微张 0.2
    mouthSmooth = PREP_MOUTH_OPEN;
    rmsSmooth = 0.05;
    audioAnalyser = null;
    addLipSyncToTicker(
      buildLipSyncStep(
        () => session === speakSession && lipSyncActive,
        core,
        mouthParams,
        () => audioAnalyser,
        () => null,
      ),
    );
    ctx.decodeAudioData(
      srcBuf,
      (audioBuf) => {
        try {
          // 朗读前先生成好完整口型序列（离线分析波形；播放时按时间轴查表，
          // 朗读中不再实时计算 → 全程连续、无「生成中闭合」）
          const seq = buildMouthSequence(audioBuf);
          // 分析短语边界（停顿>300ms处），用于触发微点头/身体调整
          const breaks = analyzeSpeechBreaks(seq);
          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          audioBufferSrc = src;
          // AudioBufferSourceNode 无 volume 属性，用 GainNode；口型序列已离线生成，无需 Analyser
          const gain = ctx.createGain();
          gain.gain.value = volume;
          src.connect(gain);
          gain.connect(ctx.destination);
          src.onended = finish;
          // 用预生成序列按时间轴查表驱动口型（替换 decode 前的准备态 step）
          mouthSeq = seq;
          mouthSeqCtx = ctx;
          // 必须在 hook seq step 之前锁定时间轴起点：否则游标用旧值(0)算出超大偏移
          // → 瞬间跑完整个序列 → 嘴永远停在最后一帧 0.3 → "词对不上口型"
          mouthSeqStart = ctx.currentTime;
          lipSyncHookRef = buildSeqLipSyncStep(
            () => session === speakSession && lipSyncActive,
            core,
            mouthParams,
            breaks,
          );
          const start = () => {
            try {
              src.start();
            } catch {}
          };
          if (ctx.state === "suspended") {
            ctx.resume().then(start).catch(start);
          } else {
            start();
          }
        } catch {
          finish();
        }
      },
      () => {
        // decode 失败：恢复环境动作并收尾（不播放）
        stopSpeakingAmbient();
        startAmbient();
        finish();
      },
    );
    return true;
  } catch {
    return false;
  }
}

// ---- 鼠标凝视（桌面：角色头部/身体跟随鼠标，更"活"）----
// 只驱动 ParamAngleX/ParamAngleY（头/身体角度），不碰眼睛（避免与眨眼/表情冲突）。
// 低性能设备跳过；attach 时绑定容器 mousemove，detach/dispose 解除。

let gazeEl: HTMLElement | null = null;
let gazeId = 0;
let gazeTarget = { x: 0, y: 0 };
let gazeCur = { x: 0, y: 0 };
let gazeLastMove = 0;
/** 鼠标静止超过该时长后停止凝视驱动（回正角度，避免持续覆盖动作播放的角度参数） */
const GAZE_IDLE_MS = 2000;

function onGazeMove(e: MouseEvent): void {
  const el = attachedEl;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
  gazeTarget = {
    x: Math.max(-1, Math.min(1, nx)),
    y: Math.max(-1, Math.min(1, ny)),
  };
  gazeLastMove = performance.now();
  // 静止期间循环已停 → 鼠标再动时重启
  if (!gazeId) gazeId = requestAnimationFrame(gazeStep);
}

function gazeStep(): void {
  if (performance.now() - gazeLastMove > GAZE_IDLE_MS) {
    // 静止超时：停止循环并回正（把控制权还给动作播放）
    gazeId = 0;
    gazeCur = { x: 0, y: 0 };
    const core = getCoreModel();
    if (core) {
      if (paramExists(core, "ParamAngleX")) {
        try {
          core.setParamFloat("ParamAngleX", 0);
        } catch {}
      }
      if (paramExists(core, "ParamAngleY")) {
        try {
          core.setParamFloat("ParamAngleY", 0);
        } catch {}
      }
    }
    return;
  }
  gazeId = requestAnimationFrame(gazeStep);
  const core = getCoreModel();
  if (!core) return;
  gazeCur.x += (gazeTarget.x - gazeCur.x) * 0.08;
  gazeCur.y += (gazeTarget.y - gazeCur.y) * 0.08;
  if (paramExists(core, "ParamAngleX")) {
    try {
      core.setParamFloat("ParamAngleX", gazeCur.x * 18);
    } catch {}
  }
  if (paramExists(core, "ParamAngleY")) {
    try {
      core.setParamFloat("ParamAngleY", gazeCur.y * 14);
    } catch {}
  }
}

function startGaze(): void {
  if (lowPerf) return;
  if (!attachedEl || gazeEl === attachedEl) return;
  stopGaze();
  gazeEl = attachedEl;
  gazeEl.addEventListener("mousemove", onGazeMove);
  gazeCur = { x: 0, y: 0 };
  gazeTarget = { x: 0, y: 0 };
  gazeLastMove = performance.now();
  gazeId = requestAnimationFrame(gazeStep);
}

function stopGaze(): void {
  if (gazeId) cancelAnimationFrame(gazeId);
  gazeId = 0;
  if (gazeEl) {
    try {
      gazeEl.removeEventListener("mousemove", onGazeMove);
    } catch {}
    gazeEl = null;
  }
  gazeTarget = { x: 0, y: 0 };
  gazeCur = { x: 0, y: 0 };
}
