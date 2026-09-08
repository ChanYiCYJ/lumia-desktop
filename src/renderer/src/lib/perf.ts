// ===== 前端性能工具：低性能设备检测 + 流式更新节流 =====
// 目标：AI Chat 在高频流式 chunk 下（快速模型每秒可达 50+ 次推送），
// 若每个 chunk 都触发一次 React 重渲染，低端手机/老设备会因主线程过载而严重卡顿。
// 这里提供统一的「低性能设备」判定与「节流器」，把同一帧/短窗口内多次更新合并为一次。

/** 低性能设备判定（进程内缓存一次，避免每次渲染重复探测） */
let lowPerfCached: boolean | null = null;

/** 仅供测试：重置低性能判定缓存（不同用例需模拟不同硬件配置） */
export function _resetPerfCache(): void {
  lowPerfCached = null;
}

export function isLowPerfDevice(): boolean {
  if (lowPerfCached != null) return lowPerfCached;
  let low = false;
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 0;
    const mem = nav.deviceMemory ?? 0;
    // 低端：≤4 核，或 ≤4GB 内存（覆盖常见千元机/老设备/低配 WebView）
    if ((cores > 0 && cores <= 4) || (mem > 0 && mem <= 4)) low = true;
  } catch {
    /* 忽略 */
  }
  // 无硬件并发信息 + 移动端 UA → 按低端 WebView 保守判定
  if (!low) {
    try {
      const hasCores = "hardwareConcurrency" in navigator;
      const ua = navigator.userAgent;
      if (!hasCores && /Mobi|Android|iPhone|iPad/i.test(ua)) low = true;
    } catch {
      /* 忽略 */
    }
  }
  lowPerfCached = low;
  return low;
}

/**
 * 流式更新节流器：把高频回调合并为「最多每 INTERVAL 一次同步刷写 + 帧内 rAF 合并」。
 * - 首块立即渲染（低延迟感知）；
 * - 后续块：距上次刷写 ≥ INTERVAL 立即刷，否则合并进下一帧 rAF（同一帧多次更新只渲一次）；
 * - 主线程繁忙时浏览器自动降帧，rAF 频率随之下降 → 天然自适应低端设备。
 */
export function createStreamThrottle(
  fn: (content: string) => void,
  intervalMs?: number,
): (content: string) => void {
  // 低性能设备用更保守的刷写间隔，进一步降低重渲染频率
  const INTERVAL = intervalMs ?? (isLowPerfDevice() ? 150 : 80);
  let latest = "";
  let raf = 0;
  let lastFlush = -1;
  let flush = () => {};
  flush = () => {
    lastFlush = performance.now();
    raf = 0;
    fn(latest);
  };
  return (content: string) => {
    latest = content;
    const now = performance.now();
    // 首次调用或距上次刷写超过阈值：立即刷（保证低延迟，且长间隔后不拖沓）
    if (lastFlush < 0 || now - lastFlush >= INTERVAL) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush();
      return;
    }
    // 否则合并进下一帧（同一帧内多次调用只调度一次）
    if (raf) return;
    raf = requestAnimationFrame(() => flush());
  };
}

// ===== AI 调用埋点（优化前后对比用，不影响 UI 与性能）=====
// 记录每次 AI 请求的 task/model/system 字符数（近似 token）/耗时，写入 localStorage
// 环形缓冲（kimo_ai_stats）+ console.debug。用于验证「skill 模块化降 token + 并行提速」效果。

export interface AICallStat {
  /** 任务名：chat / deriveKeyword / personaNote / viewIntro / searchAI / article 等 */
  task: string;
  model: string;
  /** system 提示词字符数（≈ token 数 /3~4） */
  sysChars: number;
  /** 请求耗时 ms（含流式收包） */
  ms: number;
  ts: number;
}

const AI_STATS_KEY = "kimo_ai_stats";
const AI_STATS_MAX = 300;

export function trackAICall(stat: AICallStat): void {
  try {
    const raw = localStorage.getItem(AI_STATS_KEY) || "[]";
    let arr: AICallStat[] = [];
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) arr = j as AICallStat[];
    } catch {
      /* 损坏则重建 */
    }
    arr.push(stat);
    if (arr.length > AI_STATS_MAX) arr = arr.slice(-AI_STATS_MAX);
    localStorage.setItem(AI_STATS_KEY, JSON.stringify(arr));
    if (typeof console !== "undefined" && console.debug) {
      console.debug(
        `[ai] ${stat.task} model=${stat.model} sys=${stat.sysChars}ch ${stat.ms}ms`,
      );
    }
  } catch {
    /* localStorage 不可用时静默 */
  }
}

/** 读取全部埋点（按时间正序） */
export function loadAIStats(): AICallStat[] {
  try {
    const raw = localStorage.getItem(AI_STATS_KEY) || "[]";
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as AICallStat[]) : [];
  } catch {
    return [];
  }
}

/** 清空埋点 */
export function clearAIStats(): void {
  try {
    localStorage.removeItem(AI_STATS_KEY);
  } catch {
    /* 忽略 */
  }
}
