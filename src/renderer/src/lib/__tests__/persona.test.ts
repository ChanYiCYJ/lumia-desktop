import { describe, it, expect } from "vitest";
import {
  extractPersonaEntity,
  normalizePersonaEntity,
  parsePersonaNotes,
  dedupePersonaNotes,
  mergePersonaNote,
} from "../persona";

describe("persona · 实体抽取（Mem0 风格）", () => {
  it("「用户喜欢X」→ 实体 X", () => {
    expect(extractPersonaEntity("用户喜欢柚子社")).toBe("柚子社");
    expect(extractPersonaEntity("- 用户喜欢柚子社")).toBe("柚子社");
  });

  it("「资料：X（已自动补充）」→ 实体 X", () => {
    expect(extractPersonaEntity("资料：柚子社（已自动补充）")).toBe("柚子社");
    expect(extractPersonaEntity("资料: 泛式（已自动补充）")).toBe("泛式");
  });

  it("剥常见前缀后取话题片段", () => {
    expect(extractPersonaEntity("偏爱日常番")).toBe("日常番");
    expect(extractPersonaEntity("喜欢看老番")).toBe("老番");
    expect(extractPersonaEntity("对推理小说感兴趣")).toBe("推理小说感兴趣");
  });

  it("归一化：去标点/空白/大小写", () => {
    expect(normalizePersonaEntity(" 柚子社 ，！")).toBe("柚子社");
    expect(normalizePersonaEntity("BanG Dream!")).toBe("bangdream");
  });

  it("空/异常输入不崩溃", () => {
    expect(extractPersonaEntity("")).toBe("");
    expect(extractPersonaEntity("   ")).toBe("");
  });
});

describe("persona · 实体链接去重", () => {
  it("同一实体多条笔记合并为最新一条", () => {
    const notes =
      "- 用户喜欢柚子社\n- 用户偏好日常番\n- 资料：柚子社（已自动补充）";
    const out = dedupePersonaNotes(notes);
    // 柚子社相关三条 → 只留最新一条（资料条目）
    expect(out).toContain("资料：柚子社");
    expect(out).not.toContain("用户喜欢柚子社");
    expect(out).toContain("日常番");
  });

  it("不同实体各自保留", () => {
    const out = dedupePersonaNotes("- 喜欢柚子社\n- 偏爱日常番\n- 怕鬼");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("上限 max 条（超限截断到最近 max 条）", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- 话题${i}`);
    const out = dedupePersonaNotes(lines.join("\n"), 5);
    expect(out.split("\n")).toHaveLength(5);
  });
});

describe("persona · mergePersonaNote", () => {
  it("新增笔记：追加并去重", () => {
    const next = mergePersonaNote("- 喜欢柚子社", "喜欢柚子社", 12);
    expect(next.split("\n")).toHaveLength(1);
    expect(next).toContain("柚子社");
  });

  it("同实体重复笔记：不重复堆积", () => {
    const a = mergePersonaNote("- 喜欢柚子社", "更爱柚子社了", 12);
    expect(a.split("\n")).toHaveLength(1);
    const b = mergePersonaNote(a, "资料：柚子社（已自动补充）", 12);
    // 三种说法都归到「柚子社」实体 → 只留最新一条
    expect(b.split("\n")).toHaveLength(1);
    expect(b).toContain("资料：柚子社");
  });

  it("空输入安全", () => {
    expect(mergePersonaNote("", "怕鬼", 12)).toBe("- 怕鬼");
    expect(mergePersonaNote("", "", 12)).toBe("");
  });
});

describe("persona · parsePersonaNotes", () => {
  it("解析多行笔记为实体数组", () => {
    const notes = parsePersonaNotes("- 喜欢柚子社\n- 怕鬼");
    expect(notes).toHaveLength(2);
    expect(notes[0].entity).toBe("柚子社");
    expect(notes[1].entity).toBe("怕鬼");
  });
});
