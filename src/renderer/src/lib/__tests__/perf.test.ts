import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamThrottle,
  isLowPerfDevice,
  _resetPerfCache,
  trackAICall,
  loadAIStats,
  clearAIStats,
} from "../perf";

/** 按硬件配置覆写 navigator（jsdom 下 hardwareConcurrency 通常缺失） */
function mockHardware(cores?: number, mem?: number, ua = "") {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (cores != null) {
    Object.defineProperty(nav, "hardwareConcurrency", {
      value: cores,
      configurable: true,
    });
  }
  if (mem != null) {
    Object.defineProperty(nav, "deviceMemory", {
      value: mem,
      configurable: true,
    });
  }
  if (ua) {
    Object.defineProperty(nav, "userAgent", {
      value: ua,
      configurable: true,
    });
  }
}

describe("isLowPerfDevice", () => {
  afterEach(() => {
    _resetPerfCache();
    vi.restoreAllMocks();
  });

  it("高配设备判定为高性能", () => {
    mockHardware(8, 8);
    expect(isLowPerfDevice()).toBe(false);
  });

  it("≤4 核判定为低性能", () => {
    mockHardware(4, 8);
    expect(isLowPerfDevice()).toBe(true);
  });

  it("≤4GB 内存判定为低性能", () => {
    mockHardware(8, 4);
    expect(isLowPerfDevice()).toBe(true);
  });

  it("无硬件信息 + 移动端 UA 保守判定低性能", () => {
    mockHardware(undefined, undefined, "Mozilla/5.0 (Linux; Android 10)");
    // 模拟「无 hardwareConcurrency 属性」：删除后走 UA 兜底分支
    delete (navigator as { hardwareConcurrency?: unknown }).hardwareConcurrency;
    expect(isLowPerfDevice()).toBe(true);
  });

  it("结果进程内缓存（重复调用不重复探测）", () => {
    mockHardware(8, 8);
    const spy = vi.spyOn(navigator, "hardwareConcurrency", "get");
    expect(isLowPerfDevice()).toBe(false);
    // 第二次调用命中缓存，不再读取 hardwareConcurrency
    expect(isLowPerfDevice()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("createStreamThrottle 流式节流", () => {
  let rafCbs: (() => void)[];
  let now = 0;

  beforeEach(() => {
    now = 0;
    rafCbs = [];
    // 手动控制的 rAF：调用方自行决定何时执行回调
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const runRafs = () => {
    const cbs = rafCbs.splice(0);
    for (const cb of cbs) cb();
  };

  it("首次调用立即刷写（低延迟感知）", () => {
    const fn = vi.fn();
    const throttle = createStreamThrottle(fn, 80);
    throttle("第一块");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("第一块");
  });

  it("间隔内多次调用合并为一次（rAF 帧内合并）", () => {
    const fn = vi.fn();
    const throttle = createStreamThrottle(fn, 80);
    throttle("a"); // t=0 立即刷
    now = 10;
    throttle("b");
    throttle("c");
    throttle("d");
    // 未到 80ms 间隔，仅调度一帧 rAF，不重复刷写
    expect(fn).toHaveBeenCalledTimes(1);
    expect(rafCbs.length).toBe(1);
    // 执行 rAF：用最新内容刷一次
    runRafs();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("d");
  });

  it("超过间隔立即刷写（不拖沓）", () => {
    const fn = vi.fn();
    const throttle = createStreamThrottle(fn, 80);
    throttle("a"); // t=0 立即刷
    now = 200; // 超过 80ms
    throttle("b");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
    // 超间隔刷写时应取消挂起的 rAF，避免重复刷
    expect(rafCbs.length).toBe(0);
  });

  it("长流式下渲染次数显著少于调用次数（高频压力）", () => {
    const fn = vi.fn();
    const throttle = createStreamThrottle(fn, 80);
    // 模拟快速模型：每 chunk 间隔仅 2ms 高频推送，主线程按 ~16ms 一帧执行 rAF
    let t = 0;
    for (let i = 0; i < 600; i++) {
      t += 2;
      now = t;
      throttle("chunk-" + i);
      if (i % 8 === 0) runRafs(); // 每帧执行一次收集到的 rAF 回调
    }
    // 600 次 chunk 被合并为 ~15 次渲染（1200ms / 80ms），远小于调用次数
    runRafs(); // 模拟最后一帧：把挂起的 rAF 最新内容刷出
    expect(fn.mock.calls.length).toBeLessThan(200);
    expect(fn).toHaveBeenLastCalledWith("chunk-599");
  });
});

describe("perf · trackAICall 埋点", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("记录 → 读取 → 环形缓冲上限 300", () => {
    for (let i = 0; i < 350; i++) {
      trackAICall({
        task: "chat",
        model: "m",
        sysChars: 100 + i,
        ms: 10,
        ts: i,
      });
    }
    const stats = loadAIStats();
    expect(stats.length).toBe(300); // 环形缓冲上限 300，丢弃最早 50 条
    expect(stats[0].sysChars).toBe(100 + 50);
    expect(stats[stats.length - 1].sysChars).toBe(100 + 349);
    clearAIStats();
    expect(loadAIStats()).toEqual([]);
  });

  it("损坏 JSON 静默重建，不崩溃", () => {
    localStorage.setItem("kimo_ai_stats", "{bad");
    trackAICall({ task: "chat", model: "m", sysChars: 1, ms: 1, ts: 1 });
    expect(loadAIStats()).toHaveLength(1);
  });
});
