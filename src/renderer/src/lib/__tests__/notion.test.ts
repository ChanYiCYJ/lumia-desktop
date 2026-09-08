import { describe, it, expect, beforeEach } from "vitest";
import {
  loadNotionCfg,
  saveNotionCfg,
  clearNotionCfg,
  hasNotionCfg,
  loadNotionSel,
  saveNotionSel,
  hasNotionSel,
  notionRequest,
  pageTitle,
  blockText,
  parseSearchResponse,
  parseBlocks,
  isNotionQuery,
  isPersonalKnowledgeQuery,
  buildNotionContext,
  fetchNotionContext,
  fetchNotionPageList,
  fetchNotionSelectedContent,
  testNotionConnection,
  fetchNotionDatabases,
  parseDatabaseSchema,
  resolveDbTitleProperty,
  propValueText,
  parseDatabaseRows,
  queryNotionDatabase,
  buildDbFilter,
  buildNotionDbContext,
  contentToBlocks,
  buildDbPageProperties,
  createNotionPageInDatabase,
  createNotionSubPage,
  appendNotionBlocks,
  replaceNotionPageContent,
  updateNotionPageProps,
  findNotionPageByTitle,
  resolveMainDatabaseId,
  fetchNotionPageText,
  saveNotionDbId,
  resetNotionCaches,
  resolveNotionRoots,
  type NotionSearchResult,
} from "../notion";

function mockFetch(status: number, data: unknown) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe("notion · 配置", () => {
  beforeEach(() => localStorage.clear());

  it("保存/读取/清除 Token", () => {
    expect(hasNotionCfg()).toBe(false);
    saveNotionCfg({ token: " secret_123 " });
    expect(loadNotionCfg().token).toBe("secret_123");
    expect(hasNotionCfg()).toBe(true);
    clearNotionCfg();
    expect(hasNotionCfg()).toBe(false);
  });

  it("知识库来源分区选中：保存/读取（去重、上限 20、损坏回退）", () => {
    expect(hasNotionSel()).toBe(false);
    saveNotionSel({ pageIds: ["a", "b", "a"] });
    expect(hasNotionSel()).toBe(true);
    const sel = loadNotionSel();
    expect(sel.pageIds).toEqual(["a", "b"]);
    localStorage.setItem("kimo_notion_sel", '{"pageIds":[1,2,"c"]}');
    expect(loadNotionSel().pageIds).toEqual(["c"]);
    localStorage.setItem("kimo_notion_sel", "bad");
    expect(loadNotionSel().pageIds).toEqual([]);
  });
});

describe("notion · 解析纯函数", () => {
  it("pageTitle：从 title 属性提取标题", () => {
    expect(
      pageTitle({
        Name: { type: "title", title: [{ plain_text: "项目计划" }] },
      }),
    ).toBe("项目计划");
    expect(pageTitle({ Status: { type: "select", select: null } })).toBe("");
    expect(pageTitle(undefined)).toBe("");
  });

  it("pageTitle：数据库 title 属性定义({})不崩溃（回归）", () => {
    // 数据库在 properties 里的 title 属性是 {} 对象而非数组，不得触发 .map 崩溃
    expect(
      pageTitle({ title: { id: "title", type: "title", title: {} } }),
    ).toBe("");
  });

  it("blockText：paragraph/list 取 rich_text；无正文块返回空", () => {
    expect(
      blockText({
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "本周目标" }] },
      }),
    ).toBe("本周目标");
    expect(blockText({ type: "image", image: {} })).toBe("");
  });

  it("parseSearchResponse：解析 page/database，跳过非法项", () => {
    const r = parseSearchResponse({
      results: [
        {
          object: "page",
          id: "p1",
          url: "https://www.notion.so/x",
          last_edited_time: "2026-08-01T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "A" }] } },
        },
        { object: "database", id: "d1", title: [] },
        { object: "page" }, // 无 id → 跳过
      ],
    });
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe("A");
    expect(r[0].type).toBe("page");
    expect(r[1].type).toBe("database");
  });

  it("parseSearchResponse：数据库顶层 title 数组被提取", () => {
    const r = parseSearchResponse({
      results: [
        {
          object: "database",
          id: "db1",
          title: [{ plain_text: "任务看板" }],
          properties: { title: { id: "title", type: "title", title: {} } },
        },
      ],
    });
    expect(r[0].title).toBe("任务看板");
    expect(r[0].type).toBe("database");
  });

  it("parseSearchResponse：提取 parent（子页/工作区顶层/数据库条目）", () => {
    const r = parseSearchResponse({
      results: [
        {
          object: "page",
          id: "p1",
          parent: { type: "page_id", page_id: "parent1" },
          properties: {},
        },
        {
          object: "page",
          id: "p2",
          parent: { type: "workspace", workspace: true },
          properties: {},
        },
        {
          object: "page",
          id: "p3",
          parent: { type: "database_id", database_id: "db1" },
          properties: {},
        },
      ],
    });
    expect(r[0].parent).toEqual({ type: "page_id", id: "parent1" });
    expect(r[1].parent?.type).toBe("workspace");
    expect(r[2].parent).toEqual({ type: "database_id", id: "db1" });
    expect(r[0].parent?.id).toBe("parent1");
  });

  it("parseBlocks：提取文本行，跳过无正文块", () => {
    const lines = parseBlocks({
      results: [
        {
          type: "heading_2",
          heading_2: { rich_text: [{ plain_text: "标题" }] },
        },
        {
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "正文" }] },
        },
        { type: "image", image: {} },
      ],
    });
    expect(lines).toEqual(["标题", "正文"]);
  });
});

describe("notion · 意图检测 isNotionQuery", () => {
  it("显式提 Notion", () => {
    expect(isNotionQuery("Notion 里有什么项目")).toBe(true);
    expect(isNotionQuery("帮我查一下我的 notion 数据库")).toBe(true);
  });

  it("我的/工作区 + 数据库/页面/笔记等指向性组合", () => {
    expect(isNotionQuery("查一下我的工作区页面")).toBe(true);
    expect(isNotionQuery("我的笔记里记了什么")).toBe(true);
    expect(isNotionQuery("我创建的数据库有哪些")).toBe(true);
  });

  it("非 Notion 场景不命中（保守）", () => {
    expect(isNotionQuery("介绍一下这个页面")).toBe(false);
    expect(isNotionQuery("数据库原理是什么")).toBe(false);
    expect(isNotionQuery("今天天气怎么样")).toBe(false);
    expect(isNotionQuery("")).toBe(false);
    expect(isNotionQuery("   ")).toBe(false);
  });
});

describe("notion · 个人知识查询 isPersonalKnowledgeQuery", () => {
  it("我的 + 个人内容名词 + 查询意图", () => {
    expect(isPersonalKnowledgeQuery("看看我的知识库里有什么")).toBe(true);
    expect(isPersonalKnowledgeQuery("我的笔记里记了什么")).toBe(true);
    expect(isPersonalKnowledgeQuery("我的项目进展")).toBe(true);
    expect(isPersonalKnowledgeQuery("总结一下我的资料")).toBe(true);
  });

  it("我的 + Notion 专属名词直接命中", () => {
    expect(isPersonalKnowledgeQuery("我的清单")).toBe(true);
    expect(isPersonalKnowledgeQuery("我的数据库有哪些")).toBe(true);
    expect(isPersonalKnowledgeQuery("我的页面")).toBe(true);
  });

  it("非个人内容查询不命中", () => {
    expect(isPersonalKnowledgeQuery("今天天气怎么样")).toBe(false);
    expect(isPersonalKnowledgeQuery("帮我写一篇文章")).toBe(false);
    expect(isPersonalKnowledgeQuery("整理房间")).toBe(false);
    expect(isPersonalKnowledgeQuery("")).toBe(false);
  });
});

describe("notion · 上下文构建", () => {
  it("buildNotionContext：结果+页面正文格式化", () => {
    const ctx = buildNotionContext(
      [
        {
          id: "p1",
          title: "项目计划",
          url: "https://www.notion.so/x",
          lastEdited: "2026-08-01T00:00:00.000Z",
          type: "page",
        },
      ],
      { p1: "本周目标：发布 v1" },
    );
    expect(ctx).toContain("【Notion 资料】");
    expect(ctx).toContain("项目计划");
    expect(ctx).toContain("本周目标：发布 v1");
    expect(ctx).toContain("更新于 2026-08-01");
  });

  it("无结果返回空串", () => {
    expect(buildNotionContext([], {})).toBe("");
  });

  it("buildNotionContext 支持自定义引言（选中内容）", () => {
    const ctx = buildNotionContext(
      [
        {
          id: "p1",
          title: "项目计划",
          url: "",
          lastEdited: "2026-08-01T00:00:00.000Z",
          type: "page",
        },
      ],
      { p1: "正文" },
      "以下是你在知识库中选中的 Notion 内容：",
    );
    expect(ctx).toContain("以下是你在知识库中选中的 Notion 内容");
  });
});

describe("notion · 来源分区（列表/选中内容）", () => {
  it("fetchNotionPageList：空查询列出页面/数据库", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/notion/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "p1",
                last_edited_time: "2026-08-01T00:00:00.000Z",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "清单|List" }] },
                },
              },
              {
                object: "database",
                id: "d1",
                title: [{ plain_text: "任务看板" }],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const list = await fetchNotionPageList("t", { fetchImpl });
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe("清单|List");
    expect(list[1].type).toBe("database");
  });

  it("fetchNotionPageList：无 token 或失败返回空数组", async () => {
    expect(await fetchNotionPageList("", {})).toEqual([]);
    const bad = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    expect(await fetchNotionPageList("t", { fetchImpl: bad })).toEqual([]);
  });

  it("fetchNotionSelectedContent：拉元信息+正文 → 选中内容引言", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/notion/pages/p1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            properties: {
              Name: { type: "title", title: [{ plain_text: "项目计划" }] },
            },
            last_edited_time: "2026-08-01T00:00:00.000Z",
          }),
        };
      }
      if (url.includes("/api/notion/blocks/p1/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "本周目标" }] },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ctx = await fetchNotionSelectedContent("t", ["p1"], { fetchImpl });
    expect(ctx).toContain("以下是你在知识库中选中的 Notion 内容");
    expect(ctx).toContain("项目计划");
    expect(ctx).toContain("本周目标");
  });
});

describe("notion · 请求", () => {
  it("notionRequest：携带 x-notion-token 头，返回解析 JSON", async () => {
    let seenUrl = "";
    let seenToken = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenToken = String(
        (init.headers as Record<string, string>)["x-notion-token"],
      );
      return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
    }) as unknown as typeof fetch;
    const r = await notionRequest<{ ok: number }>("search", {
      method: "POST",
      body: { query: "x" },
      token: "secret_1",
      fetchImpl,
    });
    expect(seenUrl).toBe("/api/notion/search");
    expect(seenToken).toBe("secret_1");
    expect(r.ok).toBe(1);
  });

  it("notionRequest：非 2xx 抛错（含 Notion 错误信息）", async () => {
    const fetchImpl = mockFetch(401, {
      message: "API token is invalid.",
    }) as unknown as typeof fetch;
    await expect(
      notionRequest("search", { method: "POST", token: "bad", fetchImpl }),
    ).rejects.toThrow(/API token is invalid/);
  });

  it("notionRequest：429 限流自动退避重试后成功", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ message: "rate limited" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
    }) as unknown as typeof fetch;
    const r = await notionRequest<{ ok: number }>("search", {
      method: "POST",
      token: "t",
      fetchImpl,
    });
    expect(calls).toBe(2); // 第一次 429 重试，第二次成功
    expect(r.ok).toBe(1);
  });

  it("fetchNotionContext：多页正文并发拉取（多页都注入）", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/notion/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "p1",
                url: "",
                last_edited_time: "",
                properties: {
                  Name: {
                    type: "title",
                    title: [{ plain_text: "页面一" }],
                  },
                },
              },
              {
                object: "page",
                id: "p2",
                url: "",
                last_edited_time: "",
                properties: {
                  Name: {
                    type: "title",
                    title: [{ plain_text: "页面二" }],
                  },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/blocks/p1/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "内容甲" }] },
              },
            ],
          }),
        };
      }
      if (url.includes("/blocks/p2/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "内容乙" }] },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ctx = await fetchNotionContext("项目", {
      token: "secret_1",
      fetchImpl,
      maxPages: 3,
    });
    expect(ctx).toContain("页面一");
    expect(ctx).toContain("页面二");
    expect(ctx).toContain("内容甲");
    expect(ctx).toContain("内容乙");
  });

  it("fetchNotionContext：搜索→拉正文→格式化", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/notion/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "p1",
                url: "https://www.notion.so/x",
                last_edited_time: "2026-08-01T00:00:00.000Z",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "项目计划" }] },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/blocks/p1/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "本周目标" }] },
              },
              { type: "image", image: {} },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ctx = await fetchNotionContext("项目", {
      token: "secret_1",
      fetchImpl,
    });
    expect(ctx).toContain("项目计划");
    expect(ctx).toContain("本周目标");
  });

  it("fetchNotionContext：无 token 返回空", async () => {
    expect(await fetchNotionContext("x", { token: "" })).toBe("");
  });

  it("fetchNotionContext：搜索失败返回空（不抛）", async () => {
    const fetchImpl = mockFetch(500, {}) as unknown as typeof fetch;
    expect(await fetchNotionContext("x", { token: "t", fetchImpl })).toBe("");
  });

  it("fetchNotionContext：查询无匹配时兜底空查询列出页面", async () => {
    let call = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.includes("/api/notion/search")) {
        call++;
        const body = JSON.parse(String(init.body));
        if (call === 1) {
          // 第一次：整句查询无匹配
          expect(body.query).toContain("Notion");
          return { ok: true, status: 200, json: async () => ({ results: [] }) };
        }
        // 第二次：空查询兜底列出页面
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "p1",
                url: "https://www.notion.so/x",
                last_edited_time: "2026-08-01T00:00:00.000Z",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "兜底页面" }] },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/blocks/p1/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "兜底正文" }] },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ctx = await fetchNotionContext("看看我的 Notion 里有什么", {
      token: "t",
      fetchImpl,
    });
    expect(ctx).toContain("兜底页面");
    expect(call).toBe(2);
  });
});

describe("notion · 连接测试", () => {
  it("空 token 提示先填写", async () => {
    const r = await testNotionConnection("");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("请先填写");
  });

  it("成功返回 ok", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            object: "page",
            id: "p1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "A" }] },
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const r = await testNotionConnection("secret_1", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("连接成功");
  });

  it("401 返回友好 Token 无效提示", async () => {
    const fetchImpl = mockFetch(401, {
      message: "API token is invalid.",
    }) as unknown as typeof fetch;
    const r = await testNotionConnection("bad", fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Token 无效或无权限");
  });
});

describe("notion · 数据库结构化查询", () => {
  beforeEach(() => localStorage.clear());

  it("fetchNotionDatabases：列出数据库（filter object=database）", async () => {
    let body: any = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              object: "database",
              id: "db1",
              title: [{ plain_text: "任务看板" }],
              last_edited_time: "2026-08-01T00:00:00.000Z",
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const list = await fetchNotionDatabases("secret_1", { fetchImpl });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("db1");
    expect(list[0].type).toBe("database");
    expect(body?.filter).toEqual({ value: "database", property: "object" });
    expect(body?.query).toBe("");
  });

  it("fetchNotionDatabases：空 token / 失败返回 []", async () => {
    expect(await fetchNotionDatabases("")).toEqual([]);
    const f = mockFetch(500, {}) as unknown as typeof fetch;
    expect(await fetchNotionDatabases("t", { fetchImpl: f })).toEqual([]);
  });

  it("parseDatabaseSchema：解析属性类型与选项", () => {
    const schema = parseDatabaseSchema({
      id: "db1",
      title: [{ plain_text: "任务看板" }],
      properties: {
        Name: { id: "t", type: "title", title: {} },
        状态: {
          id: "s",
          type: "status",
          status: {
            options: [
              { name: "未开始", color: "gray" },
              { name: "进行中", color: "blue" },
            ],
          },
        },
        标签: {
          id: "m",
          type: "multi_select",
          multi_select: { options: [{ name: "前端" }, { name: "后端" }] },
        },
      },
    });
    expect(schema.id).toBe("db1");
    expect(schema.title).toBe("任务看板");
    expect(schema.properties.Name.type).toBe("title");
    expect(schema.properties["状态"].options.map((o) => o.name)).toEqual([
      "未开始",
      "进行中",
    ]);
    expect(schema.properties["标签"].options.map((o) => o.name)).toEqual([
      "前端",
      "后端",
    ]);
  });

  it("resolveDbTitleProperty：找 title 属性；无则兜底第一个", () => {
    const s1 = parseDatabaseSchema({
      properties: { Name: { type: "title" }, 状态: { type: "status" } },
    });
    expect(resolveDbTitleProperty(s1)).toBe("Name");
    const s2 = parseDatabaseSchema({ properties: { A: { type: "select" } } });
    expect(resolveDbTitleProperty(s2)).toBe("A");
  });

  it("propValueText：各属性类型取值", () => {
    expect(
      propValueText({ type: "title", title: [{ plain_text: "标题" }] }),
    ).toBe("标题");
    expect(propValueText({ type: "select", select: { name: "进行中" } })).toBe(
      "进行中",
    );
    expect(propValueText({ type: "status", status: null })).toBe("");
    expect(
      propValueText({
        type: "multi_select",
        multi_select: [{ name: "a" }, { name: "b" }],
      }),
    ).toBe("a、b");
    expect(propValueText({ type: "checkbox", checkbox: true })).toBe("✓");
    expect(propValueText({ type: "checkbox", checkbox: false })).toBe("");
    expect(propValueText({ type: "number", number: 42 })).toBe("42");
    expect(propValueText({ type: "date", date: { start: "2026-08-01" } })).toBe(
      "2026-08-01",
    );
    expect(propValueText({ type: "url", url: "https://x.com" })).toBe(
      "https://x.com",
    );
    expect(propValueText(undefined)).toBe("");
  });

  it("parseDatabaseRows：title 作标题，其余进 props", () => {
    const rows = parseDatabaseRows({
      results: [
        {
          id: "row1",
          url: "https://www.notion.so/r",
          last_edited_time: "2026-08-02T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "写周报" }] },
            状态: { type: "status", status: { name: "进行中" } },
            优先级: { type: "select", select: { name: "高" } },
          },
        },
        { id: "row2" }, // 无 properties → 空
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("写周报");
    expect(rows[0].props).toEqual({ 状态: "进行中", 优先级: "高" });
  });

  it("queryNotionDatabase：POST filter/sorts/page_size，失败返回 []", async () => {
    let body: any = null;
    let calledUrl = "";
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      calledUrl = String(u);
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    }) as unknown as typeof fetch;
    const rows = await queryNotionDatabase(
      "t",
      "db1",
      {
        filter: { x: 1 },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 10,
      },
      fetchImpl,
    );
    expect(rows).toEqual([]);
    expect(body?.page_size).toBe(10);
    expect(body?.sorts).toHaveLength(1);
    expect(calledUrl).toContain("databases/db1/query");
    expect(await queryNotionDatabase("", "db1")).toEqual([]);
  });

  it("buildDbFilter：按属性类型构造 filter", () => {
    expect(buildDbFilter("status", "状态", "进行中")).toEqual({
      property: "状态",
      status: { equals: "进行中" },
    });
    expect(buildDbFilter("select", "优先级", "高")).toEqual({
      property: "优先级",
      select: { equals: "高" },
    });
    expect(buildDbFilter("multi_select", "标签", "前端")).toEqual({
      property: "标签",
      multi_select: { contains: "前端" },
    });
    expect(buildDbFilter("checkbox", "完成", true)).toEqual({
      property: "完成",
      checkbox: { equals: true },
    });
    expect(buildDbFilter("status", "状态", "all")).toBeNull();
    expect(buildDbFilter("status", "状态", "")).toBeNull();
  });

  it("buildNotionDbContext：格式化数据库行", () => {
    const ctx = buildNotionDbContext(
      [
        {
          id: "r1",
          title: "写周报",
          url: "",
          lastEdited: "2026-08-02T00:00:00.000Z",
          props: { 状态: "进行中", 优先级: "高" },
        },
      ],
      "任务看板",
    );
    expect(ctx).toContain("【Notion 数据库】");
    expect(ctx).toContain("写周报");
    expect(ctx).toContain("状态: 进行中");
    expect(ctx).toContain("2026-08-02");
    expect(buildNotionDbContext([], "x")).toBe("");
  });
});

describe("notion · 写入", () => {
  it("contentToBlocks：按段落切块、长段分行、空内容跳过", () => {
    const blocks = contentToBlocks("第一段\n\n第二段");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "第一段" } }] },
    });
    expect(contentToBlocks("")).toEqual([]);
    expect(contentToBlocks("   \n  ")).toEqual([]);
    const long = "x".repeat(4000);
    const longBlocks = contentToBlocks(long);
    expect(longBlocks.length).toBeGreaterThan(2);
  });

  it("buildDbPageProperties：title 属性填充", () => {
    const props = buildDbPageProperties("Name", "周报", {
      状态: { status: { name: "进行中" } },
    }) as {
      Name: { title: { text: { content: string } }[] };
      状态: { status: { name: string } };
    };
    expect(props.Name.title[0].text.content).toBe("周报");
    expect(props["状态"]).toEqual({ status: { name: "进行中" } });
  });

  it("createNotionPageInDatabase：POST pages 构造 body；失败返回 null", async () => {
    let body: any = null;
    let calledUrl = "";
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      calledUrl = String(u);
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return { ok: true, status: 200, json: async () => ({ id: "pg1" }) };
    }) as unknown as typeof fetch;
    const r = await createNotionPageInDatabase("t", "db1", {
      titleProp: "Name",
      title: "周报",
      content: "正文内容",
      fetchImpl,
    });
    expect(r).toEqual({ id: "pg1" });
    expect(body.parent).toEqual({ database_id: "db1" });
    expect(body.properties.Name.title[0].text.content).toBe("周报");
    expect(body.children).toHaveLength(1);
    expect(calledUrl).toContain("/pages");
    expect(
      await createNotionPageInDatabase("", "db1", {
        titleProp: "Name",
        title: "x",
        content: "",
      }),
    ).toBeNull();
    const fail = mockFetch(400, {
      message: "Validation Error",
    }) as unknown as typeof fetch;
    expect(
      await createNotionPageInDatabase("t", "db1", {
        titleProp: "Name",
        title: "x",
        content: "c",
        fetchImpl: fail,
      }),
    ).toBeNull();
  });

  it("appendNotionBlocks：PATCH 追加块；空内容/失败返回 false", async () => {
    let url = "";
    const fetchImpl = (async (u: unknown) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect(await appendNotionBlocks("t", "pg1", "追加内容", fetchImpl)).toBe(
      true,
    );
    expect(url).toContain("blocks/pg1/children");
    expect(await appendNotionBlocks("t", "pg1", "")).toBe(false);
  });

  it("replaceNotionPageContent：列出子块→删旧块→追加新块（镜像覆盖）", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      calls.push((init?.method || "GET") + " " + url);
      if (url.includes("blocks/pg1/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ id: "b1" }, { id: "b2" }],
            next_cursor: null,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect(
      await replaceNotionPageContent("t", "pg1", "新正文", fetchImpl),
    ).toBe(true);
    expect(calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(2); // 删除旧块 b1/b2
    expect(
      calls.some(
        (c) => c.startsWith("GET") && c.includes("blocks/pg1/children"),
      ),
    ).toBe(true); // 列出子块
    expect(
      calls.some(
        (c) => c.startsWith("PATCH") && c.includes("blocks/pg1/children"),
      ),
    ).toBe(true); // 追加新块
    expect(await replaceNotionPageContent("", "pg1", "x")).toBe(false);
  });

  it("replaceNotionPageContent：大内容分块追加（Notion 每次≤100 块）", async () => {
    const patchCounts: number[] = [];
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      if ((init?.method || "GET") === "PATCH" && url.includes("children")) {
        const body = JSON.parse(String(init?.body || "{}"));
        patchCounts.push((body?.children || []).length);
      }
      if (
        (init?.method || "GET") === "GET" &&
        url.includes("blocks/pg1/children")
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [], next_cursor: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    // 105 个段落 → 105 块 → 分 2 批（100 + 5）
    const content = Array.from({ length: 105 }, (_, i) => `第 ${i} 段`).join(
      "\n\n",
    );
    expect(await replaceNotionPageContent("t", "pg1", content, fetchImpl)).toBe(
      true,
    );
    expect(patchCounts.length).toBe(2);
    expect(patchCounts[0]).toBe(100);
    expect(patchCounts[1]).toBe(5);
  });

  it("createNotionSubPage：POST pages 构造 parent=page_id；失败/空返回 null", async () => {
    let body: unknown = null;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return { ok: true, status: 200, json: async () => ({ id: "child1" }) };
    }) as unknown as typeof fetch;
    const r = await createNotionSubPage("t", "parent1", {
      title: "子页",
      content: "内容",
      fetchImpl,
    });
    expect(r).toEqual({ id: "child1" });
    const b = body as {
      parent?: { page_id?: string };
      properties?: { title?: { title?: { text?: { content?: string } }[] } };
    };
    expect(b.parent).toEqual({ page_id: "parent1" });
    expect(b.properties?.title?.title?.[0]?.text?.content).toBe("子页");
    expect(
      await createNotionSubPage("", "p", { title: "x", content: "" }),
    ).toBeNull();
    const fail = mockFetch(400, {
      message: "Validation Error",
    }) as unknown as typeof fetch;
    expect(
      await createNotionSubPage("t", "p", {
        title: "x",
        content: "c",
        fetchImpl: fail,
      }),
    ).toBeNull();
  });

  it("updateNotionPageProps：PATCH 属性；失败返回 false", async () => {
    let url = "";
    const fetchImpl = (async (u: unknown) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect(
      await updateNotionPageProps(
        "t",
        "pg1",
        { Name: { title: [{ text: { content: "新标题" } }] } },
        fetchImpl,
      ),
    ).toBe(true);
    expect(url).toContain("pages/pg1");
    expect(await updateNotionPageProps("t", "pg1", {})).toBe(false);
  });

  it("findNotionPageByTitle：按标题精确匹配页面", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            object: "page",
            id: "pg1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "周报" }] },
            },
          },
          {
            object: "page",
            id: "pg2",
            properties: {
              Name: { type: "title", title: [{ plain_text: "别的" }] },
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const hit = await findNotionPageByTitle("t", "周报", fetchImpl);
    expect(hit).toEqual({ id: "pg1" });
    expect(await findNotionPageByTitle("t", "不存在", fetchImpl)).toBeNull();
    expect(await findNotionPageByTitle("", "x")).toBeNull();
  });
});

describe("notion · 主数据库兜底 + 页面正文", () => {
  beforeEach(() => localStorage.clear());

  it("resolveMainDatabaseId：默认库优先；未配置取第一个数据库（主库）", async () => {
    saveNotionDbId("db_default");
    const shouldNotCall = (async () => {
      throw new Error("不应发起请求");
    }) as unknown as typeof fetch;
    expect(await resolveMainDatabaseId("t", shouldNotCall)).toBe("db_default");

    localStorage.removeItem("kimo_notion_db");
    const listFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { object: "database", id: "db1", title: [{ plain_text: "主库" }] },
          { object: "database", id: "db2", title: [{ plain_text: "备库" }] },
        ],
      }),
    })) as unknown as typeof fetch;
    expect(await resolveMainDatabaseId("t", listFetch)).toBe("db1");
  });

  it("resolveMainDatabaseId：空 token / 无数据库返回空", async () => {
    resetNotionCaches();
    expect(await resolveMainDatabaseId("")).toBe("");
    const empty = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    })) as unknown as typeof fetch;
    expect(await resolveMainDatabaseId("t", empty)).toBe("");
  });

  it("fetchNotionPageText：拉取页面正文纯文本；失败/空 token 返回空", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "第一行" }] },
          },
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "第二行" }] },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const text = await fetchNotionPageText("t", "pg1", fetchImpl);
    expect(text).toBe("第一行\n第二行");
    expect(await fetchNotionPageText("", "pg1")).toBe("");
    const fail = mockFetch(500, {}) as unknown as typeof fetch;
    expect(await fetchNotionPageText("t", "pg1", fail)).toBe(null); // 读取失败返回 null
  });

  it("fetchNotionPageText：分页拉取全部块并按 maxChars 截断", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes("start_cursor=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "第三行" }] },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "第一行" }] },
            },
          ],
          next_cursor: "c1",
        }),
      };
    }) as unknown as typeof fetch;
    const text = await fetchNotionPageText("t", "pg1", fetchImpl);
    expect(text).toBe("第一行\n第三行");
    // maxChars 截断
    const short = await fetchNotionPageText("t", "pg1", fetchImpl, 3);
    expect(short).toBe("第一行");
  });
});

describe("notion · Content access 层级（resolveNotionRoots）", () => {
  const page = (
    id: string,
    title: string,
    parent?: { type?: string; id?: string },
  ): NotionSearchResult => ({
    id,
    title,
    url: "",
    lastEdited: "",
    type: "page",
    ...(parent ? { parent } : {}),
  });

  it("顶层共享页（parent=workspace）→ 自己是根", () => {
    const p1 = page("p1", "根A", { type: "workspace" });
    const { roots, rootOf } = resolveNotionRoots([p1]);
    expect(roots.map((r) => r.id)).toEqual(["p1"]);
    expect(rootOf.get("p1")).toBe("p1");
  });

  it("子页面 → 沿 parent 上溯到根，记录父子映射", () => {
    const root = page("r1", "根A", { type: "workspace" });
    const child = page("c1", "子页", { type: "page_id", id: "r1" });
    const grand = page("g1", "孙页", { type: "page_id", id: "c1" });
    const { roots, rootOf, parentOf } = resolveNotionRoots([
      root,
      child,
      grand,
    ]);
    expect(roots.map((r) => r.id)).toEqual(["r1"]);
    expect(rootOf.get("c1")).toBe("r1");
    expect(rootOf.get("g1")).toBe("r1");
    expect(parentOf.get("c1")).toBe("r1");
    expect(parentOf.get("g1")).toBe("c1");
  });

  it("父不在可访问集合 → 该页是根（Content access 根）", () => {
    const p1 = page("p1", "共享页", { type: "page_id", id: "outside" });
    const { roots, rootOf } = resolveNotionRoots([p1]);
    expect(roots.map((r) => r.id)).toEqual(["p1"]);
    expect(rootOf.get("p1")).toBe("p1");
  });

  it("两个 Content access 根 → 两个根，子页归到对应根", () => {
    const a = page("rA", "根A", { type: "workspace" });
    const b = page("rB", "根B", { type: "workspace" });
    const ca = page("ca", "子A", { type: "page_id", id: "rA" });
    const { roots, rootOf } = resolveNotionRoots([a, b, ca]);
    expect(new Set(roots.map((r) => r.id))).toEqual(new Set(["rA", "rB"]));
    expect(rootOf.get("ca")).toBe("rA");
  });

  it("数据库条目（parent=database_id）→ 自己是根", () => {
    const row = page("row1", "任务", { type: "database_id", id: "db1" });
    const { roots, rootOf } = resolveNotionRoots([row]);
    expect(roots.map((r) => r.id)).toEqual(["row1"]);
    expect(rootOf.get("row1")).toBe("row1");
  });

  it("环（parent 互指）→ 不无限循环，兜底为根", () => {
    const a = page("a", "A", { type: "page_id", id: "b" });
    const b = page("b", "B", { type: "page_id", id: "a" });
    const { roots, rootOf } = resolveNotionRoots([a, b]);
    expect(roots.length).toBeGreaterThan(0);
    expect(rootOf.has("a")).toBe(true);
    expect(rootOf.has("b")).toBe(true);
  });
});
