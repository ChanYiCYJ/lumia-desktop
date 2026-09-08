import { describe, it, expect } from "vitest";
import {
  PROMPT_PRESETS,
  fillPrompt,
  defaultSystemPrompt,
} from "../promptPresets";

describe("promptPresets · 提示词模板", () => {
  it("包含自我进化 AI 模板", () => {
    expect(PROMPT_PRESETS.some((p) => p.id === "self-aware")).toBe(true);
    expect(PROMPT_PRESETS.some((p) => p.id === "assistant")).toBe(true);
  });
  it("fillPrompt 替换占位符", () => {
    const p = fillPrompt("你是 {botName}，服务 {ownerName}", {
      botName: "小K",
      ownerName: "站长",
    });
    expect(p).toBe("你是 小K，服务 站长");
  });
  it("无提示词兜底为自我进化 AI（填充名称）", () => {
    const p = defaultSystemPrompt("小K");
    expect(p).toContain("自我认知");
    expect(p).toContain("小K");
    expect(p).toContain("知识库");
    expect(p).toContain("[KB-SAVE:");
  });
  it("空名称兜底为 AI", () => {
    expect(defaultSystemPrompt("")).toContain("你是 AI");
  });
});
