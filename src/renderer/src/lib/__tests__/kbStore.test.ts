import { describe, it, expect, beforeEach } from "vitest";
import {
  loadKbStoreMode,
  saveKbStoreMode,
  resolveKbStore,
  saveKbEntrySmart,
  syncEntryNotion,
  queueKbSync,
  flushKbSync,
  deleteKbEntrySmart,
  syncLocalKbToNotion,
  snapshotKb,
  restoreKbSnapshot,
  hasKbSnapshot,
  loadKbSnapshots,
  pullNotionPagesToKb,
  resolveKbDbId,
  isKbNotionImported,
  migrateLocalKbToRoot,
  moveKbEntry,
  resetKbSyncQueue,
} from "../kbStore";
import { loadKbEntries, saveKbEntry } from "../kb";
import {
  saveNotionCfg,
  saveNotionDbId,
  clearNotionCfg,
  resetNotionCaches,
} from "../notion";

function clearNotionDb() {
  try {
    localStorage.removeItem("kimo_notion_db");
  } catch {
    /* 忽略 */
  }
}

/** 构造按 URL 前缀路由的 fetch mock */
function makeRouter(
  handlers: Record<string, (url: string, body?: unknown) => unknown>,
) {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    for (const [prefix, fn] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        return { ok: true, status: 200, json: async () => fn(u, body) };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "not found" }),
    };
  }) as unknown as typeof fetch;
}

const DB_SCHEMA = {
  id: "db1",
  title: [{ plain_text: "任务看板" }],
  properties: {
    Name: { id: "t", type: "title", title: {} },
    状态: {
      id: "s",
      type: "status",
      status: { options: [{ name: "未开始" }, { name: "进行中" }] },
    },
  },
};

beforeEach(() => {
  localStorage.clear();
  resetKbSyncQueue();
  resetNotionCaches();
});

describe("kbStore · 保存目标 mode", () => {
  it("默认 auto；保存/读取/非法回退", () => {
    expect(loadKbStoreMode()).toBe("auto");
    saveKbStoreMode("notion");
    expect(loadKbStoreMode()).toBe("notion");
    localStorage.setItem("kimo_kb_store_mode", "bad");
    expect(loadKbStoreMode()).toBe("auto");
  });

  it("resolveKbStore：auto 随配置、local/notion 强制、notion 无配置回退 local", () => {
    expect(resolveKbStore("auto")).toBe("local"); // 未配置 Notion
    saveNotionCfg({ token: "t" });
    expect(resolveKbStore("auto")).toBe("notion");
    expect(resolveKbStore("local")).toBe("local");
    expect(resolveKbStore("notion")).toBe("notion");
    clearNotionCfg();
    expect(resolveKbStore("notion")).toBe("local"); // 强制 notion 但未配置 → 回退 local
  });
});

describe("kbStore · 智能保存（双写）", () => {
  it("mode=local：仅写本地，不触发 Notion", async () => {
    saveNotionCfg({ token: "t" });
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await saveKbEntrySmart({
      title: "本地条目",
      content: "内容",
      mode: "local",
      fetchImpl: f,
    });
    expect(r.store).toBe("local");
    expect(called).toBe(false);
    expect(loadKbEntries().some((e) => e.name === "本地条目")).toBe(true);
  });

  it("mode=notion 但未配置默认库：本机保存 + 后台同步自动忽略", async () => {
    saveNotionCfg({ token: "t" });
    clearNotionDb();
    const r = await saveKbEntrySmart({
      title: "条目",
      content: "内容",
      mode: "notion",
    });
    expect(r.store).toBe("notion"); // 目标解析为 notion
    expect(loadKbEntries().some((e) => e.name === "条目")).toBe(true);
    expect(r.entry.name).toBe("条目");
  });

  it("syncEntryNotion：无 notionId 创建为「知识库」根页面下的子页面并回填", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("周报", "本周完成…");
    const fetchImpl = makeRouter({
      "/search": (_url, body) => {
        const b = body as { query?: string; filter?: { value?: string } };
        if (b.filter?.value === "database") return { results: [] };
        if (!b.query) {
          // resolveBackupRoots：列出 Content access 根（页面根目录）
          return {
            results: [
              {
                object: "page",
                id: "root1",
                properties: {
                  title: { title: [{ plain_text: "根页面" }] },
                },
                parent: { type: "workspace" },
              },
            ],
          };
        }
        return { results: [] }; // findNotionPageByTitle：找不到
      },
      "/pages": (_url, body) => {
        const b = body as { parent?: { page_id?: string } };
        const parent = b.parent?.page_id || "";
        if (parent === "root1") return { id: "kb_container" }; // 知识库容器（页面根目录下）
        return { id: "pg_new" }; // 知识条目
      },
    });
    const r = await syncEntryNotion({ entry, fetchImpl });
    expect(r.notionId).toBe("pg_new");
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("pg_new");
    expect(local?.notionRootId).toBe("kb_container");
    expect(local?.notionSyncedAt).toBeGreaterThan(0);
  });

  it("syncEntryNotion：有 notionParentId 时在父页面下创建子页面（无需数据库）", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("子页", "子内容");
    let parentPage = "";
    const fetchImpl = makeRouter({
      "/pages": (_u, body) => {
        parentPage =
          (body as { parent?: { page_id?: string } } | undefined)?.parent
            ?.page_id || "";
        return { id: "child1" };
      },
    });
    const r = await syncEntryNotion({
      entry: { ...entry, notionParentId: "parent1" },
      fetchImpl,
    });
    expect(r.notionId).toBe("child1");
    expect(parentPage).toBe("parent1");
    const local = loadKbEntries().find((x) => x.id === entry.id);
    expect(local?.notionId).toBe("child1");
  });

  it("syncEntryNotion：有 notionId 镜像覆盖（更新标题 + 替换内容），不新建", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    const entry = saveKbEntry("周报", "更新内容");
    let appendCalled = false;
    let patchUrl = "";
    const fetchImpl = makeRouter({
      "databases/db1": () => DB_SCHEMA,
      "/pages/pg1": (u) => {
        patchUrl = String(u);
        return { id: "pg1" };
      },
      "blocks/pg1/children": () => {
        appendCalled = true;
        return {};
      },
    });
    const r = await syncEntryNotion({
      entry: { ...entry, notionId: "pg1" },
      fetchImpl,
    });
    expect(r.notionId).toBe("pg1");
    expect(patchUrl).toContain("/pages/pg1");
    expect(appendCalled).toBe(true);
  });
});

describe("kbStore · AgentPanel 创建→同步链路", () => {
  it("创建条目入队 → flush → Notion 知识库根页面建页并回填 notionId", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("新建笔记", "创建后的内容");
    queueKbSync(entry, {
      fetchImpl: makeRouter({
        "/search": (_url, body) => {
          const b = body as { query?: string; filter?: { value?: string } };
          if (b.filter?.value === "database") return { results: [] };
          if (!b.query) {
            return {
              results: [
                {
                  object: "page",
                  id: "root1",
                  properties: {
                    title: { title: [{ plain_text: "根页面" }] },
                  },
                  parent: { type: "workspace" },
                },
              ],
            };
          }
          return { results: [] };
        },
        "/pages": (_url, body) => {
          const b = body as { parent?: { page_id?: string } };
          const parent = b.parent?.page_id || "";
          if (parent === "root1") return { id: "kb_container" };
          return { id: "pg_new" };
        },
      }),
    });
    await flushKbSync(entry.id);
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("pg_new");
    expect(local?.notionRootId).toBe("kb_container");
    expect(local?.notionSyncedAt).toBeGreaterThan(0);
  });

  it("同一条目重复入队：不重复建 Notion 页面（用最新 notionId 镜像更新）", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("重复测试", "v1");
    const calls = { createEntry: 0 };
    const makeF = () =>
      makeRouter({
        "/search": (_url, body) => {
          const b = body as
            | { query?: string; filter?: { value?: string } }
            | undefined;
          if (b?.filter?.value === "database") return { results: [] };
          if (!b?.query) {
            return {
              results: [
                {
                  object: "page",
                  id: "root1",
                  properties: {
                    title: { title: [{ plain_text: "根页面" }] },
                  },
                  parent: { type: "workspace" },
                },
              ],
            };
          }
          return { results: [] };
        },
        "blocks/pg_new/children": () => ({ results: [] }),
        "/pages": (_url, body) => {
          const b2 = body as { parent?: { page_id?: string } } | undefined;
          const parent = b2?.parent?.page_id || "";
          if (parent === "root1") return { id: "kb_container" }; // 容器页
          if (parent) {
            calls.createEntry++; // 知识条目建页（POST）
            return { id: "pg_new" };
          }
          return { id: "pg_new" }; // PATCH 更新标题（无 parent）
        },
      });
    // 第一次：入队（旧快照无 notionId）→ 建页并回填 notionId
    queueKbSync(entry, { fetchImpl: makeF() });
    await flushKbSync(entry.id);
    expect(loadKbEntries().find((e) => e.id === entry.id)?.notionId).toBe(
      "pg_new",
    );
    expect(calls.createEntry).toBe(1);
    // 第二次：用「陈旧快照」再次入队（模拟 updateEntry 时 activeEntry 尚未刷新 notionId）
    const stale = { ...entry, content: "v2" }; // 无 notionId
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === entry.id ? { ...e, content: "v2" } : e,
        ),
      ),
    );
    queueKbSync(stale, { fetchImpl: makeF() });
    await flushKbSync(entry.id);
    expect(calls.createEntry).toBe(1); // 不再重复建页（走镜像更新）
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("pg_new");
    expect(local?.content).toBe("v2");
  });

  it("有默认数据库时：顶层条目仍存为「知识库」根页面的子页面（不再进数据库）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1"); // 即使配置了默认数据库
    const entry = saveKbEntry("主库笔记", "内容");
    let usedDb = false;
    queueKbSync(entry, {
      fetchImpl: makeRouter({
        "databases/db1": () => {
          usedDb = true;
          return DB_SCHEMA;
        },
        "/search": (_url, body) => {
          const b = body as { query?: string; filter?: { value?: string } };
          if (b.filter?.value === "database") return { results: [] };
          if (!b.query) {
            return {
              results: [
                {
                  object: "page",
                  id: "root1",
                  properties: {
                    title: { title: [{ plain_text: "根页面" }] },
                  },
                  parent: { type: "workspace" },
                },
              ],
            };
          }
          return { results: [] };
        },
        "/pages": (_url, body) => {
          const b = body as { parent?: { page_id?: string } };
          const parent = b.parent?.page_id || "";
          if (parent === "root1") return { id: "kb_container" };
          return { id: "pg_main" };
        },
      }),
    });
    await flushKbSync(entry.id);
    expect(usedDb).toBe(false); // 不再写数据库
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("pg_main");
    expect(local?.notionRootId).toBe("kb_container");
  });

  it("子页面条目编辑（有 notionId）→ 镜像覆盖不新建", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    const entry = saveKbEntry("子页", "编辑内容");
    // 真实流程：notionId 已回填到 localStorage 后才入队同步
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === entry.id
            ? { ...e, notionId: "child1", notionParentId: "p1" }
            : e,
        ),
      ),
    );
    const synced = loadKbEntries().find((e) => e.id === entry.id)!;
    queueKbSync(synced, {
      fetchImpl: makeRouter({
        "databases/db1": () => DB_SCHEMA,
        "pages/child1": () => ({ id: "child1" }),
        "blocks/child1/children": () => ({ results: [] }),
      }),
    });
    await flushKbSync(entry.id);
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("child1");
  });

  it("无数据库时：知识条目自动存为「知识库」容器下的子页面（页面根目录）", async () => {
    saveNotionCfg({ token: "t" });
    clearNotionDb(); // 无默认数据库，且工作区无数据库
    const entry = saveKbEntry("容器笔记", "内容");
    queueKbSync(entry, {
      fetchImpl: makeRouter({
        "/search": (_url, body) => {
          const b = body as { query?: string; filter?: { value?: string } };
          if (b.filter?.value === "database") return { results: [] }; // 无数据库
          if (!b.query) {
            // resolveBackupRoots：列出 Content access 根（页面根目录）
            return {
              results: [
                {
                  object: "page",
                  id: "root1",
                  properties: {
                    title: { title: [{ plain_text: "根页面" }] },
                  },
                  parent: { type: "workspace" },
                },
              ],
            };
          }
          return { results: [] }; // findNotionPageByTitle：找不到
        },
        "/pages": (_url, body) => {
          const b = body as { parent?: { page_id?: string } };
          const parent = b.parent?.page_id || "";
          if (parent === "root1") return { id: "kb_container" }; // 知识库容器（页面根目录下）
          return { id: "kb_entry" }; // 知识条目
        },
      }),
    });
    await flushKbSync(entry.id);
    const local = loadKbEntries().find((e) => e.id === entry.id);
    expect(local?.notionId).toBe("kb_entry"); // 通过容器子页创建并回填
    expect(localStorage.getItem("kimo_kb_container")).toBe("kb_container");
  });
});

describe("kbStore · 一键迁移到「知识库」根页面", () => {
  it("migrateLocalKbToRoot：无 notionId 条目 → 根页面子页面并回填根信息", async () => {
    saveNotionCfg({ token: "t" });
    saveKbEntry("本地笔记", "内容");
    const r = await migrateLocalKbToRoot({
      fetchImpl: makeRouter({
        "/search": (_url, body) => {
          const b = body as { query?: string; filter?: { value?: string } };
          if (b.filter?.value === "database") return { results: [] };
          if (!b.query) {
            return {
              results: [
                {
                  object: "page",
                  id: "root1",
                  properties: {
                    title: { title: [{ plain_text: "根页面" }] },
                  },
                  parent: { type: "workspace" },
                },
              ],
            };
          }
          return { results: [] };
        },
        "/pages": (_url, body) => {
          const b = body as { parent?: { page_id?: string } };
          const parent = b.parent?.page_id || "";
          if (parent === "root1") return { id: "kb_container" }; // 知识库容器
          return { id: "migrated1" };
        },
      }),
    });
    expect(r.total).toBe(1);
    expect(r.created).toBe(1);
    const local = loadKbEntries().find((e) => e.name === "本地笔记");
    expect(local?.notionId).toBe("migrated1");
    expect(local?.notionRootId).toBe("kb_container");
    expect(local?.notionRootName).toBe("知识库");
  });

  it("migrateLocalKbToRoot：未配置 Notion 直接报错不创建", async () => {
    clearNotionCfg();
    const r = await migrateLocalKbToRoot({});
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.created).toBe(0);
  });
});

describe("kbStore · 智能删除（双向）", () => {
  it("本地删除 + 有 notionId 时删 Notion", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    const entry = saveKbEntry("待删", "内容");
    // 手动给该条目打上 notionId（模拟已同步）
    const entries = loadKbEntries();
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        entries.map((e) =>
          e.id === entry.id ? { ...e, notionId: "pg_del" } : e,
        ),
      ),
    );
    let deleteUrl = "";
    const fetchImpl = makeRouter({
      "/pages/pg_del": (u) => {
        deleteUrl = String(u);
        return { archived: true };
      },
    });
    const r = await deleteKbEntrySmart({
      id: entry.id,
      mode: "notion",
      fetchImpl,
    });
    expect(r.removedLocal).toBe(true);
    expect(r.removedNotion).toBe(true);
    expect(deleteUrl).toContain("/pages/pg_del");
    expect(loadKbEntries().some((e) => e.id === entry.id)).toBe(false);
  });

  it("mode=local：仅本地删除，不动 Notion", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("本地删", "内容");
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await deleteKbEntrySmart({
      id: entry.id,
      mode: "local",
      fetchImpl: f,
    });
    expect(r.removedNotion).toBe(false);
    expect(called).toBe(false);
    expect(loadKbEntries()).toHaveLength(0);
  });
});

describe("kbStore · 本地导入 Notion（双写，知识库根页面）", () => {
  it("同步：跳过已同步 → 知识库根页面创建并回填/统计", async () => {
    saveNotionCfg({ token: "t" });
    const e1 = saveKbEntry("新条目", "内容1");
    const e2 = saveKbEntry("已同步", "内容2");
    // e2 已有 notionId → 跳过
    const entries = loadKbEntries();
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        entries.map((x) =>
          x.id === e2.id ? { ...x, notionId: "pg_exist" } : x,
        ),
      ),
    );
    const fetchImpl = makeRouter({
      "/search": (_url, body) => {
        const b = body as { query?: string };
        if (!b.query) {
          return {
            results: [
              {
                object: "page",
                id: "root1",
                properties: {
                  title: { title: [{ plain_text: "根页面" }] },
                },
                parent: { type: "workspace" },
              },
            ],
          };
        }
        return { results: [] };
      },
      "/pages": (_url, body) => {
        const b = body as { parent?: { page_id?: string } };
        const parent = b.parent?.page_id || "";
        if (parent === "root1") return { id: "kb_container" };
        return { id: "pg_new" };
      },
    });
    const r = await syncLocalKbToNotion({ fetchImpl });
    expect(r.total).toBe(1); // 仅统计未同步条目
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
    const local = loadKbEntries().find((x) => x.id === e1.id);
    expect(local?.notionId).toBe("pg_new");
    expect(local?.notionRootId).toBe("kb_container");
  });

  it("未配置 Notion：返回错误，不执行", async () => {
    clearNotionCfg();
    const r = await syncLocalKbToNotion();
    expect(r.errors.join("")).toContain("未配置 Notion");
  });
});

describe("kbStore · 版本快照（撤销/恢复）", () => {
  it("环形 5 份：连拍超过 5 次保留最近 5", () => {
    for (let i = 0; i < 7; i++) {
      saveKbEntry("条目" + i, "内容" + i);
      snapshotKb();
    }
    const snaps = loadKbSnapshots();
    expect(snaps).toHaveLength(5);
    // 最新快照应包含最后一次条目
    expect(snaps[0].entries.some((e) => e.name === "条目6")).toBe(true);
  });

  it("restore：恢复最近快照并从列表移除", () => {
    saveKbEntry("初始", "v1");
    snapshotKb();
    // 快照后修改
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(loadKbEntries().map((e) => ({ ...e, content: "v2" }))),
    );
    expect(hasKbSnapshot()).toBe(true);
    const restored = restoreKbSnapshot();
    expect(restored).not.toBeNull();
    expect(loadKbEntries()[0].content).toBe("v1");
    expect(loadKbSnapshots()).toHaveLength(0);
  });

  it("无快照时 restore 返回 null", () => {
    expect(hasKbSnapshot()).toBe(false);
    expect(restoreKbSnapshot()).toBeNull();
  });
});

describe("kbStore · 页面迁移 + 主库兜底", () => {
  beforeEach(() => localStorage.clear());

  it("resolveKbDbId：databaseId 优先；未传用默认库；否则主库兜底", async () => {
    resetNotionCaches();
    const f = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ object: "database", id: "db1", title: [] }],
      }),
    })) as unknown as typeof fetch;
    expect(await resolveKbDbId("t", "db_x", f)).toBe("db_x");
    saveNotionDbId("db_default");
    expect(await resolveKbDbId("t", undefined, f)).toBe("db_default");
    clearNotionDb();
    expect(await resolveKbDbId("t", undefined, f)).toBe("db1");
  });

  it("pullNotionPagesToKb：把 Notion 页面转译为知识库卡片并覆盖本地", async () => {
    saveNotionCfg({ token: "t" });
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "pg1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "页面A" }] },
            },
          },
          {
            object: "page",
            id: "pg2",
            properties: {
              Name: { type: "title", title: [{ plain_text: "页面B" }] },
            },
          },
        ],
      }),
      "blocks/pg1/children": () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "内容A" }] },
          },
        ],
      }),
      "blocks/pg2/children": () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "内容B" }] },
          },
        ],
      }),
    });
    const r = await pullNotionPagesToKb({ fetchImpl });
    expect(r.total).toBe(2);
    expect(r.imported).toBe(2);
    const entries = loadKbEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.notionId === "pg1")?.name).toBe("页面A");
    expect(entries.find((e) => e.notionId === "pg1")?.content).toBe("内容A");
  });

  it("pullNotionPagesToKb：按 notionId 匹配更新，不重复创建", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("旧标题", "旧内容");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === entry.id ? { ...e, notionId: "pg1" } : e,
        ),
      ),
    );
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "pg1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "新标题" }] },
            },
          },
        ],
      }),
      "blocks/pg1/children": () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "新内容" }] },
          },
        ],
      }),
    });
    await pullNotionPagesToKb({ fetchImpl });
    const entries = loadKbEntries();
    expect(entries).toHaveLength(1); // 不新增
    expect(entries[0].name).toBe("新标题");
    expect(entries[0].content).toBe("新内容");
    expect(entries[0].id).toBe(entry.id); // 保留原 id
  });

  it("pullNotionPagesToKb：Notion 侧删除的页面 → 本地自动删除（对账）", async () => {
    saveNotionCfg({ token: "t" });
    const e1 = saveKbEntry("保留", "内容1");
    const e2 = saveKbEntry("已删", "内容2");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === e1.id
            ? { ...e, notionId: "pg1", notionSyncedAt: Date.now() }
            : { ...e, notionId: "pg_del", notionSyncedAt: Date.now() },
        ),
      ),
    );
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "pg1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "保留" }] },
            },
          },
        ],
        has_more: false,
      }),
      "blocks/pg1/children": () => ({ results: [] }),
    });
    await pullNotionPagesToKb({ fetchImpl });
    const entries = loadKbEntries();
    expect(entries.some((e) => e.id === e2.id)).toBe(false); // 已删条目被对账删除
    expect(entries.some((e) => e.id === e1.id)).toBe(true); // 保留
  });

  it("pullNotionPagesToKb：回填 Content access 根/父层级（含子页面）", async () => {
    saveNotionCfg({ token: "t" });
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "r1",
            parent: { type: "workspace", workspace: true },
            properties: {
              Name: { type: "title", title: [{ plain_text: "根A" }] },
            },
          },
          {
            object: "page",
            id: "c1",
            parent: { type: "page_id", page_id: "r1" },
            properties: {
              Name: { type: "title", title: [{ plain_text: "子页" }] },
            },
          },
        ],
      }),
      "blocks/r1/children": () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "根内容" }] },
          },
        ],
      }),
      "blocks/c1/children": () => ({
        results: [
          {
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "子内容" }] },
          },
        ],
      }),
    });
    await pullNotionPagesToKb({ fetchImpl });
    const entries = loadKbEntries();
    const root = entries.find((e) => e.notionId === "r1");
    const child = entries.find((e) => e.notionId === "c1");
    expect(root?.notionRootId).toBe("r1");
    expect(root?.notionRootName).toBe("根A");
    expect(child?.notionRootId).toBe("r1");
    expect(child?.notionRootName).toBe("根A");
    expect(child?.notionParentId).toBe("r1");
    expect(child?.notionParentName).toBe("根A");
    // 子页面仍保留 content（子页面正文也被拉取）
    expect(child?.content).toBe("子内容");
  });

  it("pullNotionPagesToKb：知识库列表 = 「知识库」根页面下的 Notion 页面树（子树外不拉取）", async () => {
    saveNotionCfg({ token: "t" });
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "root1",
            parent: { type: "workspace" },
            properties: { title: { title: [{ plain_text: "根页面" }] } },
          },
          {
            object: "page",
            id: "kb-container",
            parent: { type: "page_id", page_id: "root1" },
            properties: { title: { title: [{ plain_text: "知识库" }] } },
          },
          {
            object: "page",
            id: "kb-child1",
            parent: { type: "page_id", page_id: "kb-container" },
            properties: { title: { title: [{ plain_text: "知识条目A" }] } },
          },
          {
            object: "page",
            id: "kb-child2",
            parent: { type: "page_id", page_id: "kb-child1" },
            properties: { title: { title: [{ plain_text: "知识条目B" }] } },
          },
          {
            object: "page",
            id: "other",
            parent: { type: "workspace" },
            properties: { title: { title: [{ plain_text: "无关页面" }] } },
          },
        ],
      }),
      "blocks/kb-child1/children": () => ({ results: [] }),
      "blocks/kb-child2/children": () => ({ results: [] }),
    });
    await pullNotionPagesToKb({ fetchImpl });
    const entries = loadKbEntries();
    const ids = entries.map((e) => e.notionId);
    expect(ids).toContain("kb-child1");
    expect(ids).toContain("kb-child2");
    expect(ids).not.toContain("kb-container"); // 容器页自身不是条目
    expect(ids).not.toContain("other"); // 「知识库」子树外不拉取
    // 子树内条目归组到「知识库」根
    const child1 = entries.find((e) => e.notionId === "kb-child1");
    expect(child1?.notionRootId).toBe("kb-container");
    expect(child1?.notionRootName).toBe("知识库");
    expect(child1?.notionParentId).toBe("kb-container");
  });

  it("pullNotionPagesToKb：未配置 token 返回错误", async () => {
    clearNotionCfg();
    const r = await pullNotionPagesToKb();
    expect(r.errors).toEqual(["未配置 Notion"]);
  });

  it("pullNotionPagesToKb：排除备份页（AI Setting/备份 · X）", async () => {
    saveNotionCfg({ token: "t" });
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "bk-root",
            url: "https://www.notion.so/bk",
            last_edited_time: "2026-08-08T00:00:00.000Z",
            parent: { type: "workspace" },
            properties: {
              title: { title: [{ plain_text: "AI Setting" }] },
            },
          },
          {
            object: "page",
            id: "bk-mem",
            url: "https://www.notion.so/bm",
            last_edited_time: "2026-08-08T00:00:00.000Z",
            parent: { type: "page_id", page_id: "bk-root" },
            properties: {
              title: { title: [{ plain_text: "备份 · 记忆" }] },
            },
          },
          {
            object: "page",
            id: "real",
            url: "https://www.notion.so/r",
            last_edited_time: "2026-08-08T00:00:00.000Z",
            parent: { type: "workspace" },
            properties: {
              title: { title: [{ plain_text: "真实笔记" }] },
            },
          },
        ],
      }),
      "blocks/real/children": () => ({
        results: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: "正文" }],
            },
          },
        ],
      }),
    });
    const r = await pullNotionPagesToKb({ fetchImpl });
    expect(r.total).toBe(1); // 只统计真实页
    const entries = loadKbEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("真实笔记");
    expect(entries.some((e) => e.name.includes("备份"))).toBe(false);
  });
});

describe("kbStore · 已并入 Notion（隐藏本地）", () => {
  it("isKbNotionImported：空/存在未回填条目 → false；全部有 notionId → true", () => {
    expect(isKbNotionImported([])).toBe(false);
    const e1 = { ...saveKbEntry("A", "a"), notionId: "n1" };
    expect(isKbNotionImported([e1])).toBe(true);
    const e2 = { ...saveKbEntry("B", "b") }; // 无 notionId
    expect(isKbNotionImported([e1, e2])).toBe(false);
  });
});

describe("kbStore · 页面树移动（moveKbEntry）", () => {
  it("未同步条目仅本地改父（不调 Notion）", async () => {
    saveNotionCfg({ token: "t" });
    const a = saveKbEntry("父页", "父内容");
    const b = saveKbEntry("子页", "子内容");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === a.id
            ? {
                ...e,
                notionId: "na",
                notionRootId: "kroot",
                notionRootName: "知识库",
              }
            : e,
        ),
      ),
    );
    let called = false;
    const f = (async () => {
      called = true;
      throw new Error("不应调用 Notion");
    }) as unknown as typeof fetch;
    const r = await moveKbEntry({ id: b.id, newParentId: a.id, fetchImpl: f });
    expect(called).toBe(false);
    expect(r.recreated).toBeFalsy();
    const local = loadKbEntries().find((e) => e.id === b.id)!;
    // 未同步条目：本地 parentId 关联，不写 notionParentId
    expect(local.parentId).toBe(a.id);
    expect(local.notionParentId).toBeUndefined();
    expect(local.notionRootId).toBe("kroot");
  });

  it("已同步页面改父 → Notion 重建+删旧并回填新 notionId/根", async () => {
    saveNotionCfg({ token: "t" });
    const a = saveKbEntry("父页", "父内容");
    const b = saveKbEntry("子页", "子内容");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === a.id
            ? {
                ...e,
                notionId: "na",
                notionRootId: "kroot",
                notionRootName: "知识库",
              }
            : {
                ...e,
                notionId: "nb",
                notionRootId: "kroot",
                notionRootName: "知识库",
                notionParentId: "na",
                notionParentName: "父页",
              },
        ),
      ),
    );
    const calls: { deleted?: boolean; parents: string[] } = { parents: [] };
    const fetchImpl = makeRouter({
      "/pages/nb": () => {
        calls.deleted = true;
        return {};
      },
      "/search": (_u, body) => {
        const b2 = body as
          | { query?: string; filter?: { value?: string } }
          | undefined;
        if (b2?.filter?.value === "database") return { results: [] };
        if (!b2?.query) {
          return {
            results: [
              {
                object: "page",
                id: "root1",
                properties: {
                  title: { title: [{ plain_text: "根页面" }] },
                },
                parent: { type: "workspace" },
              },
            ],
          };
        }
        return { results: [] }; // findNotionPageByTitle 未命中 → 新建容器
      },
      "/pages": (_u, body) => {
        const parent =
          (body as { parent?: { page_id?: string } } | undefined)?.parent
            ?.page_id || "";
        calls.parents.push(parent);
        if (parent === "root1") return { id: "kb_container" }; // 知识库容器
        return { id: "nb_new" }; // 重建的子页
      },
    });
    const r = await moveKbEntry({ id: b.id, fetchImpl }); // newParentId 缺省 → 移到顶层
    expect(r.recreated).toBe(true);
    expect(calls.deleted).toBe(true); // 旧页已删除
    expect(calls.parents).toContain("kb_container"); // 重建到知识库根
    const local = loadKbEntries().find((e) => e.id === b.id)!;
    expect(local.notionId).toBe("nb_new");
    expect(local.notionParentId).toBeUndefined();
    expect(local.notionRootId).toBe("kb_container");
  });

  it("不能移动到自身子页面下（防环）", async () => {
    saveNotionCfg({ token: "t" });
    const a = saveKbEntry("父页", "父");
    const b = saveKbEntry("子页", "子");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === a.id
            ? { ...e, notionId: "na" }
            : {
                ...e,
                notionId: "nb",
                notionParentId: "na",
                notionParentName: "父页",
              },
        ),
      ),
    );
    const r = await moveKbEntry({ id: a.id, newParentId: b.id });
    expect(r.error).toBe("不能移动到自身或其子页面下");
    expect(
      loadKbEntries().find((e) => e.id === a.id)?.notionParentId,
    ).toBeUndefined();
  });
});

describe("kbStore · pull 守卫（手动重命名 titleLocked）", () => {
  it("pullNotionPagesToKb：titleLocked 条目标题不被 Notion 覆盖", async () => {
    saveNotionCfg({ token: "t" });
    const entry = saveKbEntry("本地标题", "内容");
    localStorage.setItem(
      "kimo_kb_entries",
      JSON.stringify(
        loadKbEntries().map((e) =>
          e.id === entry.id ? { ...e, notionId: "pg1", titleLocked: true } : e,
        ),
      ),
    );
    const fetchImpl = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "pg1",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Notion新标题" }] },
            },
          },
        ],
      }),
      "blocks/pg1/children": () => ({ results: [] }),
    });
    await pullNotionPagesToKb({ fetchImpl });
    const local = loadKbEntries().find((e) => e.id === entry.id)!;
    expect(local.name).toBe("本地标题"); // 不被 Notion 侧标题覆盖
    expect(local.titleLocked).toBe(true);
  });
});
