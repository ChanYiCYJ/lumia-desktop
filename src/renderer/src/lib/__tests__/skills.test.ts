import { describe, it, expect } from "vitest";
import { assembleSystem, clamp, type SkillContext } from "../skills";

/** 便捷构造：给定上下文，组装 system */
function sys(over: Partial<SkillContext> = {}): string {
  return assembleSystem(over);
}

/** 断言 system 包含/不包含某段标记 */
function has(sysStr: string, needle: string): boolean {
  return sysStr.includes(needle);
}

describe("skills · assembleSystem 段注入", () => {
  it("空上下文：仅保留核心指令段（工具说明 + 知识库操作），无 Live2D", () => {
    const s = sys({});
    expect(s).toContain("工具使用说明");
    expect(s).toContain("【知识库操作");
    expect(s).not.toContain("【Live2D 角色】");
    expect(s).not.toContain("【Live2D 动作指令");
    expect(s).not.toContain("【快速模式 Fast】");
    expect(s).not.toContain("【智能模式 Auto】");
    expect(s).not.toContain("【联网搜索模式】");
  });

  it("开启朗读（ttsMode）：注入朗读模式段，明确禁止动作描写/旁白", () => {
    const s = sys({ ttsMode: true });
    expect(s).toContain("【语音朗读模式】");
    expect(s).toContain("像真人一样说话");
    expect(s).toContain("禁止任何括号动作描写");
    expect(s).toContain("[表情:开心]"); // Live2D 指令照常可附
  });

  it("人格：lorePrompt 优先于 systemPrompt，且无多余分隔符开头", () => {
    const s = sys({
      lorePrompt: "你是「户山 香澄」。",
      systemPrompt: "你是通用助手",
    });
    expect(s.startsWith("你是「户山 香澄」。")).toBe(true);
    expect(s).not.toContain("你是通用助手");
  });

  it("知识库在最前，且按 6000 截断", () => {
    const kb = "K".repeat(9000);
    const s = sys({ knowledge: kb, systemPrompt: "你是一般助手" });
    expect(s.startsWith("【重要】你必须优先基于以下用户知识库回答")).toBe(true);
    expect(s).toContain("你是一般助手");
    // 6000 字符 + 省略号，未超
    expect(s.length).toBeLessThan(8000);
  });

  it("pureRole：跳过记忆与人格笔记，但保留人格主体", () => {
    const s = sys({
      memory: "用户喜欢柚子社",
      personaKnowledge: "偏爱日常番",
      systemPrompt: "你是角色",
      pureRole: true,
    });
    expect(s).toContain("你是角色");
    expect(s).not.toContain("过往对话中学习到的用户偏好");
    expect(s).not.toContain("auto-knowledge 人格笔记");
  });

  it("非 pureRole：注入记忆 + 人格笔记", () => {
    const s = sys({
      memory: "用户喜欢柚子社",
      personaKnowledge: "偏爱日常番",
    });
    expect(s).toContain("过往对话中学习到的用户偏好");
    expect(s).toContain("auto-knowledge 人格笔记");
  });

  it("Live2D 关闭：不注入表情/动作指令段（省 token）", () => {
    const s = sys({ l2dEnabled: false });
    expect(has(s, "[表情:")).toBe(false);
    expect(has(s, "PARAM")).toBe(false);
  });

  it("Live2D 开启：注入表情标签 + 动作指令段", () => {
    const s = sys({ l2dEnabled: true });
    expect(s).toContain("【Live2D 角色】");
    expect(s).toContain("【Live2D 动作指令");
    expect(has(s, "[表情:")).toBe(true);
    expect(has(s, "PARAM")).toBe(true);
  });

  it("模式互斥：同时开启 Fast/Auto/browse 只产出 Fast", () => {
    const s = sys({
      fastMode: true,
      autoMode: true,
      browseMode: true,
    });
    expect(s).toContain("【快速模式 Fast】");
    expect(s).not.toContain("【智能模式 Auto】");
    expect(s).not.toContain("【联网搜索模式】");
  });

  it("Auto 模式只注入 Auto 段", () => {
    const s = sys({ autoMode: true });
    expect(s).toContain("【智能模式 Auto】");
    expect(s).not.toContain("【快速模式 Fast】");
    expect(s).not.toContain("【联网搜索模式】");
  });

  it("browseMode：注入联网搜索模式段 + [VIEW:] 指令", () => {
    const s = sys({
      browseMode: true,
      viewArticle: "这是一篇完整文章。\n\n正文……",
    });
    expect(s).toContain("【联网搜索模式】");
    expect(s).toContain("[VIEW:内容]");
    expect(s).toContain("[VIEW:修改后的完整文章]");
  });
});

describe("skills · 工具说明段", () => {
  it("webTools=false：无 [SEARCH:] / [BROWSE:]", () => {
    const s = sys({ webTools: false });
    expect(has(s, "[SEARCH:")).toBe(false);
    expect(has(s, "[BROWSE:")).toBe(false);
    // EDIT 始终保留
    expect(has(s, "[EDIT:")).toBe(true);
  });

  it("webTools=true：注入 [SEARCH:] / [BROWSE:] + 当天日期", () => {
    const s = sys({ webTools: true });
    expect(has(s, "[SEARCH:")).toBe(true);
    expect(has(s, "[BROWSE:")).toBe(true);
    expect(has(s, "今天是 ")).toBe(true);
  });
});

describe("skills · 知识融合段", () => {
  it("knowledgeFusion=true 且有内容源：注入融合指令", () => {
    const s = sys({
      knowledgeFusion: true,
      knowledge: "本地知识",
      web: "网络结果",
    });
    expect(s).toContain("【知识融合】");
    expect(s).toContain("🧠 本地");
    expect(s).toContain("🌐 网络");
    expect(s).toContain("> 💡 **核心结论**");
    expect(s).toContain("<details>");
  });

  it("knowledgeFusion=true 但无内容源：不注入（省 token）", () => {
    const s = sys({ knowledgeFusion: true });
    expect(s).not.toContain("【知识融合】");
  });

  it("knowledgeFusion=false：即使有内容源也不注入", () => {
    const s = sys({ knowledge: "本地知识", web: "网络结果" });
    expect(s).not.toContain("【知识融合】");
  });

  it("memory/personaKnowledge 也计为内容源", () => {
    const s = sys({ knowledgeFusion: true, memory: "用户偏好" });
    expect(s).toContain("【知识融合】");
  });

  it("融合段覆盖三源标注（含 📓 Notion）", () => {
    const s = sys({
      knowledgeFusion: true,
      knowledge: "本地知识",
      notion: "Notion 内容",
      web: "网络结果",
    });
    expect(s).toContain("【知识融合】");
    expect(s).toContain("🧠 本地");
    expect(s).toContain("Notion 工作区");
    expect(s).toContain("🌐 网络");
    expect(s).toContain("last_edited_time");
    expect(s).not.toContain("📓"); // Notion 来源标注已从 emoji 改为文字
  });
});

describe("skills · Notion 段", () => {
  it("notion 内容存在：注入 Notion 资料段（含当天日期）", () => {
    const s = sys({
      notion: "【Notion 资料📓】以下是当前 Notion Workspace 中检索到的相关内容：\n- 项目计划",
    });
    expect(s).toContain("当前 Notion Workspace");
    expect(s).toContain("项目计划");
    expect(s).toContain("今天是 ");
  });

  it("notionIntent=true 无内容：注入诚实降级提示（不编造）", () => {
    const s = sys({ notionIntent: true });
    expect(s).toContain("【Notion 提示】");
    expect(s).toContain("还没有配置 Notion 连接");
    expect(s).toContain("不要编造");
  });

  it("无 notion/notionIntent：不注入 Notion 段", () => {
    const s = sys({});
    expect(s).not.toContain("【Notion 资料📓】");
    expect(s).not.toContain("【Notion 提示】");
  });
});

describe("skills · 上下文段 clamp 上限", () => {
  it("memory / summary / web / view / viewIntro / personaNotes 各自限长", () => {
    const s = sys({
      memory: "M".repeat(4000),
      personaKnowledge: "P".repeat(4000),
      summary: "S".repeat(4000),
      web: "W".repeat(10000),
      viewArticle: "V".repeat(9000),
      viewIntro: "I".repeat(3000),
      l2dEnabled: false,
    });
    // web 段 6000 截断，不会 10000 全进
    expect(has(s, "W".repeat(6001))).toBe(false);
    // view 全文 4000 截断
    expect(has(s, "V".repeat(4001))).toBe(false);
    // memory 2000 截断
    expect(has(s, "M".repeat(2001))).toBe(false);
    // 总长受控：即使给了 4 万字符上下文，system 也在 ~1.6 万内（指令段固定 + 上下文各 clamp）
    expect(s.length).toBeLessThan(20000);
  });

  it("段顺序：knowledge → persona → memory → summary → view → live2d", () => {
    const s = sys({
      knowledge: "知识内容",
      memory: "记忆内容",
      summary: "摘要内容",
      web: "网络内容",
      viewArticle: "文章内容",
      viewIntro: "简介内容",
      systemPrompt: "人格内容",
      l2dEnabled: true,
    });
    const idxKnowledge = s.indexOf("【重要】你必须优先基于以下用户知识库回答");
    const idxPersona = s.indexOf("人格内容");
    const idxMemory = s.indexOf("过往对话中学习到的用户偏好");
    const idxSummary = s.indexOf("对话上下文摘要");
    const idxWeb = s.indexOf("以下是来自网络的最新搜索结果");
    const idxView = s.indexOf("【当前浏览文章】以下是 View 面板");
    const idxLive2d = s.indexOf("【Live2D 角色】");
    expect(idxKnowledge).toBeGreaterThanOrEqual(0);
    expect(idxPersona).toBeGreaterThan(idxKnowledge);
    expect(idxMemory).toBeGreaterThan(idxPersona);
    expect(idxSummary).toBeGreaterThan(idxMemory);
    expect(idxWeb).toBeGreaterThan(idxSummary);
    expect(idxView).toBeGreaterThan(idxWeb);
    expect(idxLive2d).toBeGreaterThan(idxView);
  });
});

describe("skills · clamp 工具", () => {
  it("超长截断 + 省略号；短文本原样", () => {
    expect(clamp("abc", 2)).toBe("ab…");
    expect(clamp("abc", 10)).toBe("abc");
    expect(clamp("", 10)).toBe("");
  });
});
