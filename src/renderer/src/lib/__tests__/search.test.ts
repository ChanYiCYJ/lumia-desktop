import { describe, it, expect, vi, afterEach } from "vitest";
import {
  webSearch,
  readSearchCache,
  writeSearchCache,
  searchBackend,
  searchFast,
  searchFastWithAnswer,
  searchTavilyDeep,
  detectQueryType,
  detectQueryLang,
  searchAI,
  webSearchToArticle,
  fetchWebContent,
  isContentBlocked,
  filterSensitiveResults,
} from "../search";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("search · 网络搜索链路", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("优先后端 /api/search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/search")) {
          return jsonResponse([
            {
              title: "后端结果",
              url: "https://a.com",
              description: "后端描述",
            },
          ]);
        }
        return jsonResponse({ query: { pages: {} } });
      }),
    );
    const r = await webSearch("test");
    expect(r).toContain("后端结果");
    expect(r).not.toContain("未找到");
  });

  it("后端空时回退 AI 搜索（读取 kimo_ai_bots 配置）", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        { endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" },
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("/api/search")) return jsonResponse([]);
        if (u.includes("/chat/completions")) {
          return jsonResponse({
            choices: [
              { message: { content: "- 标题A (https://a.com)\n  描述A" } },
            ],
          });
        }
        return jsonResponse({ query: { pages: {} } });
      }),
    );
    const r = await webSearch("test");
    expect(r).toContain("标题A");
    expect(r).not.toContain("未找到");
  });

  it("后端与 AI 空时回退维基（opensearch + 批量简介）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("/api/search")) return jsonResponse([]);
        if (u.includes("action=opensearch")) {
          return jsonResponse([
            "test",
            ["维基条目"],
            ["简短描述"],
            ["https://zh.wikipedia.org/wiki/维基条目"],
          ]);
        }
        if (u.includes("prop=extracts")) {
          return jsonResponse({
            query: {
              pages: { "1": { title: "维基条目", extract: "这是条目简介。" } },
            },
          });
        }
        return jsonResponse([]);
      }),
    );
    const r = await webSearch("test");
    expect(r).toContain("维基条目");
    expect(r).toContain("这是条目简介");
    expect(r).not.toContain("未找到");
  });

  it("本地自定义 API（kimo_ai_local_*）也能用于 AI 搜索", async () => {
    localStorage.setItem(
      "kimo_ai_local_3",
      JSON.stringify({
        endpoint: "https://api.y.com/v1",
        apiKey: "k",
        model: "m",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("/api/search")) return jsonResponse([]);
        if (u.includes("/chat/completions")) {
          return jsonResponse({
            choices: [
              {
                message: { content: "- 本地结果 (https://b.com)\n  本地描述" },
              },
            ],
          });
        }
        return jsonResponse({ query: { pages: {} } });
      }),
    );
    const r = await webSearch("test");
    expect(r).toContain("本地结果");
  });

  it("全部来源失败时返回未找到提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/search")) return jsonResponse([]);
        return new Response("", { status: 500 });
      }),
    );
    const r = await webSearch("test");
    expect(r).toContain("未找到结果");
  });
});

describe("search · bilibili 站内源短 TTL", () => {
  afterEach(() => {
    localStorage.clear();
  });

  const biliEntry = {
    content: "bilibili 内容",
    article: "",
    sources: [
      {
        title: "B站视频",
        url: "https://www.bilibili.com/video/BV1",
        description: "desc",
        source: "bilibili.com",
        engine: "bilibili",
      },
    ],
    time: 0,
    loading: false,
  };

  it("含 bilibili 来源的缓存超过 30 分钟视为过期", () => {
    // 40 分钟前写入 → bilibili 命中 30min TTL → 过期返回 null
    localStorage.setItem(
      "kimo_search_cache_v1",
      JSON.stringify({
        test: { ...biliEntry, time: Date.now() - 40 * 60 * 1000 },
      }),
    );
    expect(readSearchCache("test")).toBeNull();
  });

  it("含 bilibili 来源的缓存 20 分钟内仍有效", () => {
    localStorage.setItem(
      "kimo_search_cache_v1",
      JSON.stringify({
        test: { ...biliEntry, time: Date.now() - 20 * 60 * 1000 },
      }),
    );
    const r = readSearchCache("test");
    expect(r).not.toBeNull();
    expect(r?.cached).toBe(true);
  });

  it("非 bilibili 来源保持 6h TTL（40 分钟仍有效）", () => {
    const entry = {
      ...biliEntry,
      sources: [
        {
          title: "普通站",
          url: "https://example.com/a",
          description: "desc",
          source: "example.com",
          engine: "backend",
        },
      ],
    };
    localStorage.setItem(
      "kimo_search_cache_v1",
      JSON.stringify({
        test: { ...entry, time: Date.now() - 40 * 60 * 1000 },
      }),
    );
    const r = readSearchCache("test");
    expect(r).not.toBeNull();
    expect(r?.cached).toBe(true);
  });

  it("writeSearchCache 写入后同查询可命中（含 loading 标记）", () => {
    writeSearchCache("query", {
      content: "半成品",
      sources: [
        {
          title: "B站",
          url: "https://www.bilibili.com/video/BV2",
          description: "",
          source: "bilibili.com",
          engine: "bilibili",
        },
      ],
      loading: true,
    });
    const r = readSearchCache("query");
    expect(r?.loading).toBe(true);
  });
});

describe("search · 缓存卡死恢复（loading 永不过期 bug）", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("loading 卡死超过 5 分钟 → readSearchCache 返回 null（允许重新搜索）", () => {
    writeSearchCache("kw", { loading: true });
    // 手动改造成 6 分钟前开始
    const map = JSON.parse(
      localStorage.getItem("kimo_search_cache_v1") || "{}",
    );
    map["kw"] = { ...map["kw"], loadingAt: Date.now() - 6 * 60 * 1000 };
    localStorage.setItem("kimo_search_cache_v1", JSON.stringify(map));
    expect(readSearchCache("kw")).toBeNull();
    expect(localStorage.getItem("kimo_search_cache_v1")).not.toContain('"kw"');
  });

  it("刚进入 loading 的条目仍返回 loading（并发去重）", () => {
    writeSearchCache("kw", { loading: true });
    const r = readSearchCache("kw");
    expect(r?.loading).toBe(true);
  });

  it("writeSearchCache 进入 loading 记录 loadingAt，完成时清除", () => {
    writeSearchCache("kw", { loading: true });
    let map = JSON.parse(localStorage.getItem("kimo_search_cache_v1") || "{}");
    expect(map["kw"].loadingAt).toBeTypeOf("number");
    writeSearchCache("kw", { loading: false, content: "x" });
    map = JSON.parse(localStorage.getItem("kimo_search_cache_v1") || "{}");
    expect(map["kw"].loadingAt).toBeUndefined();
    expect(map["kw"].loading).toBe(false);
  });
});

describe("search · 查询类型/语言检测", () => {
  it("天气查询", () => {
    expect(detectQueryType("北京今天天气").weather).toBe(true);
    expect(detectQueryType("北京今天天气").fresh).toBe(true);
    expect(detectQueryType("上海明天会下雨吗").fresh).toBe(true);
  });
  it("新番查询", () => {
    const t = detectQueryType("2026年7月新番");
    expect(t.anime).toBe(true);
    expect(t.fresh).toBe(true);
  });
  it("新闻查询", () => {
    const t = detectQueryType("今日科技新闻");
    expect(t.news).toBe(true);
    expect(t.fresh).toBe(true);
  });
  it("普通查询非 fresh", () => {
    const t = detectQueryType("React 生命周期");
    expect(t.fresh).toBe(false);
    expect(t.weather).toBe(false);
    expect(t.anime).toBe(false);
  });
  it("语言检测（含多语言 ja/ko）", () => {
    expect(detectQueryLang("北京天气")).toBe("zh");
    expect(detectQueryLang("latest iphone")).toBe("en");
    expect(detectQueryLang("新番 anime 2026")).toBe("zh");
    // 日文假名 → ja
    expect(detectQueryLang("2026年夏アニメ 一覧")).toBe("ja");
    expect(detectQueryLang("アニメ 新作 2026")).toBe("ja");
    // 韩文谚文 → ko
    expect(detectQueryLang("2026년 여름 신작 애니메이션")).toBe("ko");
    expect(detectQueryLang("Roselia 멤버")).toBe("ko");
    // 中英混合仍主要判 zh
    expect(detectQueryLang("2026年7月新番 anime lineup")).toBe("zh");
  });
});

describe("search · searchBackend 按类型/语言/Fast 传参", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("天气查询 → engines=weather + lang=zh", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("北京今天天气", 4);
    expect(calls[0]).toContain("/api/search");
    expect(calls[0]).toContain("engines=weather");
    expect(calls[0]).toContain("lang=zh");
  });

  it("新番查询 → engines=bangumi", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("2026年7月新番", 4);
    expect(calls[0]).toContain("engines=bangumi");
  });

  it("英文新闻 → engines 含 googlenews + lang=en", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("latest AI news", 4);
    expect(calls[0]).toContain("engines=googlenews");
    expect(calls[0]).toContain("lang=en");
  });

  it("Fast 模式 → 精简引擎 + fast=1", async () => {
    localStorage.setItem("kimo_ai_search_speed", "fast");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("react hooks", 4);
    expect(calls[0]).toContain("fast=1");
    expect(calls[0]).toContain("engines=duckduckgo");
  });

  it("日文查询 → 多语言双搜索（lang=ja + lang=en）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("2026年夏アニメ 一覧", 4);
    // 非英文查询并行搜索主要语言 + 英文，覆盖多语源
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.includes("lang=ja"))).toBe(true);
    expect(calls.some((c) => c.includes("lang=en"))).toBe(true);
  });

  it("英文查询 → 单次搜索（lang=en）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    await searchBackend("summer anime lineup", 4);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("lang=en");
  });
});

describe("search · 幻觉抑制（来源约束）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("searchAI 系统提示含「不要编造 URL」，空结果返回 []", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        { endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" },
      ]),
    );
    let sysText = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/chat/completions")) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            messages?: { role: string; content: string }[];
          };
          sysText = body?.messages?.[0]?.content || "";
          return jsonResponse({ choices: [{ message: { content: "[]" } }] });
        }
        return jsonResponse([]);
      }),
    );
    const res = await searchAI("test", 3);
    expect(res).toEqual([]); // AI 无把握时返回空数组，不编造
    expect(sysText).toContain("绝对不要编造");
    expect(sysText).toContain("返回空数组");
  });

  it("searchAI 推理模型 max_tokens 走 resolveMaxTokens（加大避免思考占满）", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        {
          endpoint: "https://api.x.com/v1",
          apiKey: "k",
          model: "deepseek-reasoner",
        },
      ]),
    );
    let body: { max_tokens?: number } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/chat/completions")) {
          body = JSON.parse(String(init?.body || "{}")) as {
            max_tokens?: number;
          };
          return jsonResponse({ choices: [{ message: { content: "[]" } }] });
        }
        return jsonResponse([]);
      }),
    );
    await searchAI("test", 3);
    expect(body.max_tokens).toBe(16384); // 推理模型 resolveMaxTokens 取 16384
  });

  it("searchAI 空内容时重试一次，第二次返回结果", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        { endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" },
      ]),
    );
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/chat/completions")) {
          call++;
          if (call === 1) {
            // 推理模型首次思考占满 token → content 空
            return jsonResponse({ choices: [{ message: { content: "" } }] });
          }
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      title: "官方文档",
                      url: "https://docs.example.com",
                      description: "desc",
                    },
                  ]),
                },
              },
            ],
          });
        }
        return jsonResponse([]);
      }),
    );
    const res = await searchAI("test", 3);
    expect(call).toBe(2); // 重试了一次
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe("官方文档");
    expect(res[0].engine).toBe("ai");
  });

  it("searchAI 两次都空返回 []", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        { endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" },
      ]),
    );
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/chat/completions")) {
          call++;
          return jsonResponse({ choices: [{ message: { content: "" } }] });
        }
        return jsonResponse([]);
      }),
    );
    const res = await searchAI("test", 3);
    expect(call).toBe(2);
    expect(res).toEqual([]);
  });

  it("webSearchToArticle 系统提示含来源约束 + 抓取失败标注资料有限", async () => {
    localStorage.setItem(
      "kimo_ai_bots",
      JSON.stringify([
        { endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" },
      ]),
    );
    let capturedSys = "";
    let capturedUser = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/api/search")) {
          return jsonResponse([
            {
              title: "真实来源",
              url: "https://real.com/article",
              description: "desc",
              source: "real.com",
              engine: "backend",
            },
          ]);
        }
        if (u.startsWith("/api/fetch")) {
          // 抓取失败：验证「资料有限」标注（直连也会失败）
          return new Response("fail", { status: 502 });
        }
        if (u.includes("/chat/completions")) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            messages?: { role: string; content: string }[];
          };
          capturedSys = body?.messages?.[0]?.content || "";
          capturedUser = body?.messages?.[1]?.content || "";
          return jsonResponse({
            choices: [{ message: { content: "# 标题\n正文" } }],
          });
        }
        return new Response("fail", { status: 500 });
      }),
    );
    const r = await webSearchToArticle("测试主题", 2);
    expect(r.article).toContain("# 标题");
    expect(capturedSys).toContain("来源约束");
    expect(capturedSys).toContain("资料有限，未能核实");
    // 抓取失败时，userMsg 明确标注「内容抓取失败/资料有限」，避免 AI 当成真实正文编造
    expect(capturedUser).toContain("内容抓取失败或为空");
    expect(capturedUser).toContain("资料有限");
    expect(capturedUser).toContain("请勿编造");
  });
});

describe("search · searchFast（Auto 联网提速）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("配置 Tavily 时优先浏览器直连（basic 深度、不请求 AI 回答），不走 /api/search", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    const calls: string[] = [];
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("api.tavily.com/search")) {
          body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return jsonResponse({
            results: [
              {
                title: "Tavily 直连",
                url: "https://tavily.com/x",
                content: "desc",
              },
            ],
          });
        }
        return jsonResponse([]);
      }),
    );
    const r = await searchFast("2026年8月 AI 新闻", 6);
    // 直连命中 → 结果来自 Tavily，且没有走慢的后端 /api/search
    expect(r.length).toBe(1);
    expect(r[0].engine).toBe("tavily");
    expect(calls.some((c) => c.includes("/api/search"))).toBe(false);
    // 快路径：basic 深度 + 不生成 AI 回答（提速关键）
    expect(body.search_depth).toBe("basic");
    expect(body.include_answer).toBe(false);
  });

  it("Tavily 直连空/失败时回退 Worker /api/search", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("api.tavily.com/search"))
          return jsonResponse({ results: [] });
        if (u.startsWith("/api/search"))
          return jsonResponse([
            { title: "后端兜底", url: "https://b.com", description: "d" },
          ]);
        return jsonResponse([]);
      }),
    );
    const r = await searchFast("test query", 6);
    expect(r.some((x) => x.title === "后端兜底")).toBe(true);
    expect(calls.some((c) => c.includes("/api/search"))).toBe(true);
  });

  it("未配置 Tavily 时直接走 Worker /api/search（不触发 tavily 直连）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.startsWith("/api/search"))
          return jsonResponse([
            { title: "后端结果", url: "https://c.com", description: "d" },
          ]);
        return jsonResponse([]);
      }),
    );
    const r = await searchFast("hello world", 6);
    expect(r.some((x) => x.title === "后端结果")).toBe(true);
    expect(calls.some((c) => c.includes("api.tavily.com"))).toBe(false);
  });
});

describe("search · searchTavilyDeep + searchFastWithAnswer（Tavily 直连专属路径）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("searchTavilyDeep：advanced 深度 + AI 直接答案，时敏查询切 news topic/day", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("api.tavily.com/search")) {
          body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return jsonResponse({
            answer: "Tavily 官方直接答案：2026年8月 AI 新闻要点……",
            results: [
              { title: "T1", url: "https://t1.com", content: "d1" },
              { title: "T2", url: "https://t2.com", content: "d2" },
            ],
          });
        }
        return jsonResponse([]);
      }),
    );
    const r = await searchTavilyDeep("2026年8月 AI 新闻", 6);
    expect(r.results.length).toBe(2);
    expect(r.answer).toContain("Tavily 官方直接答案");
    expect(body.search_depth).toBe("advanced");
    expect(body.include_answer).toBe("advanced");
    // 时敏查询：news topic + day 时窗（与 Tavily 官网同配置）
    expect(body.topic).toBe("news");
    expect(body.time_range).toBe("day");
  });

  it("searchTavilyDeep：非时敏查询用 general/week", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("api.tavily.com/search")) {
          body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          return jsonResponse({
            answer: "",
            results: [{ title: "T", url: "https://t.com", content: "d" }],
          });
        }
        return jsonResponse([]);
      }),
    );
    const r = await searchTavilyDeep("React 是什么", 6);
    expect(r.results.length).toBe(1);
    expect(body.topic).toBe("general");
    expect(body.time_range).toBe("week");
  });

  it("searchTavilyDeep：未配置 Tavily 返回空（不发起请求）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return jsonResponse([]);
      }),
    );
    const r = await searchTavilyDeep("hello", 6);
    expect(r.results.length).toBe(0);
    expect(r.answer).toBe("");
    expect(calls.some((c) => c.includes("api.tavily.com"))).toBe(false);
  });

  it("searchFastWithAnswer：配置 Tavily 直连命中 → 返回结果 + answer，不走 /api/search", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("api.tavily.com/search"))
          return jsonResponse({
            answer: "直接答案",
            results: [{ title: "T", url: "https://t.com", content: "d" }],
          });
        return jsonResponse([]);
      }),
    );
    const r = await searchFastWithAnswer("2026年8月 AI 新闻", 8);
    expect(r.results.some((x) => x.engine === "tavily")).toBe(true);
    expect(r.answer).toBe("直接答案");
    expect(calls.some((c) => c.includes("/api/search"))).toBe(false);
  });

  it("searchFastWithAnswer：Tavily 直连空 → 回退 Worker /api/search（answer 空）", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-test",
        instance: "",
        ttl: 60,
      }),
    );
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("api.tavily.com/search"))
          return jsonResponse({ results: [] });
        if (u.startsWith("/api/search"))
          return jsonResponse([
            { title: "后端", url: "https://b.com", description: "d" },
          ]);
        return jsonResponse([]);
      }),
    );
    const r = await searchFastWithAnswer("test", 6);
    expect(r.results.some((x) => x.title === "后端")).toBe(true);
    expect(r.answer).toBe("");
    expect(calls.some((c) => c.includes("/api/search"))).toBe(true);
  });

  it("searchFastWithAnswer：未配置 Tavily 直接走 /api/search，不触发 tavily", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.startsWith("/api/search"))
          return jsonResponse([
            { title: "后端结果", url: "https://c.com", description: "d" },
          ]);
        return jsonResponse([]);
      }),
    );
    const r = await searchFastWithAnswer("hello", 6);
    expect(r.results.some((x) => x.title === "后端结果")).toBe(true);
    expect(r.answer).toBe("");
    expect(calls.some((c) => c.includes("api.tavily.com"))).toBe(false);
  });
});

describe("search · isContentBlocked（违规内容友好兜底）", () => {
  it("400/403 + 内容策略关键词 → true", () => {
    expect(
      isContentBlocked(
        new Error("AI 请求失败 (400): content policy violation"),
      ),
    ).toBe(true);
    expect(isContentBlocked(new Error("AI 请求失败 (400): 敏感内容"))).toBe(
      true,
    );
    expect(isContentBlocked("400 违规内容")).toBe(true);
    expect(isContentBlocked(new Error("403 blocked"))).toBe(true);
  });
  it("非违规错误 → false", () => {
    expect(isContentBlocked(new Error("AI 请求失败 (500): timeout"))).toBe(
      false,
    );
    expect(isContentBlocked(new Error("network error"))).toBe(false);
    expect(isContentBlocked("")).toBe(false);
    expect(isContentBlocked(new Error("400: 请求参数错误"))).toBe(false);
  });
});

describe("search · fetchWebContent 会话内缓存（view 提速）", () => {
  it("同一 URL 只抓取一次，第二次命中缓存", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.startsWith("/api/fetch")) {
          return jsonResponse({
            url: "https://a.com",
            content: "这是正文内容……",
            title: "A",
            ogImage: "https://a.com/img.png",
            images: [],
          });
        }
        return jsonResponse({});
      }),
    );
    const r1 = await fetchWebContent("https://a.com", 2000);
    const r2 = await fetchWebContent("https://a.com", 2000);
    expect(r1.content).toBe("这是正文内容……");
    expect(r2.content).toBe("这是正文内容……");
    expect(calls.filter((c) => c.startsWith("/api/fetch")).length).toBe(1);
  });

  it("失败（抛错）不缓存，允许重试", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.startsWith("/api/fetch")) {
          attempt++;
          // 第一次：代理失败；第二次：成功
          if (attempt === 1) throw new Error("Failed to fetch");
          return jsonResponse({ content: "成功内容", title: "B" });
        }
        // 直连也失败（确保第一次整体失败）
        throw new Error("direct failed");
      }),
    );
    await expect(fetchWebContent("https://b.com", 2000)).rejects.toThrow();
    const r2 = await fetchWebContent("https://b.com", 2000);
    expect(r2.content).toBe("成功内容");
  });
});

describe("search · fetchWebContent readability 正文提取", () => {
  it("有 rawHtml 时用 readability 提取干净正文（排除导航/页脚噪音）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.startsWith("/api/fetch")) {
          return jsonResponse({
            url: "https://news.example/a",
            content: "服务端提取的正文（含导航）",
            rawHtml:
              "<html><head><title>测试新闻</title></head><body>" +
              "<nav>导航菜单 链接一 链接二 链接三 链接四 链接五</nav>" +
              "<article><h1>测试新闻标题</h1>" +
              "<p>这是通过可读性提取出来的干净正文内容，包含足够长的文本以便被主内容识别算法正确判断为文章主体，并且应当排除页面上的导航链接、页脚版权声明以及无关侧边栏内容。</p>" +
              "<p>第二段补充信息，进一步增强文章正文长度，确保提取结果完整可靠。</p></article>" +
              "<footer>页脚版权信息 2026</footer>" +
              "</body></html>",
            title: "测试新闻",
            ogImage: "",
            images: [],
          });
        }
        return jsonResponse({});
      }),
    );
    const r = await fetchWebContent("https://news.example/a", 2000);
    expect(r.content).toContain("干净正文");
    // readability 应排除导航/页脚噪音
    expect(r.content).not.toContain("导航菜单");
    expect(r.content).not.toContain("页脚版权信息");
  });

  it("无 rawHtml（旧代理/纯文本）回退服务端 content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.startsWith("/api/fetch")) {
          return jsonResponse({
            url: "https://b.example/x",
            content: "服务端正文",
            title: "B",
          });
        }
        return jsonResponse({});
      }),
    );
    const r = await fetchWebContent("https://b.example/x", 2000);
    expect(r.content).toBe("服务端正文");
  });
});

describe("search · filterSensitiveResults（违规内容默默隐藏）", () => {
  const base = {
    url: "https://a.com",
    source: "a.com",
    engine: "tavily",
  };
  it("命中明确违规词的结果被过滤（正常结果保留）", () => {
    const r = filterSensitiveResults([
      { ...base, title: "正常新闻", description: "正常内容" },
      { ...base, title: "色情网站大全", description: "成人视频" },
      { ...base, title: "在线赌场", description: "博彩" },
      { ...base, title: "健康科普", description: "成人教育相关内容" },
    ]);
    expect(r.map((x) => x.title)).toEqual(["正常新闻", "健康科普"]);
  });
  it("全部违规 → 返回空（折叠卡不显示）", () => {
    const r = filterSensitiveResults([
      { ...base, title: "黄片", description: "色情" },
    ]);
    expect(r.length).toBe(0);
  });
  it("空数组/未违规 → 原样返回", () => {
    expect(filterSensitiveResults([])).toEqual([]);
    const ok = [{ ...base, title: "A", description: "正常" }];
    expect(filterSensitiveResults(ok)).toEqual(ok);
  });
});
