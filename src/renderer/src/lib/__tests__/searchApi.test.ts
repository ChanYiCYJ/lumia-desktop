import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSearchApiCfg,
  saveSearchApiCfg,
  clearSearchApiCfg,
  hasSearchApi,
  cacheTtlMs,
  todayStr,
  isFreshQuery,
  testSearchApi,
} from "../searchApi";

beforeEach(() => {
  localStorage.clear();
});

describe("searchApi · 配置读写", () => {
  it("默认 auto + 1h TTL", () => {
    expect(loadSearchApiCfg()).toEqual({
      provider: "auto",
      apiKey: "",
      instance: "",
      ttl: 60,
    });
  });
  it("保存后可读取", () => {
    saveSearchApiCfg({
      provider: "tavily",
      apiKey: "tvly-test",
      instance: "",
      ttl: 15,
    });
    expect(loadSearchApiCfg()).toEqual({
      provider: "tavily",
      apiKey: "tvly-test",
      instance: "",
      ttl: 15,
    });
  });
  it("非法 provider/ttl 回退默认", () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({ provider: "xxx", apiKey: "k", instance: "", ttl: 999 }),
    );
    expect(loadSearchApiCfg()).toEqual({
      provider: "auto",
      apiKey: "k",
      instance: "",
      ttl: 60,
    });
  });
  it("损坏 JSON 回退默认", () => {
    localStorage.setItem("kimo_search_api_cfg", "{bad");
    expect(loadSearchApiCfg().provider).toBe("auto");
  });
  it("清除后回默认", () => {
    saveSearchApiCfg({
      provider: "searxng",
      apiKey: "",
      instance: "https://searx.be",
      ttl: 360,
    });
    clearSearchApiCfg();
    expect(loadSearchApiCfg().provider).toBe("auto");
  });
});

describe("searchApi · hasSearchApi / cacheTtlMs", () => {
  it("tavily 需 key 才算已配置", () => {
    expect(
      hasSearchApi({ provider: "tavily", apiKey: "", instance: "", ttl: 60 }),
    ).toBe(false);
    expect(
      hasSearchApi({
        provider: "tavily",
        apiKey: "tvly-x",
        instance: "",
        ttl: 60,
      }),
    ).toBe(true);
  });
  it("searxng 需实例地址", () => {
    expect(
      hasSearchApi({
        provider: "searxng",
        apiKey: "",
        instance: "searx.be",
        ttl: 60,
      }),
    ).toBe(false);
    expect(
      hasSearchApi({
        provider: "searxng",
        apiKey: "",
        instance: "https://searx.be",
        ttl: 60,
      }),
    ).toBe(true);
  });
  it("auto 不算已配置", () => {
    expect(
      hasSearchApi({ provider: "auto", apiKey: "x", instance: "", ttl: 60 }),
    ).toBe(false);
  });
  it("cacheTtlMs 默认 1h，按配置 15min/6h", () => {
    expect(cacheTtlMs()).toBe(60 * 60 * 1000);
    expect(
      cacheTtlMs({ provider: "tavily", apiKey: "k", instance: "", ttl: 15 }),
    ).toBe(15 * 60 * 1000);
    expect(
      cacheTtlMs({ provider: "tavily", apiKey: "k", instance: "", ttl: 360 }),
    ).toBe(360 * 60 * 1000);
    expect(
      cacheTtlMs({
        provider: "tavily",
        apiKey: "k",
        instance: "",
        ttl: 999 as never,
      }),
    ).toBe(60 * 60 * 1000);
  });
});

describe("searchApi · todayStr / isFreshQuery", () => {
  it("todayStr 输出 YYYY-MM-DD", () => {
    expect(todayStr(new Date(2026, 7, 7))).toBe("2026-08-07");
    expect(todayStr(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("时敏查询识别", () => {
    expect(isFreshQuery("今天的人工智能新闻")).toBe(true);
    expect(isFreshQuery("最新发布的新作")).toBe(true);
    expect(isFreshQuery("React 19 新特性")).toBe(false);
    expect(isFreshQuery("typeScript latest release")).toBe(true);
  });
});

describe("searchApi · testSearchApi", () => {
  it("auto 提示先选平台", async () => {
    const r = await testSearchApi({
      provider: "auto",
      apiKey: "",
      instance: "",
      ttl: 60,
    });
    expect(r.ok).toBe(false);
  });
  it("tavily 缺 key 提示", async () => {
    const r = await testSearchApi({
      provider: "tavily",
      apiKey: "",
      instance: "",
      ttl: 60,
    });
    expect(r.message).toContain("API Key");
  });
  it("searxng 缺实例地址提示", async () => {
    const r = await testSearchApi({
      provider: "searxng",
      apiKey: "",
      instance: "",
      ttl: 60,
    });
    expect(r.message).toContain("实例地址");
  });
  it("tavily 200 且有结果 → 连接成功", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ results: [{ title: "a", url: "https://a.com" }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )) as typeof fetch;
    const r = await testSearchApi(
      { provider: "tavily", apiKey: "tvly-x", instance: "", ttl: 60 },
      fetchImpl,
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain("连接成功");
  });
  it("tavily 401 → 认证失败", async () => {
    const fetchImpl = (async () =>
      new Response("bad key", { status: 401 })) as typeof fetch;
    const r = await testSearchApi(
      { provider: "tavily", apiKey: "bad", instance: "", ttl: 60 },
      fetchImpl,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("认证失败");
  });
  it("直连被 CORS 拦 → 走代理，代理有结果则成功", async () => {
    let called = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      called++;
      if (String(input).startsWith("http")) throw new Error("Failed to fetch");
      return new Response(
        JSON.stringify([{ title: "a", url: "https://a.com" }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const r = await testSearchApi(
      { provider: "tavily", apiKey: "tvly-x", instance: "", ttl: 60 },
      fetchImpl,
    );
    expect(called).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("经代理");
  });
  it("直连与代理都被拦 → 网络错误提示", async () => {
    const fetchImpl = (async () => {
      throw new Error("Failed to fetch");
    }) as typeof fetch;
    const r = await testSearchApi(
      { provider: "tavily", apiKey: "tvly-x", instance: "", ttl: 60 },
      fetchImpl,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("网络错误");
  });
});
