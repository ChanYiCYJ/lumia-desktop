import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  getPreset,
  detectProvider,
  isReasoningModel,
  resolveMaxTokens,
  parseDelta,
  extractMessage,
} from "../providerPresets";

describe("providerPresets · 预设", () => {
  it("包含 DeepSeek / Kimi / OpenAI 预设", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("kimi");
    expect(ids).toContain("openai");
  });
  it("DeepSeek 预设：接口 + 最新 v4 + 历史别名", () => {
    const p = getPreset("deepseek")!;
    expect(p.endpoint).toBe("https://api.deepseek.com");
    expect(p.model).toBe("deepseek-v4-flash");
    expect(p.models).toContain("deepseek-v4-flash");
    expect(p.models).toContain("deepseek-v4-pro");
    expect(p.latest).toContain("deepseek-v4-flash");
    expect(p.models).toContain("deepseek-reasoner");
    expect(p.models).toContain("deepseek-v3.2");
    expect(p.models).toContain("deepseek-v3");
    expect(p.models).toContain("deepseek-r1");
  });
  it("Kimi 预设：Moonshot 接口 + 最新 K2.6/K3 + 历史模型", () => {
    const p = getPreset("kimi")!;
    expect(p.endpoint).toBe("https://api.moonshot.cn/v1");
    expect(p.model).toBe("kimi-k2.6");
    expect(p.models).toContain("kimi-k2.6");
    expect(p.models).toContain("kimi-k3");
    expect(p.models).toContain("kimi-k2.7-code");
    expect(p.latest).toContain("kimi-k2.6");
    expect(p.models).toContain("moonshot-v1-128k");
    expect(p.models).toContain("kimi-latest");
    expect(p.models).toContain("kimi-k2-turbo-preview");
    expect(p.models).toContain("kimi-k2-thinking-preview");
    expect(p.models).toContain("kimi-k2-0905-preview");
  });
  it("未知服务商返回 undefined", () => {
    expect(getPreset("other")).toBeUndefined();
  });
});

describe("providerPresets · detectProvider", () => {
  it("DeepSeek：接口/模型任一命中", () => {
    expect(detectProvider("https://api.deepseek.com/v1", "")).toBe("deepseek");
    expect(detectProvider("", "deepseek-chat")).toBe("deepseek");
    expect(detectProvider("https://x.com", "deepseek-reasoner")).toBe(
      "deepseek",
    );
  });
  it("Kimi：moonshot / kimi 命中", () => {
    expect(detectProvider("https://api.moonshot.cn/v1", "")).toBe("kimi");
    expect(detectProvider("", "kimi-latest")).toBe("kimi");
    expect(detectProvider("", "moonshot-v1-32k")).toBe("kimi");
  });
  it("OpenAI：openai 接口 / gpt 模型命中", () => {
    expect(detectProvider("https://api.openai.com/v1", "")).toBe("openai");
    expect(detectProvider("", "gpt-4o-mini")).toBe("openai");
  });
  it("其他/空为 other", () => {
    expect(detectProvider("", "")).toBe("other");
    expect(detectProvider("https://api.example.com", "llama-3")).toBe("other");
  });
});

describe("providerPresets · isReasoningModel", () => {
  it("推理模型返回 true", () => {
    expect(isReasoningModel("deepseek-reasoner")).toBe(true);
    expect(isReasoningModel("kimi-thinking-preview")).toBe(true);
    expect(isReasoningModel("o1-preview")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
  });
  it("普通模型返回 false", () => {
    expect(isReasoningModel("deepseek-chat")).toBe(false);
    expect(isReasoningModel("moonshot-v1-8k")).toBe(false);
    expect(isReasoningModel("gpt-4o")).toBe(false);
  });
});

describe("providerPresets · resolveMaxTokens", () => {
  it("推理模型给足 16384", () => {
    expect(resolveMaxTokens("deepseek-reasoner")).toBe(16384);
    expect(resolveMaxTokens("kimi-thinking-preview")).toBe(16384);
  });
  it("Kimi / Moonshot 用 8192（默认 1024 太短易截断）", () => {
    expect(resolveMaxTokens("moonshot-v1-8k")).toBe(8192);
    expect(resolveMaxTokens("kimi-latest")).toBe(8192);
    expect(resolveMaxTokens("kimi-k2-0711-preview")).toBe(8192);
  });
  it("其他模型回退 fallback（默认 4096）", () => {
    expect(resolveMaxTokens("gpt-4o")).toBe(4096);
    expect(resolveMaxTokens("llama-3", 800)).toBe(800);
  });
});

describe("providerPresets · parseDelta（流式增量）", () => {
  it("正文增量", () => {
    expect(parseDelta({ content: "你好" })).toEqual({
      content: "你好",
      reasoning: "",
    });
  });
  it("DeepSeek reasoning_content 思考增量", () => {
    expect(parseDelta({ reasoning_content: "思考中…" })).toEqual({
      content: "",
      reasoning: "思考中…",
    });
  });
  it("Kimi 用 reasoning 字段", () => {
    expect(parseDelta({ reasoning: "推理过程" })).toEqual({
      content: "",
      reasoning: "推理过程",
    });
  });
  it("OpenAI 多模态 delta（content 为数组）", () => {
    expect(parseDelta({ content: [{ text: "a" }, { text: "b" }] })).toEqual({
      content: "ab",
      reasoning: "",
    });
  });
  it("空 delta 返回空", () => {
    expect(parseDelta(null)).toEqual({ content: "", reasoning: "" });
    expect(parseDelta(undefined)).toEqual({ content: "", reasoning: "" });
    expect(parseDelta({})).toEqual({ content: "", reasoning: "" });
  });
});

describe("providerPresets · extractMessage（非流式）", () => {
  it("提取正文与 reasoning_content", () => {
    expect(
      extractMessage({ content: "答案", reasoning_content: "思考" }),
    ).toEqual({ content: "答案", reasoning: "思考" });
  });
  it("无思考时 reasoning 为空", () => {
    expect(extractMessage({ content: "答案" })).toEqual({
      content: "答案",
      reasoning: "",
    });
  });
  it("空对象安全", () => {
    expect(extractMessage(null)).toEqual({ content: "", reasoning: "" });
  });
});
