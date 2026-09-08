import { describe, it, expect } from "vitest";
import { isSiteDocQuery, isKnowledgeFusionQuery, SITE_DOC_TEXT } from "../siteDoc";

describe("isSiteDocQuery 本站操作文档命中判断", () => {
  it("明确指向本站 + 询问怎么用/功能", () => {
    expect(isSiteDocQuery("这个站怎么用")).toBe(true);
    expect(isSiteDocQuery("本站有哪些功能")).toBe(true);
    expect(isSiteDocQuery("这个网站怎么操作")).toBe(true);
    expect(isSiteDocQuery("这个站点怎么发布文章")).toBe(true);
    expect(isSiteDocQuery("这个站怎么配置自定义模型")).toBe(true);
  });

  it("直接提文档/操作说明/功能说明", () => {
    expect(isSiteDocQuery("介绍一下这个站点的使用文档")).toBe(true);
    expect(isSiteDocQuery("本站操作文档")).toBe(true);
    expect(isSiteDocQuery("有没有使用说明")).toBe(true);
    expect(isSiteDocQuery("站点功能说明")).toBe(true);
  });

  it("本站独有功能 + 操作意图（无需本站锚定）", () => {
    expect(isSiteDocQuery("怎么配置自定义模型")).toBe(true);
    expect(isSiteDocQuery("Live2D 怎么换角色")).toBe(true);
    expect(isSiteDocQuery("如何开启网络模式")).toBe(true);
    expect(isSiteDocQuery("数据管理怎么导出数据")).toBe(true);
    expect(isSiteDocQuery("角色设定在哪设置")).toBe(true);
  });

  it("本站通用功能 + 本站锚定", () => {
    expect(isSiteDocQuery("这个站的知识库怎么用")).toBe(true);
    expect(isSiteDocQuery("本站怎么登录后台管理")).toBe(true);
  });

  it("与本站无关的提问不命中", () => {
    expect(isSiteDocQuery("怎么用 React 写代码")).toBe(false);
    expect(isSiteDocQuery("帮我写一段代码")).toBe(false);
    expect(isSiteDocQuery("介绍一下 React")).toBe(false);
    expect(isSiteDocQuery("今天天气怎么样")).toBe(false);
    expect(isSiteDocQuery("")).toBe(false);
    expect(isSiteDocQuery("   ")).toBe(false);
    expect(isSiteDocQuery("知识库怎么设计（通用技术话题）")).toBe(false);
  });
});

describe("SITE_DOC_TEXT 内容", () => {
  it("覆盖本站核心操作板块", () => {
    expect(SITE_DOC_TEXT).toContain("对话基础");
    expect(SITE_DOC_TEXT).toContain("网络模式");
    expect(SITE_DOC_TEXT).toContain("自定义模型");
    expect(SITE_DOC_TEXT).toContain("知识库");
    expect(SITE_DOC_TEXT).toContain("Live2D");
    expect(SITE_DOC_TEXT).toContain("Agent 工具箱");
    expect(SITE_DOC_TEXT).toContain("合规");
  });
});

describe("isKnowledgeFusionQuery 知识融合意图判断", () => {
  it("显式要求结合知识库与网络/搜索", () => {
    expect(
      isKnowledgeFusionQuery("结合知识库和搜索结果的资料总结一下"),
    ).toBe(true);
    expect(isKnowledgeFusionQuery("综合一下本地知识和网络上的信息")).toBe(true);
    expect(isKnowledgeFusionQuery("把知识库和搜索到的资料对比一下")).toBe(true);
  });

  it("融合/归纳动词 + 资料范围锚定", () => {
    expect(isKnowledgeFusionQuery("总结一下这些资料")).toBe(true);
    expect(isKnowledgeFusionQuery("对比一下这两个来源的信息")).toBe(true);
    expect(isKnowledgeFusionQuery("结合以上资料给我总结")).toBe(true);
    expect(isKnowledgeFusionQuery("根据知识库和网络搜索结果归纳一下")).toBe(true);
  });

  it("明确多源指向 + 综合意图", () => {
    expect(isKnowledgeFusionQuery("根据以上内容整理一份报告")).toBe(true);
    expect(isKnowledgeFusionQuery("基于这些结果给出结论")).toBe(true);
    expect(isKnowledgeFusionQuery("综合以上资料分析一下")).toBe(true);
  });

  it("日常词不命中（保守，避免误触发）", () => {
    expect(isKnowledgeFusionQuery("综合国力是什么")).toBe(false);
    expect(isKnowledgeFusionQuery("结合实际情况分析一下")).toBe(false);
    expect(isKnowledgeFusionQuery("总结一下怎么写代码")).toBe(false);
    expect(isKnowledgeFusionQuery("对比一下这两个手机")).toBe(false);
    expect(isKnowledgeFusionQuery("根据这个资料回答")).toBe(false);
    expect(isKnowledgeFusionQuery("今天天气怎么样")).toBe(false);
    expect(isKnowledgeFusionQuery("")).toBe(false);
    expect(isKnowledgeFusionQuery("   ")).toBe(false);
  });
});
