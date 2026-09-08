import { describe, it, expect } from "vitest";
import { compressMemory } from "../chatSettings";
import { parseKbTool } from "../kb";
import { stripToolCmds } from "../toolCmds";

describe("记忆自动压缩", () => {
  it("空记忆追加一条", () => {
    expect(compressMemory("", "你好", "你好！")).toBe(
      "- 用户问：你好 → AI 答：你好！",
    );
  });

  it("同主题问题合并为一条", () => {
    const first = compressMemory("", "React是什么", "React是UI库");
    const second = compressMemory(
      first,
      "React是什么",
      "React是Facebook的UI库",
    );
    expect(second.split("\n").filter(Boolean).length).toBe(1);
    expect(second).toContain("Facebook");
  });

  it("超过10条只保留最新", () => {
    let long = "";
    for (let i = 0; i < 20; i++) {
      long = compressMemory(long, "问题" + i, "答案内容".repeat(50) + i);
    }
    const lines = long.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(long.length).toBeLessThanOrEqual(2000);
  });
});

describe("KB 指令识别效率", () => {
  it("KB-SAVE 解析", () => {
    const r = parseKbTool("好的，已保存：[KB-SAVE:我的笔记]这是内容[/KB-SAVE]");
    expect(r?.mode).toBe("save");
    expect(r?.title).toBe("我的笔记");
    expect(r?.content).toBe("这是内容");
  });

  it("KB-EDIT 解析", () => {
    const r = parseKbTool("已更新：[KB-EDIT:旧标题]新内容[/KB-EDIT]");
    expect(r?.mode).toBe("edit");
    expect(r?.title).toBe("旧标题");
    expect(r?.content).toBe("新内容");
  });

  it("无 KB 指令返回 null", () => {
    expect(parseKbTool("普通回复，没有KB指令")).toBeNull();
  });

  it("多行内容含括号解析", () => {
    const r = parseKbTool(
      "[KB-SAVE:多行笔记]第一行\n第二行（含括号）[/KB-SAVE]",
    );
    expect(r?.content).toBe("第一行\n第二行（含括号）");
  });

  it("未闭合 KB-SAVE 容错解析（AI 常漏写结束标签）", () => {
    const r = parseKbTool("[KB-SAVE:未闭合]内容没有结束标签");
    expect(r?.mode).toBe("save");
    expect(r?.title).toBe("未闭合");
    expect(r?.content).toBe("内容没有结束标签");
  });

  it("未闭合 KB-SAVE 遇下一个工具指令时截断", () => {
    const r = parseKbTool("[KB-SAVE:未闭合]内容[SEARCH:另一个关键词]");
    expect(r?.title).toBe("未闭合");
    expect(r?.content).toBe("内容");
  });
});

describe("工具指令文本过滤 (stripToolCmds)", () => {
  it("过滤 SEARCH 指令", () => {
    expect(stripToolCmds("让我先搜索一下。[SEARCH: Vue.js 3.5 新特性]")).toBe(
      "让我先搜索一下。",
    );
  });

  it("过滤 BROWSE 指令", () => {
    expect(stripToolCmds("我去看看。[BROWSE: https://example.com]")).toBe(
      "我去看看。",
    );
  });

  it("过滤 KB-SAVE 成对块", () => {
    expect(stripToolCmds("好的，已保存。[KB-SAVE:笔记]内容[/KB-SAVE]")).toBe(
      "好的，已保存。",
    );
  });

  it("过滤 KB-DELETE 指令", () => {
    expect(stripToolCmds("好的，已删除。[KB-DELETE:笔记]")).toBe(
      "好的，已删除。",
    );
  });

  it("保留正常文本", () => {
    expect(stripToolCmds("这是正常回复，没有指令。")).toBe(
      "这是正常回复，没有指令。",
    );
  });

  it("兼容未闭合 EDIT 指令", () => {
    expect(stripToolCmds("未闭合 [EDIT:这是内容")).toBe("未闭合");
  });
});
