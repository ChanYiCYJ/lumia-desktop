import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPersonaMode,
  savePersonaMode,
  loadLoreToKb,
  saveLoreToKb,
  loadLore,
  loadAllLore,
  saveLore,
  clearLore,
  loreSearchQuery,
  buildLorePrompt,
  loreToText,
  L2D_LORE_PREFIX,
  type Live2dLore,
  type Live2dPersonaMode,
} from "../live2dLore";

beforeEach(() => {
  localStorage.clear();
});

const SAMPLE: Live2dLore = {
  model: "001_casual",
  name: "户山 香澄",
  world:
    "《BanG Dream!》世界观：香澄生活在一个热爱音乐的少女们组成乐队的世界，梦想是闪闪发光的舞台。",
  personality: "开朗元气、充满梦想，有点天然呆但非常重视伙伴。",
  tone: "活泼热情，经常用感叹号，称呼伙伴为「大家」。",
  background:
    "因为小时候看到星空般闪耀的演唱会而立志组建乐队，是 Poppin'Party 的吉他手兼主唱。",
  likes: "音乐、星星、闪耀的事物、和伙伴一起合奏。",
  relations: "Poppin'Party 的成员：多惠、里美、沙绫、有咲。",
  notes: "官方设定：乐器为 ESP 吉他；代表色为红色。",
  searched: true,
  updatedAt: 0,
};

describe("loadPersonaMode / savePersonaMode", () => {
  it("默认角色设定（role，Live2D 人格）", () => {
    expect(loadPersonaMode()).toBe("role");
  });
  it("保存 prompt 后读取为 prompt，保存 role 后读取 role", () => {
    savePersonaMode("prompt");
    expect(loadPersonaMode()).toBe("prompt");
    savePersonaMode("role");
    expect(loadPersonaMode()).toBe("role");
  });
  it("非法值回退 role（默认 Live2D 人格）", () => {
    localStorage.setItem("kimo_live2d_persona_mode", "xxx");
    expect(loadPersonaMode()).toBe("role");
  });
});

describe("loadLoreToKb / saveLoreToKb（知识库隔离）", () => {
  it("默认隔离（不写入用户知识库）", () => {
    expect(loadLoreToKb()).toBe(false);
  });
  it("开启后读取 true，关闭后 false", () => {
    saveLoreToKb(true);
    expect(loadLoreToKb()).toBe(true);
    saveLoreToKb(false);
    expect(loadLoreToKb()).toBe(false);
  });
});

describe("saveLore / loadLore / clearLore", () => {
  it("保存后可读取，且字段完整", () => {
    saveLore("001_casual", SAMPLE);
    const l = loadLore("001_casual");
    expect(l?.name).toBe("户山 香澄");
    expect(l?.world).toContain("BanG Dream");
    expect(l?.searched).toBe(true);
  });
  it("无档案时返回 null", () => {
    expect(loadLore("001_casual")).toBe(null);
    expect(loadLore("")).toBe(null);
  });
  it("损坏 JSON 返回 null", () => {
    localStorage.setItem(L2D_LORE_PREFIX + "x", "{bad json");
    expect(loadLore("x")).toBe(null);
  });
  it("按模型隔离，互不影响", () => {
    saveLore("001_casual", SAMPLE);
    expect(loadLore("002_casual")).toBe(null);
  });
  it("clearLore 删除后返回 null", () => {
    saveLore("001_casual", SAMPLE);
    clearLore("001_casual");
    expect(loadLore("001_casual")).toBe(null);
  });
});

describe("loreSearchQuery", () => {
  it("内置 BanG Dream 角色带上作品与设定词", () => {
    const q = loreSearchQuery("户山 香澄", "001_casual");
    expect(q).toContain("户山 香澄");
    expect(q).toContain("BanG Dream");
    expect(q).toContain("性格");
  });
  it("第三方模型不带作品名", () => {
    const q = loreSearchQuery("shizuku", "https://example.com/model.json");
    expect(q).toContain("shizuku");
    expect(q).not.toContain("BanG Dream");
  });
  it("空名返回空串", () => {
    expect(loreSearchQuery("", "001_casual")).toBe("");
  });
});

describe("buildLorePrompt", () => {
  it("生成含角色名与各设定分项的人格提示", () => {
    const p = buildLorePrompt(SAMPLE);
    expect(p).toContain("户山 香澄");
    expect(p).toContain("世界观");
    expect(p).toContain("性格");
    expect(p).toContain("背景故事");
    expect(p).toContain("补充资料（可信设定）");
  });
  it("空档案返回空串", () => {
    expect(buildLorePrompt(null as unknown as Live2dLore)).toBe("");
  });
});

describe("loreToText", () => {
  it("生成结构化知识库 Markdown", () => {
    const t = loreToText(SAMPLE);
    expect(t).toContain("# 「户山 香澄」角色设定档案");
    expect(t).toContain("## 世界观");
    expect(t).toContain("## 性格");
    expect(t).toContain("## 资料笔记");
    expect(t).toContain("AI 自动搜索");
  });
  it("空字段的分节被省略", () => {
    const empty: Live2dLore = {
      ...SAMPLE,
      world: "",
      personality: "开朗",
      likes: "",
      relations: "",
      notes: "",
    };
    const t = loreToText(empty);
    expect(t).not.toContain("## 世界观");
    expect(t).toContain("## 性格");
    expect(t).not.toContain("## 喜好与擅长");
  });
});

describe("type 约束", () => {
  it("Live2dPersonaMode 只接受 prompt/role", () => {
    const m: Live2dPersonaMode = "role";
    expect(["prompt", "role"]).toContain(m);
  });
});

describe("loadAllLore（知识库面板角色设定分区）", () => {
  it("无档案返回空数组", () => {
    expect(loadAllLore()).toEqual([]);
  });
  it("返回全部角色档案并按更新时间倒序", () => {
    saveLore("001_casual", { ...SAMPLE, model: "001_casual", updatedAt: 100 });
    saveLore("002_casual", {
      ...SAMPLE,
      model: "002_casual",
      name: "花园 多惠",
      updatedAt: 300,
    });
    const all = loadAllLore();
    expect(all.length).toBe(2);
    // 更新时间大的在前
    expect(all[0].model).toBe("002_casual");
    expect(all[1].model).toBe("001_casual");
  });
});
