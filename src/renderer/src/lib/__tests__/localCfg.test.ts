import { describe, it, expect, beforeEach } from "vitest";
import {
  getLocalCfg,
  saveLocalCfg,
  clearLocalCfg,
  hasLocalCfg,
} from "../localCfg";

beforeEach(() => {
  localStorage.clear();
});

describe("localCfg · 本地模型 API 配置", () => {
  it("默认返回空配置", () => {
    expect(getLocalCfg(1)).toEqual({
      endpoint: "",
      apiKey: "",
      model: "",
      prompt: "",
    });
  });
  it("保存后可读取（按 pageId 隔离）", () => {
    saveLocalCfg(2, {
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "deepseek",
      prompt: "人设",
    });
    expect(getLocalCfg(2)).toEqual({
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "deepseek",
      prompt: "人设",
    });
    expect(getLocalCfg(1).endpoint).toBe("");
  });
  it("清除后回到默认", () => {
    saveLocalCfg(1, {
      endpoint: "https://x",
      apiKey: "k",
      model: "m",
      prompt: "",
    });
    clearLocalCfg(1);
    expect(getLocalCfg(1).endpoint).toBe("");
  });
  it("hasLocalCfg 需要三字段齐全", () => {
    expect(hasLocalCfg(1)).toBe(false);
    saveLocalCfg(1, { endpoint: "e", apiKey: "k", model: "m" });
    expect(hasLocalCfg(1)).toBe(true);
    saveLocalCfg(1, { endpoint: "e", apiKey: "", model: "" });
    expect(hasLocalCfg(1)).toBe(false);
  });
  it("非法 JSON 回退空配置", () => {
    localStorage.setItem("kimo_ai_local_1", "{not-json");
    expect(getLocalCfg(1)).toEqual({
      endpoint: "",
      apiKey: "",
      model: "",
      prompt: "",
    });
  });
  it("字段类型异常被清洗", () => {
    localStorage.setItem(
      "kimo_ai_local_1",
      JSON.stringify({ endpoint: 123, apiKey: null, model: "m", prompt: "p" }),
    );
    const cfg = getLocalCfg(1);
    expect(cfg.endpoint).toBe("");
    expect(cfg.apiKey).toBe("");
    expect(cfg.model).toBe("m");
    expect(cfg.prompt).toBe("p");
  });
});
