import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  queueKbSync,
  flushKbSync,
  resetKbSyncQueue,
  waitForKbSyncIdle,
  subscribeKbSync,
  getKbSyncStatus,
  isKbEntryDirty,
} from "../kbStore";
import { saveKbEntry, loadKbEntries } from "../kb";
import { saveNotionCfg, saveNotionDbId, clearNotionCfg } from "../notion";

/** 构造按 URL 前缀路由的 fetch mock（根页面 + 知识库容器 + 创建页面） */
function makeFetch(opts: { createCalls?: () => void } = {}) {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.includes("/search")) {
      const b = body as { query?: string } | undefined;
      if (!b?.query) {
        // resolveBackupRoots：列出 Content access 根（页面根目录）
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "root1",
                properties: { title: { title: [{ plain_text: "根页面" }] } },
                parent: { type: "workspace" },
              },
            ],
          }),
        };
      }
      // findNotionPageByTitle：找不到
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    if (u.includes("/pages") && !u.includes("blocks")) {
      const parent =
        (body as { parent?: { page_id?: string } })?.parent?.page_id || "";
      // 知识库容器页（挂在根下）不计入条目创建
      if (parent !== "root1") opts.createCalls?.();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: parent === "root1" ? "kb_container" : "pg1",
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ message: "nf" }) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  resetKbSyncQueue();
  vi.useRealTimers();
});

describe("kbStore · 同步队列（防抖合并 + 串行化，追求速度）", () => {
  it("未配置 Notion（目标为 local）时不入队", () => {
    const e = saveKbEntry("本地", "内容");
    queueKbSync(e);
    expect(isKbEntryDirty(e.id)).toBe(false);
    expect(getKbSyncStatus().state).toBe("idle");
  });

  it("同条目多次编辑合并：latest-wins 只同步一次", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    vi.useFakeTimers();
    const e = saveKbEntry("条目", "v1");
    let createCalls = 0;
    const fetchImpl = makeFetch({ createCalls: () => createCalls++ });
    // 连续编辑：防抖窗口内只保留最新内容
    queueKbSync({ ...e, content: "v2" }, { fetchImpl });
    queueKbSync({ ...e, content: "v3" }, { fetchImpl });
    expect(isKbEntryDirty(e.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await waitForKbSyncIdle();
    expect(createCalls).toBe(1);
    const local = loadKbEntries().find((x) => x.id === e.id);
    expect(local?.notionId).toBe("pg1");
    expect(local?.notionSyncedAt).toBeGreaterThan(0);
    expect(isKbEntryDirty(e.id)).toBe(false);
  });

  it("flushKbSync(id) 立即执行单条，不等防抖", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    const e = saveKbEntry("条目", "内容");
    let createCalls = 0;
    const fetchImpl = makeFetch({ createCalls: () => createCalls++ });
    queueKbSync(e, { fetchImpl });
    await flushKbSync(e.id);
    expect(createCalls).toBe(1);
    expect(isKbEntryDirty(e.id)).toBe(false);
  });

  it("subscribeKbSync 通知 syncing→idle 状态", async () => {
    saveNotionCfg({ token: "t" });
    saveNotionDbId("db1");
    const seen: string[] = [];
    const un = subscribeKbSync((s) => seen.push(s.state));
    const e = saveKbEntry("条目", "内容");
    const fetchImpl = makeFetch();
    queueKbSync(e, { fetchImpl });
    await flushKbSync(e.id);
    un();
    expect(seen).toContain("syncing");
    expect(seen[seen.length - 1]).toBe("idle");
  });

  it("clearNotionCfg 后入队不执行（目标回退 local）", async () => {
    clearNotionCfg();
    const e = saveKbEntry("本地", "内容");
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    queueKbSync(e, { fetchImpl: f });
    await flushKbSync(e.id);
    expect(called).toBe(false);
  });
});
