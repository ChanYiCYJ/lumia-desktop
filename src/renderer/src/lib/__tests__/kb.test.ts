import { describe, it, expect, beforeEach } from "vitest";
import {
  parseKbTool,
  findKbNoteByTitle,
  loadEditorDrafts,
  addEditorDraft,
  removeEditorDraft,
  saveKbEntry,
  loadKbEntries,
  detectKbSaveIntent,
  deriveEntryTitle,
  kbParentKey,
  isKbDescendant,
  reorderKbEntries,
  reparentKbEntry,
  type KbEntryRecord,
  type KbNote,
} from "../kb";

beforeEach(() => {
  localStorage.clear();
});

describe("kb · parseKbTool（AI 创建/编辑/删除知识库指令）", () => {
  it("解析 KB-SAVE（新建/更新）", () => {
    const r = parseKbTool(
      "先保存一下：[KB-SAVE:React 要点]React 是 UI 库[/KB-SAVE]",
    );
    expect(r).toEqual({
      mode: "save",
      title: "React 要点",
      content: "React 是 UI 库",
    });
  });
  it("解析 KB-EDIT（修改）", () => {
    const r = parseKbTool(
      "更新它：[KB-EDIT:React 要点]React 是用于构建界面的库[/KB-EDIT]",
    );
    expect(r).toEqual({
      mode: "edit",
      title: "React 要点",
      content: "React 是用于构建界面的库",
    });
  });
  it("内容可含多行与括号", () => {
    const r = parseKbTool(
      "[KB-SAVE: 部署说明 ]\n# 部署\n- 用 `wrangler deploy`\n[/KB-SAVE]",
    );
    expect(r?.mode).toBe("save");
    expect(r?.title).toBe("部署说明");
    expect(r?.content).toContain("wrangler deploy");
  });
  it("无指令返回 null", () => {
    expect(parseKbTool("普通回复，没有工具调用")).toBeNull();
    expect(parseKbTool("")).toBeNull();
  });
  it("未闭合标签容错（AI 常漏写结束标签）", () => {
    const r = parseKbTool("[KB-SAVE:标题]没有闭合标签");
    expect(r?.mode).toBe("save");
    expect(r?.title).toBe("标题");
    expect(r?.content).toBe("没有闭合标签");
  });
  it("解析 KB-DELETE（删除，含同步删 Notion）", () => {
    const r = parseKbTool("好的，删掉它：[KB-DELETE:React 要点]");
    expect(r).toEqual({ mode: "delete", title: "React 要点", content: "" });
  });
  it("KB-SAVE 未闭合时不被后续 KB-DELETE 吞掉", () => {
    const r = parseKbTool("[KB-SAVE:标题]内容没闭合[KB-DELETE:另一个]");
    expect(r?.mode).toBe("save");
    expect(r?.title).toBe("标题");
    expect(r?.content).toBe("内容没闭合");
  });
});

describe("kb · findKbNoteByTitle", () => {
  const notes: KbNote[] = [
    { id: "1", title: "React 要点", content: "a", createdAt: 1 },
    { id: "2", title: " 部署说明 ", content: "b", createdAt: 2 },
  ];
  it("忽略大小写与首尾空格匹配", () => {
    expect(findKbNoteByTitle(notes, "react 要点")?.id).toBe("1");
    expect(findKbNoteByTitle(notes, "部署说明")?.id).toBe("2");
  });
  it("未命中返回 undefined", () => {
    expect(findKbNoteByTitle(notes, "不存在")).toBeUndefined();
  });
});

describe("kb · detectKbSaveIntent（AI 漏发 [KB-SAVE:] 时前端兜底）", () => {
  it("「帮我记一下：内容」提取内容与标题（标题=首行前 30 字）", () => {
    const r = detectKbSaveIntent("帮我记一下：我喜欢柚子社的galgame，画风精致");
    expect(r?.title).toBe("我喜欢柚子社的galgame，画风精致");
    expect(r?.content).toBe("我喜欢柚子社的galgame，画风精致");
  });
  it("「保存到知识库：xxx」", () => {
    const r = detectKbSaveIntent("保存到知识库：React 的 useState 用法");
    expect(r?.content).toBe("React 的 useState 用法");
  });
  it("「收藏」表达", () => {
    const r = detectKbSaveIntent("收藏一下：这个配色方案");
    expect(r?.content).toBe("这个配色方案");
  });
  it("无保存意图返回 null（避免误触发）", () => {
    expect(detectKbSaveIntent("你好，今天天气不错")).toBeNull();
    expect(detectKbSaveIntent("记住要幽默一点")).toBeNull();
    expect(detectKbSaveIntent("帮我搜索一下柚子社新作")).toBeNull();
  });
  it("意图词但内容为空返回 null", () => {
    expect(detectKbSaveIntent("帮我记一下")).toBeNull();
  });
});

describe("kb · saveKbEntry（AI 保存知识库）", () => {
  it("新建条目并同步到 kimo_kb_notes", () => {
    const e = saveKbEntry("React 要点", "React 是 UI 库");
    expect(e.name).toBe("React 要点");
    expect(loadKbEntries()).toHaveLength(1);
    const notes = JSON.parse(localStorage.getItem("kimo_kb_notes") || "[]");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("React 要点");
  });
  it("按标题更新已有条目（忽略大小写/空格，不新增）", () => {
    saveKbEntry("React 要点", "v1");
    const e = saveKbEntry(" react 要点 ", "v2");
    expect(e.content).toBe("v2");
    expect(loadKbEntries()).toHaveLength(1);
    expect(loadKbEntries()[0].content).toBe("v2");
  });
});

describe("kb · deriveEntryTitle（无独立标题框：H1 优先 / 首行 30 字）", () => {
  it("H1 优先作为标题", () => {
    expect(deriveEntryTitle("# 周报总结\n本周完成了三件事")).toBe("周报总结");
  });
  it("H1 带行内格式：去除 markdown 标记", () => {
    expect(deriveEntryTitle("# **产品**方案\n正文")).toBe("产品方案");
  });
  it("无 H1：取首行前 30 字", () => {
    const long =
      "这是一个非常非常非常非常非常非常非常非常非常长的首行内容，用来验证截断逻辑";
    expect(deriveEntryTitle(long)).toBe(long.slice(0, 30));
  });
  it("无 H1：首行含列表/引用/链接标记时去除", () => {
    expect(deriveEntryTitle("- 待办事项\n- 买牛奶")).toBe("待办事项");
    expect(deriveEntryTitle("> 引用一句话\n正文")).toBe("引用一句话");
    expect(deriveEntryTitle("[链接](https://a.b)\n正文")).toBe("链接");
  });
  it("空内容/无可读文本回退 fallback", () => {
    expect(deriveEntryTitle("")).toBe("我的笔记");
    expect(deriveEntryTitle("   ")).toBe("我的笔记");
    expect(deriveEntryTitle("   ", "默认标题")).toBe("默认标题");
    expect(deriveEntryTitle("#  \n正文", "备选")).toBe("备选");
  });
});

describe("kb · 编辑器临时草稿", () => {
  it("默认无草稿", () => {
    expect(loadEditorDrafts()).toEqual([]);
  });
  it("保存后可读取（自动命名）", () => {
    addEditorDraft("第一条内容");
    addEditorDraft("第二条内容", "自定义名");
    const drafts = loadEditorDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts[0].content).toBe("第二条内容");
    expect(drafts[0].name).toBe("自定义名");
    expect(drafts[1].name).toContain("草稿");
  });
  it("删除草稿", () => {
    addEditorDraft("x");
    const id = loadEditorDrafts()[0].id;
    removeEditorDraft(id);
    expect(loadEditorDrafts()).toEqual([]);
  });
});

describe("kb · 页面树：分组/排序/改父（order 与层级）", () => {
  const mk = (
    id: string,
    name: string,
    extra: Partial<KbEntryRecord> = {},
  ): KbEntryRecord => ({
    id,
    name,
    content: `# ${name}`,
    createdAt: 1,
    ...extra,
  });

  it("kbParentKey：父在条目集=子页；父缺失/容器页=顶层；本地用 parentId", () => {
    const entries = [
      mk("a", "A", { notionId: "na" }),
      mk("b", "B", {
        notionId: "nb",
        notionParentId: "na",
        notionParentName: "A",
      }),
      mk("c", "C", { notionId: "nc", notionParentId: "container" }), // 容器页不在条目集
      mk("d", "D", { parentId: "a" }), // 未同步条目用本地 parentId
    ];
    expect(kbParentKey(entries[0], entries)).toBe("");
    expect(kbParentKey(entries[1], entries)).toBe("na");
    expect(kbParentKey(entries[2], entries)).toBe(""); // 容器页非条目 → 顶层
    expect(kbParentKey(entries[3], entries)).toBe("a"); // 本地父 → 父条目本地 id
  });

  it("isKbDescendant：本地 parentId 后代判定", () => {
    const entries = [
      mk("a", "A", {}),
      mk("b", "B", { parentId: "a" }),
      mk("c", "C", { parentId: "b" }),
    ];
    expect(isKbDescendant(entries, "a", "c")).toBe(true);
    expect(isKbDescendant(entries, "b", "a")).toBe(false);
  });

  it("reorderKbEntries：重排兄弟并重编号，不碰其他组", () => {
    const entries = [
      mk("a", "A", { notionId: "na", order: 0 }),
      mk("b", "B", { notionId: "nb", order: 1 }),
      mk("c", "C", { notionId: "nc", notionParentId: "na", order: 0 }),
    ];
    const nx = reorderKbEntries(entries, "", ["b", "a"]);
    expect(nx.find((e) => e.id === "a")?.order).toBe(1);
    expect(nx.find((e) => e.id === "b")?.order).toBe(0);
    expect(nx.find((e) => e.id === "c")?.order).toBe(0); // 子页组不受影响
  });

  it("reparentKbEntry：改父 + 旧兄弟重排 + 新兄弟末尾 + 继承根", () => {
    const entries = [
      mk("a", "A", {
        notionId: "na",
        notionRootId: "kroot",
        notionRootName: "知识库",
        order: 0,
      }),
      mk("b", "B", {
        notionId: "nb",
        notionRootId: "kroot",
        notionRootName: "知识库",
        order: 1,
      }),
      mk("x", "X", {
        notionId: "nx",
        notionRootId: "kroot",
        notionRootName: "知识库",
        order: 0,
      }),
    ];
    const nx = reparentKbEntry(entries, "b", "a"); // newParentId = 父条目本地 id
    const b = nx.find((e) => e.id === "b")!;
    expect(b.notionParentId).toBe("na");
    expect(b.notionParentName).toBe("A");
    expect(b.notionRootId).toBe("kroot");
    expect(b.order).toBe(0); // a 下第一个孩子
    expect(nx.find((e) => e.id === "a")?.order).toBe(0); // 顶层 a 未变
    expect(nx.find((e) => e.id === "x")?.order).toBe(1); // 顶层移除 b 后重排：a,x
  });

  it("reparentKbEntry：本地条目用 parentId 关联（未同步父）", () => {
    const entries = [
      mk("p", "父", {}),
      mk("c", "子", { parentId: "p" }),
      mk("x", "X", {}),
    ];
    const nx = reparentKbEntry(entries, "x", "p");
    const x = nx.find((e) => e.id === "x")!;
    const p = nx.find((e) => e.id === "p")!;
    expect(x.parentId).toBe("p");
    expect(x.notionParentId).toBeUndefined();
    expect(x.order).toBe(1); // p 下追加（c 之后）
    expect(p.order).toBe(0); // 顶层只剩 p → 重排
  });

  it("reparentKbEntry：移到顶层清空父、保留根、重排旧兄弟", () => {
    const entries = [
      mk("a", "A", { notionId: "na", notionRootId: "kroot" }),
      mk("b", "B", {
        notionId: "nb",
        notionParentId: "na",
        notionParentName: "A",
        notionRootId: "kroot",
        order: 0,
      }),
      mk("c", "C", {
        notionId: "nc",
        notionParentId: "na",
        notionParentName: "A",
        notionRootId: "kroot",
        order: 1,
      }),
    ];
    const nx = reparentKbEntry(entries, "b", "");
    const b = nx.find((e) => e.id === "b")!;
    expect(b.notionParentId).toBeUndefined();
    expect(b.notionParentName).toBeUndefined();
    expect(b.notionRootId).toBe("kroot");
    expect(b.order).toBe(1); // 顶层新兄弟 = [a] → 末尾追加
    expect(nx.find((e) => e.id === "c")?.order).toBe(0); // a 下只剩 c → 重排
  });
});
