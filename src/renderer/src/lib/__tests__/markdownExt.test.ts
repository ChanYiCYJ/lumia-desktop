import { describe, it, expect } from "vitest";
import {
  extractDetails,
  splitDetails,
  safeUrlTransform,
} from "../markdownExt";

describe("markdownExt · extractDetails", () => {
  it("无 details：原样返回", () => {
    const md = "普通 markdown\n\n- 列表\n";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(0);
    expect(r.open).toBe(md);
  });

  it("单个 details：提取 title + body，主体替换为占位 token", () => {
    const md =
      "前文\n\n<details>\n<summary>🔍 证据</summary>\n\n- 本地 🧠 0.92\n- 网络 🌐 0.85\n\n</details>\n\n后文";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].title).toBe("🔍 证据");
    expect(r.blocks[0].body).toContain("🧠 0.92");
    expect(r.open).not.toContain("<details>");
    expect(r.open).toContain("前文");
    expect(r.open).toContain("后文");
  });

  it("多个 details：按出现顺序提取", () => {
    const md =
      "<details><summary>A</summary>bodyA</details>\n<details><summary>B</summary>bodyB</details>";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].title).toBe("A");
    expect(r.blocks[0].body).toBe("bodyA");
    expect(r.blocks[1].title).toBe("B");
    expect(r.blocks[1].body).toBe("bodyB");
  });

  it("未闭合 details：不提取（保持原样，由 ReactMarkdown 丢弃）", () => {
    const md = "<details><summary>X</summary>未闭合内容";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(0);
    expect(r.open).toBe(md);
  });

  it("无 summary：title 空、body 为内部全文", () => {
    const md = "<details>\n内容\n</details>";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].title).toBe("");
    expect(r.blocks[0].body).toBe("内容");
  });

  it("支持 <details open> 带属性", () => {
    const md = "<details open><summary>T</summary>body</details>";
    const r = extractDetails(md);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].title).toBe("T");
    expect(r.blocks[0].body).toBe("body");
  });
});

describe("markdownExt · splitDetails", () => {
  it("按占位 token 还原「主体 + 折叠块」有序片段", () => {
    const md = "A\n\n<details><summary>T</summary>body</details>\n\nB";
    const { open, blocks } = extractDetails(md);
    const parts = splitDetails(open, blocks);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "md", text: "A" });
    expect(parts[1]).toEqual({ type: "details", block: blocks[0] });
    expect(parts[2]).toEqual({ type: "md", text: "B" });
  });

  it("开头即折叠块：正确产出 details + 后文", () => {
    const md = "<details><summary>T</summary>body</details>\n后文";
    const { open, blocks } = extractDetails(md);
    const parts = splitDetails(open, blocks);
    expect(parts[0].type).toBe("details");
    expect(parts[1]).toEqual({ type: "md", text: "后文" });
  });

  it("仅折叠块：无 md 片段", () => {
    const md = "<details><summary>T</summary>body</details>";
    const { open, blocks } = extractDetails(md);
    const parts = splitDetails(open, blocks);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("details");
  });
});

describe("markdownExt · safeUrlTransform", () => {
  it("放行 http/https/mailto/相对路径/锚点", () => {
    expect(safeUrlTransform("https://example.com/a?b=1#c")).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(safeUrlTransform("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeUrlTransform("/relative/path")).toBe("/relative/path");
    expect(safeUrlTransform("#anchor")).toBe("#anchor");
  });

  it("放行 notion://（Notion 页面链接协议，供未来接入）", () => {
    expect(safeUrlTransform("notion://abc-123")).toBe("notion://abc-123");
  });

  it("拦截 javascript:/vbscript:/data: 危险协议", () => {
    expect(safeUrlTransform("javascript:alert(1)")).toBe("");
    expect(safeUrlTransform("vbscript:msgbox")).toBe("");
    expect(safeUrlTransform("data:text/html;base64,xxx")).toBe("");
  });
});
