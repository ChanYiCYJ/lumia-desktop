/**
 * feedback.ts 单测
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  hashMessage,
  loadFeedback,
  saveFeedbackEntry,
  getFeedbackForHash,
  getRating,
  clearFeedback,
  analyzeFeedback,
  extractPositivePattern,
  extractNegativePattern,
} from "../feedback";

// ======================== hashMessage ========================

describe("feedback · hashMessage", () => {
  it("相同内容相同哈希", () => {
    expect(hashMessage("你好")).toBe(hashMessage("你好"));
  });

  it("不同内容不同哈希", () => {
    expect(hashMessage("你好")).not.toBe(hashMessage("再见"));
  });

  it("空内容正常返回", () => {
    expect(typeof hashMessage("  ")).toBe("string");
  });
});

// ======================== 读写 ========================

describe("feedback · 读写", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("初始为空数组", () => {
    expect(loadFeedback("test")).toEqual([]);
  });

  it("保存并读取", () => {
    saveFeedbackEntry("test", {
      msgHash: "abc",
      rating: 1,
      query: "你好",
      model: "gpt",
      ts: 1000,
    });
    const list = loadFeedback("test");
    expect(list.length).toBe(1);
    expect(list[0].rating).toBe(1);
  });

  it("同一哈希覆盖更新", () => {
    saveFeedbackEntry("test", {
      msgHash: "abc",
      rating: 1,
      query: "a",
      model: "x",
      ts: 1,
    });
    saveFeedbackEntry("test", {
      msgHash: "abc",
      rating: -1,
      query: "b",
      model: "y",
      ts: 2,
    });
    const list = loadFeedback("test");
    expect(list.length).toBe(1);
    expect(list[0].rating).toBe(-1);
  });

  it("getFeedbackForHash 命中", () => {
    saveFeedbackEntry("x", {
      msgHash: "k1",
      rating: 1,
      query: "q1",
      model: "m",
      ts: 1,
    });
    const e = getFeedbackForHash("x", "k1");
    expect(e?.rating).toBe(1);
  });

  it("getFeedbackForHash 未命中返回 undefined", () => {
    expect(getFeedbackForHash("x", "nope")).toBeUndefined();
  });

  it("getRating 返回正确值", () => {
    saveFeedbackEntry("r", {
      msgHash: "h1",
      rating: -1,
      query: "q",
      model: "m",
      ts: 1,
    });
    expect(getRating("r", "h1")).toBe(-1);
    expect(getRating("r", "h2")).toBe(0);
  });

  it("clearFeedback 清空", () => {
    saveFeedbackEntry("c", {
      msgHash: "h",
      rating: 1,
      query: "q",
      model: "m",
      ts: 1,
    });
    clearFeedback("c");
    expect(loadFeedback("c")).toEqual([]);
  });

  it("不同 pageId 隔离", () => {
    saveFeedbackEntry("a", {
      msgHash: "h",
      rating: 1,
      query: "q",
      model: "m",
      ts: 1,
    });
    expect(loadFeedback("b")).toEqual([]);
  });
});

// ======================== analyzeFeedback ========================

describe("feedback · analyzeFeedback 统计", () => {
  it("空数组返回零值", () => {
    const s = analyzeFeedback([]);
    expect(s.total).toBe(0);
    expect(s.ratio).toBe(0);
  });

  it("计算好评率", () => {
    const s = analyzeFeedback([
      { msgHash: "1", rating: 1, query: "a", model: "m", ts: 1 },
      { msgHash: "2", rating: -1, query: "b", model: "m", ts: 2 },
      { msgHash: "3", rating: 1, query: "c", model: "m", ts: 3 },
    ]);
    expect(s.positive).toBe(2);
    expect(s.negative).toBe(1);
    expect(s.ratio).toBeCloseTo(2 / 3);
    expect(s.positiveTopics).toEqual(["a", "c"]);
    expect(s.negativeTopics).toEqual(["b"]);
  });
});

// ======================== extractPositivePattern ========================

describe("feedback · extractPositivePattern 好评模式", () => {
  it("长回答 → 偏好详细", () => {
    const p = extractPositivePattern("x".repeat(900), "TypeScript 教程");
    expect(p).toContain("偏好详细");
  });

  it("短回答 → 偏好简洁", () => {
    const p = extractPositivePattern("简短回答", "hello");
    expect(p).toContain("简洁");
  });

  it("含话题关键词", () => {
    const p = extractPositivePattern("好的", "千恋万花 评价");
    expect(p).toContain("千恋万花");
  });
});

// ======================== extractNegativePattern ========================

describe("feedback · extractNegativePattern 差评模式", () => {
  it("过短 → 信息不足", () => {
    const p = extractNegativePattern("不行", "test");
    expect(p).toContain("信息不足");
  });

  it("道歉 → 回避", () => {
    const p = extractNegativePattern("抱歉，我无法回答这个问题", "test");
    expect(p).toContain("回避");
  });
});
