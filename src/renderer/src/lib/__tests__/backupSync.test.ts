import { describe, it, expect, beforeEach } from "vitest";
import {
  BACKUP_CATEGORIES,
  collectBackupData,
  serializeBackup,
  parseBackup,
  isSecretKey,
  pushBackup,
  queueBackupSync,
  flushBackupSync,
  forceBackupAll,
  pullBackupAll,
  syncOnRefresh,
  resolveBackupRoots,
  ensureBackupRoot,
  ensureCategoryPage,
  loadNotionBackupRoot,
  getInitialSynced,
  markInitialSynced,
  clearInitialSynced,
  saveNotionBackupRoot,
  loadBackupState,
  resetBackupRootCache,
  resetBackupSyncQueue,
  subscribeBackupSync,
} from "../backupSync";
import { saveNotionCfg, resetNotionCaches } from "../notion";

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

/** 构造「备份根已存在 + 分类页创建 + 空块列表」的写入 fetch mock */
function writeRouter(pageId: string) {
  return makeRouter({
    "blocks/": () => ({ results: [] }),
    "/pages": () => ({ id: pageId }),
  });
}

beforeEach(() => {
  localStorage.clear();
  resetBackupSyncQueue();
  resetBackupRootCache();
  resetNotionCaches();
});

describe("backupSync · 密钥过滤", () => {
  it("isSecretKey 识别所有密钥黑名单", () => {
    expect(isSecretKey("kimo_ai_local_3")).toBe(true);
    expect(isSecretKey("kimo_search_api_cfg")).toBe(true);
    expect(isSecretKey("kimo_notion_cfg")).toBe(true);
    expect(isSecretKey("kimo_ai_bots")).toBe(true);
    expect(isSecretKey("kimo_ai_bot_config")).toBe(true);
    expect(isSecretKey("kimo_token")).toBe(true);
    expect(isSecretKey("kimo_chat_memory_1")).toBe(false);
  });

  it("collectBackupData 过滤密钥、只收本分类键", () => {
    localStorage.setItem("kimo_ai_fontsize", "lg");
    localStorage.setItem("kimo_theme_mode", "dark");
    localStorage.setItem("kimo_live2d_on", "1");
    localStorage.setItem("kimo_ai_local_1", '{"apiKey":"SECRET"}');
    localStorage.setItem("kimo_search_api_cfg", '{"apiKey":"S"}');
    localStorage.setItem("kimo_chat_memory_1", "用户喜欢柚子社");
    const data = collectBackupData("settings");
    expect(data["kimo_ai_fontsize"]).toBe("lg");
    expect(data["kimo_theme_mode"]).toBe("dark");
    expect(data["kimo_live2d_on"]).toBe("1");
    expect(data["kimo_ai_local_1"]).toBeUndefined();
    expect(data["kimo_search_api_cfg"]).toBeUndefined();
    expect(data["kimo_chat_memory_1"]).toBeUndefined();
    expect(collectBackupData("memory")["kimo_chat_memory_1"]).toBe(
      "用户喜欢柚子社",
    );
  });
});

describe("backupSync · 序列化", () => {
  it("serialize/parse 往返，含 updatedAt 与分类", () => {
    localStorage.setItem("kimo_chat_memory_1", "m");
    const p = serializeBackup("memory");
    expect(p.cat).toBe("memory");
    expect(p.data["kimo_chat_memory_1"]).toBe("m");
    expect(p.bytes).toBeGreaterThan(0);
    const parsed = parseBackup(JSON.stringify(p));
    expect(parsed?.cat).toBe("memory");
    expect(parsed?.updatedAt).toBe(p.updatedAt);
    expect(parsed?.data["kimo_chat_memory_1"]).toBe("m");
  });

  it("parseBackup 非法输入返回 null", () => {
    expect(parseBackup("")).toBeNull();
    expect(parseBackup("not json")).toBeNull();
    expect(parseBackup('{"v":2,"cat":"memory","data":{}}')).toBeNull();
  });
});

describe("backupSync · 推送（队列 + Notion 写入）", () => {
  it("pushBackup：已存根 + 建分类页 + 写状态", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_chat_memory_1", "m");
    const r = await pushBackup("memory", { fetchImpl: writeRouter("pg1") });
    expect(r.ok).toBe(true);
    expect(loadBackupState()["memory"]?.bytes).toBeGreaterThan(0);
    expect(localStorage.getItem("kimo_backup_pages")).toContain("pg1");
  });

  it("pushBackup：未配置 Notion 返回错误", async () => {
    const r = await pushBackup("memory", { token: "" });
    expect(r.ok).toBe(false);
  });

  it("queueBackupSync：未配置 Notion 不入队；配置后 flush 立即推送", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_chat_memory_1", "m1");
    queueBackupSync("memory", { fetchImpl: writeRouter("pg1") });
    await flushBackupSync("memory");
    expect(loadBackupState()["memory"]?.bytes).toBeGreaterThan(0);
  });

  it("sessions 体积超限跳过（oversize）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_chat_sessions_1", "x".repeat(3 * 1024 * 1024));
    const r = await pushBackup("sessions", { fetchImpl: writeRouter("pg1") });
    expect(r.ok).toBe(false);
    expect(r.oversize).toBe(true);
  });

  it("会话历史：本地会话写入 Notion 并更新状态", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem(
      "kimo_chat_sessions_1",
      JSON.stringify([{ id: "s1", title: "对话", messages: [], createdAt: 1 }]),
    );
    const r = await pushBackup("sessions", { fetchImpl: writeRouter("pg_s") });
    expect(r.ok).toBe(true);
    expect(loadBackupState()["sessions"]?.bytes).toBeGreaterThan(0);
    expect(localStorage.getItem("kimo_backup_pages")).toContain("pg_s");
  });

  it("会话历史：queue + flush 路径写入 Notion", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem(
      "kimo_chat_sessions_1",
      JSON.stringify([{ id: "s1", title: "对话", messages: [], createdAt: 1 }]),
    );
    queueBackupSync("sessions", { fetchImpl: writeRouter("pg_s") });
    await flushBackupSync("sessions");
    expect(loadBackupState()["sessions"]?.bytes).toBeGreaterThan(0);
  });

  it("forceBackupAll：返回每类结果，未配置返回空数组", async () => {
    const rs = await forceBackupAll({ fetchImpl: writeRouter("pg1") });
    expect(rs).toEqual([]);
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    const rs2 = await forceBackupAll({ fetchImpl: writeRouter("pg1") });
    expect(rs2.length).toBe(BACKUP_CATEGORIES.length);
    expect(rs2.every((r) => r.ok)).toBe(true);
  });
});

describe("backupSync · 从 Notion 恢复", () => {
  it("新于本地才恢复；绝不写密钥键；不删本机多余键", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_ai_persona_1", "旧笔记");
    // 先推送一次（生成分类页 id + 记录本地同步时间 T0）
    await pushBackup("persona", { fetchImpl: writeRouter("pg_p") });
    const t0 = loadBackupState()["persona"]?.updatedAt || 0;
    // 本地改新（未备份）
    localStorage.setItem("kimo_ai_persona_1", "本地新改");
    localStorage.setItem("kimo_ai_local_1", "keep-secret"); // 本机密钥
    // Notion 侧有更新版本（updatedAt > T0），且备份数据里混入密钥键
    const notionText = JSON.stringify({
      v: 1,
      cat: "persona",
      updatedAt: t0 + 100000,
      data: {
        kimo_ai_persona_1: "来自 Notion 的版本",
        kimo_ai_local_1: "backup-secret",
      },
    });
    const pullFetch = makeRouter({
      "blocks/": () => ({
        results: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: notionText }],
            },
          },
        ],
      }),
    });
    const { restored, skipped } = await pullBackupAll({ fetchImpl: pullFetch });
    expect(restored).toContain("persona");
    expect(localStorage.getItem("kimo_ai_persona_1")).toBe(
      "来自 Notion 的版本",
    );
    // 密钥键绝不写入（保持本机原值）
    expect(localStorage.getItem("kimo_ai_local_1")).toBe("keep-secret");
    // 本机多余键不删除
    expect(localStorage.getItem("kimo_ai_local_1")).toBe("keep-secret");
    expect(skipped.length).toBe(BACKUP_CATEGORIES.length - 1);
  });

  it("Notion 旧于本地跳过（不覆盖）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_chat_memory_1", "本地最新");
    await pushBackup("memory", { fetchImpl: writeRouter("pg_m") });
    const t0 = loadBackupState()["memory"]?.updatedAt || 0;
    localStorage.setItem("kimo_chat_memory_1", "本地最新改");
    const olderText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: t0 - 100000,
      data: { kimo_chat_memory_1: "旧版本" },
    });
    const pullFetch = makeRouter({
      "blocks/": () => ({
        results: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: olderText }],
            },
          },
        ],
      }),
    });
    const { restored } = await pullBackupAll({ fetchImpl: pullFetch });
    expect(restored).not.toContain("memory");
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("本地最新改");
  });
});

describe("backupSync · 备份位置", () => {
  it("resolveBackupRoots 从 Content access 根解析候选", async () => {
    const f = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "r1",
            url: "https://www.notion.so/r1",
            last_edited_time: "2026-08-08T00:00:00.000Z",
            parent: { type: "workspace" },
            properties: {
              title: { title: [{ plain_text: "根1" }] },
            },
          },
        ],
      }),
    });
    const roots = await resolveBackupRoots("t", f);
    expect(roots.length).toBe(1);
    expect(roots[0].id).toBe("r1");
    expect(roots[0].title).toBe("根1");
  });
});

describe("backupSync · 多设备去重", () => {
  it("ensureCategoryPage 复用已存在分类页（不重复创建）", async () => {
    let created = false;
    const f = makeRouter({
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "existing-page",
            url: "https://www.notion.so/x",
            last_edited_time: "2026-08-08T00:00:00.000Z",
            parent: { type: "page_id", page_id: "root1" },
            properties: {
              title: { title: [{ plain_text: "备份 · 记忆" }] },
            },
          },
        ],
      }),
      "pages/existing-page": () => ({
        properties: { title: { title: [{ plain_text: "备份 · 记忆" }] } },
        parent: { type: "page_id", page_id: "root1" },
      }),
      "/pages": () => {
        created = true;
        return { id: "new-page" };
      },
    });
    const id = await ensureCategoryPage("memory", "root1", "t", f);
    expect(id).toBe("existing-page");
    expect(created).toBe(false);
    expect(localStorage.getItem("kimo_backup_pages")).toContain(
      "existing-page",
    );
  });
});

describe("backupSync · 同步位置（根作用域）", () => {
  it("自动（未选择）→ 默认第一个 Content access 根并固化", async () => {
    saveNotionCfg({ token: "t" });
    const f = makeRouter({
      "/search": (_u, body) => {
        const q = (body as { query?: string } | undefined)?.query || "";
        if (q === "AI Setting") return { results: [] }; // 无既有根页
        return {
          results: [
            {
              object: "page",
              id: "r1",
              url: "",
              last_edited_time: "",
              parent: { type: "workspace" },
              properties: {
                title: { title: [{ plain_text: "根1" }] },
              },
            },
            {
              object: "page",
              id: "r2",
              url: "",
              last_edited_time: "",
              parent: { type: "workspace" },
              properties: {
                title: { title: [{ plain_text: "根2" }] },
              },
            },
          ],
        };
      },
      "/pages": () => ({ id: "pg_root" }),
    });
    const id = await ensureBackupRoot("t", f);
    expect(id).toBe("pg_root");
    expect(loadNotionBackupRoot()).toBe("r1"); // 默认固化第一个根
  });

  it("不复用其他位置的「AI Setting」页（父≠目标根 → 在目标根下新建）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("r1"); // 用户选定根 r1
    const f = makeRouter({
      // 全局搜到同名页但父=other（错误位置）
      "/search": () => ({
        results: [
          {
            object: "page",
            id: "wrong_page",
            url: "",
            last_edited_time: "",
            parent: { type: "page_id", page_id: "other_root" },
            properties: {
              title: { title: [{ plain_text: "AI Setting" }] },
            },
          },
        ],
      }),
      "pages/wrong_page": () => ({
        properties: {},
        parent: { type: "page_id", page_id: "other_root" },
      }),
      "/pages": () => ({ id: "pg_root" }),
    });
    const id = await ensureBackupRoot("t", f);
    expect(id).toBe("pg_root"); // 在目标根 r1 下新建，不复用 wrong_page
  });
});

describe("backupSync · 多端自动合并（默认）+ 初次同步", () => {
  /** 构造「分类页已存在 + 云端有更新备份」的环境 */
  const seedExisting = (
    cat: "memory" | "sessions",
    existingData: Record<string, string>,
  ) => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_pages", JSON.stringify({ [cat]: "pg1" }));
    const existingText = JSON.stringify({
      v: 1,
      cat,
      updatedAt: 999999,
      data: existingData,
    });
    return makeRouter({
      "blocks/": () => ({
        results: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: existingText }],
            },
          },
        ],
      }),
      // 在所选根下创建「Kimo 备份」根页
      "/pages": () => ({ id: "pg_root" }),
    });
  };

  it("云端更新过（另一设备写过）→ 自动合并写回本机并同步", async () => {
    localStorage.setItem("kimo_chat_memory_1", "本地行A\n本地行B");
    const r = await pushBackup("memory", {
      fetchImpl: seedExisting("memory", { kimo_chat_memory_1: "云端行" }),
    });
    expect(r.ok).toBe(true);
    const merged = localStorage.getItem("kimo_chat_memory_1") || "";
    expect(merged).toContain("本地行A");
    expect(merged).toContain("本地行B");
    expect(merged).toContain("云端行");
  });

  it("本机自己的更新（云端未更新）→ 直接覆盖不合并", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg1" }),
    );
    localStorage.setItem(
      "kimo_backup_state",
      JSON.stringify({ memory: { updatedAt: 1000, bytes: 10 } }),
    );
    localStorage.setItem("kimo_chat_memory_1", "本地新行");
    const olderText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: 500, // 早于本机上次推送 → 视为本机数据，不合并
      data: { kimo_chat_memory_1: "旧云端行" },
    });
    const f = makeRouter({
      "blocks/": () => ({
        results: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: olderText }],
            },
          },
        ],
      }),
      // 在所选根下创建「Kimo 备份」根页
      "/pages": () => ({ id: "pg_root" }),
    });
    const r = await pushBackup("memory", { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("本地新行"); // 不并入旧云端行
  });

  it("sessions 按会话 id 合并（多端会话都保留）", async () => {
    const local = JSON.stringify([
      { id: "s1", title: "a" },
      { id: "s2", title: "b" },
    ]);
    const cloud = JSON.stringify([
      { id: "s1", title: "a-旧" },
      { id: "s3", title: "c" },
    ]);
    localStorage.setItem("kimo_chat_sessions_1", local);
    const r = await pushBackup("sessions", {
      fetchImpl: seedExisting("sessions", { kimo_chat_sessions_1: cloud }),
    });
    expect(r.ok).toBe(true);
    const merged = JSON.parse(
      localStorage.getItem("kimo_chat_sessions_1") || "[]",
    ) as { id: string }[];
    expect(merged.length).toBe(3);
    expect(merged.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("初次同步标记：get/mark/clear", () => {
    expect(getInitialSynced()).toBe(false);
    markInitialSynced();
    expect(getInitialSynced()).toBe(true);
    clearInitialSynced();
    expect(getInitialSynced()).toBe(false);
  });

  it("syncOnRefresh：本机有数据而云端空 → 推送填充云端（修复空白页）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root"); // 根页已缓存
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "本地记忆行");
    let patched = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    }) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(patched).toBe(1); // 本机数据被推送到云端填充
  });

  it("syncOnRefresh：云端与本机完全一致 → 跳过（不推送）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "一致行");
    const cloudText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: 123,
      data: { kimo_chat_memory_1: "一致行" },
    });
    let patched = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", plain_text: cloudText }],
              },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(patched).toBe(0); // 一致不推送
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("一致行");
  });

  it("syncOnRefresh：云端与本机都不同 → 合并写本机并推回云端", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "本地行");
    const existingText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: 999999,
      data: { kimo_chat_memory_1: "云端行" },
    });
    let patched = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", plain_text: existingText }],
              },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    const merged = localStorage.getItem("kimo_chat_memory_1") || "";
    expect(merged).toContain("本地行");
    expect(merged).toContain("云端行");
    expect(patched).toBe(1); // 合并结果推送云端
  });

  it("syncOnRefresh：本机无数据而云端有 → 拉取云端合并进本机（新设备/清缓存恢复）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    // 本机没有 kimo_chat_memory_1（模拟新设备/清缓存）
    const cloudText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: 888,
      data: { kimo_chat_memory_1: "云端记忆" },
    });
    const f = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: cloudText }],
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("云端记忆");
  });

  it("syncOnRefresh：发出同步状态事件（syncing→idle）供加载动画", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "一致行");
    const cloudText = JSON.stringify({
      v: 1,
      cat: "memory",
      updatedAt: 123,
      data: { kimo_chat_memory_1: "一致行" },
    });
    const seen: string[] = [];
    const unsub = subscribeBackupSync((s) => seen.push(s.state));
    const f = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", plain_text: cloudText }],
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(seen).toContain("syncing");
    expect(seen[seen.length - 1]).toBe("idle");
    unsub();
  });

  it("pushBackup：缓存页已被删除 → 写入失败后自动清缓存重建重试成功", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    // 缓存指向已被用户删除的页面（根页/分类页 id 失效）
    localStorage.setItem("kimo_backup_root_page", "pg_deleted_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_deleted_cat" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "记忆数据");
    let patchCount = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method || "GET";
      if (m === "PATCH") {
        patchCount++;
        if (patchCount === 1) {
          // 第一次：页面已被删除 → 404
          return {
            ok: false,
            status: 404,
            json: async () => ({ message: "not found" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (u.includes("blocks/") && m === "GET") {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (u.includes("search")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (u.includes("/pages") && m === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const parent = (body.parent?.page_id || "") as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: parent === "root1" ? "pg_new_root" : "pg_new_cat",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await pushBackup("memory", { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(patchCount).toBe(2); // 第一次失败 + 重建后成功
    // 缓存已重建为新页面 id
    expect(localStorage.getItem("kimo_backup_root_page")).toBe("pg_new_root");
    expect(
      JSON.parse(localStorage.getItem("kimo_backup_pages") || "{}").memory,
    ).toBe("pg_new_cat");
  });

  it("syncOnRefresh：本机会话超限 → 只拉不推（云端对话仍能拉到本机）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ sessions: "pg_s" }),
    );
    // 本机会话巨大（超 maxBytes 2MB）：构造超限 JSON
    const bigSession = {
      id: "s1",
      title: "x".repeat(2 * 1024 * 1024),
      msgs: [],
    };
    localStorage.setItem("kimo_chat_sessions_1", JSON.stringify([bigSession]));
    expect(serializeBackup("sessions").bytes).toBeGreaterThan(2 * 1024 * 1024);
    let patched = 0;
    const cloudText = JSON.stringify({
      v: 1,
      cat: "sessions",
      updatedAt: 999999,
      data: { kimo_chat_sessions_1: JSON.stringify([{ id: "cloud1" }]) },
    });
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", plain_text: cloudText }],
              },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(patched).toBe(0); // 超限不推送本机
    // 但云端数据仍拉取合并进本机（覆盖原超大本机会话）
    const merged = localStorage.getItem("kimo_chat_sessions_1") || "";
    expect(merged).toContain("cloud1");
  });

  it("pushBackup：读取云端失败 → 保守不覆盖（返回失败，本机不变）", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "本机记忆");
    let patched = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      // 读取 blocks children 失败（500）
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: "err" }),
      };
    }) as unknown as typeof fetch;
    const r = await pushBackup("memory", { fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(patched).toBe(0); // 未覆盖云端
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("本机记忆"); // 本机不变
  });

  it("syncOnRefresh：读取云端失败 → 不清真覆盖，清缓存供下次重建", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionBackupRoot("root1");
    localStorage.setItem("kimo_backup_root_page", "pg_root");
    localStorage.setItem(
      "kimo_backup_pages",
      JSON.stringify({ memory: "pg_m" }),
    );
    localStorage.setItem("kimo_chat_memory_1", "本机记忆");
    let patched = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("blocks/") && init?.method === "PATCH") {
        patched++;
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: "err" }),
      };
    }) as unknown as typeof fetch;
    await syncOnRefresh({ fetchImpl: f });
    expect(patched).toBe(0); // 未覆盖云端
    expect(localStorage.getItem("kimo_chat_memory_1")).toBe("本机记忆"); // 本机不变
    // 缓存被清（下次同步重建页面）
    expect(localStorage.getItem("kimo_backup_pages")).toBeNull();
    expect(localStorage.getItem("kimo_backup_root_page")).toBeNull();
  });
});
