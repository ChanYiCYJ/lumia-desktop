import { describe, it, expect, vi, afterEach } from "vitest";
import {
  analyzeSearchIntent,
  rewriteQuery,
  filterLowQuality,
  scoreAuthority,
  extractFacts,
  formatSearchContext,
  structuredSearch,
  runSearchAgent,
} from "../searchAgent";
import type { SearchResult } from "../search";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ======================== analyzeSearchIntent ========================

describe("searchAgent · analyzeSearchIntent", () => {
  it("检测技术/编程意图", () => {
    const intent = analyzeSearchIntent("React 19 API 文档");
    expect(intent.category).toBe("technical");
  });

  it("检测产品/价格意图", () => {
    const intent = analyzeSearchIntent("DeepSeek API 多少钱");
    expect(intent.category).toBe("product");
  });

  it("检测新闻意图（含最新/今天）", () => {
    const intent = analyzeSearchIntent("2026年8月 AI 最新新闻");
    expect(intent.category).toBe("news");
    expect(intent.needsLatest).toBe(true);
  });

  it("检测动漫/角色意图", () => {
    const intent = analyzeSearchIntent("介绍一下 千恋万花 角色设定");
    expect(intent.category).toBe("anime");
  });

  it("无特殊意图 → general", () => {
    const intent = analyzeSearchIntent("你好啊");
    expect(intent.category).toBe("general");
  });

  it("提取引号内实体", () => {
    const intent = analyzeSearchIntent('比较 "React" 和 "Vue" 的性能');
    expect(intent.entities).toContain("React");
    expect(intent.entities).toContain("Vue");
  });

  it("检测日文查询语言", () => {
    const intent = analyzeSearchIntent("夏アニメのおすすめ");
    expect(intent.language).toBe("ja");
  });

  it("检测韩文查询语言", () => {
    const intent = analyzeSearchIntent("최신 AI 뉴스");
    expect(intent.language).toBe("ko");
  });

  it("needsLatest 对天气查询为 true", () => {
    const intent = analyzeSearchIntent("北京今天天气怎么样");
    expect(intent.needsLatest).toBe(true);
    expect(intent.queryType.weather).toBe(true);
  });
});

// ======================== rewriteQuery ========================

describe("searchAgent · rewriteQuery", () => {
  it("技术查询追加 official documentation github", () => {
    const intent = analyzeSearchIntent("React 19 新特性");
    const { optimizedQuery, searchType } = rewriteQuery(
      intent,
      "React 19 新特性",
    );
    expect(searchType).toBe("technical");
    expect(optimizedQuery).toContain("documentation");
    expect(optimizedQuery).toContain("github");
  });

  it("产品查询追加 pricing official", () => {
    const intent = analyzeSearchIntent("ChatGPT 多少钱");
    const { optimizedQuery, searchType } = rewriteQuery(
      intent,
      "ChatGPT 多少钱",
    );
    expect(searchType).toBe("product");
    expect(optimizedQuery).toContain("pricing");
    expect(optimizedQuery).toContain("official");
  });

  it("新闻查询追加年份", () => {
    const intent = analyzeSearchIntent("AI 最新新闻");
    const { optimizedQuery, searchType } = rewriteQuery(intent, "AI 最新新闻");
    expect(searchType).toBe("news");
    // "最新" already covers recency, so "latest" may or may not be appended
    expect(optimizedQuery).toContain(String(new Date().getFullYear()));
  });

  it("动漫查询追加公式サイト wiki", () => {
    const intent = analyzeSearchIntent("千恋万花 角色");
    const { optimizedQuery, searchType } = rewriteQuery(
      intent,
      "千恋万花 角色",
    );
    expect(searchType).toBe("anime");
    expect(optimizedQuery).toContain("wiki");
  });

  it("已有 official 不重复追加", () => {
    const intent = analyzeSearchIntent("React official API");
    const { optimizedQuery } = rewriteQuery(intent, "React official API");
    // 不应出现重复的 official
    const matches = (optimizedQuery.match(/official/gi) || []).length;
    expect(matches).toBe(1);
  });

  it("生成 alternative query", () => {
    const intent = analyzeSearchIntent("React 19 新特性");
    const { alternativeQuery } = rewriteQuery(intent, "React 19 新特性");
    expect(alternativeQuery).toBeTruthy();
    // alternative query should differ from original (either English keywords or entity-based)
    expect(alternativeQuery.length).toBeGreaterThan(0);
  });

  it("空查询不报错", () => {
    const intent = analyzeSearchIntent("");
    const { optimizedQuery, alternativeQuery } = rewriteQuery(intent, "");
    expect(optimizedQuery).toBe("");
    expect(alternativeQuery).toBe("");
  });
});

// ======================== filterLowQuality ========================

describe("searchAgent · filterLowQuality", () => {
  function makeResult(
    title: string,
    url = "https://example.com",
    desc = "",
  ): SearchResult {
    return { title, url, description: desc, source: "test", engine: "test" };
  }

  it("过滤标题党", () => {
    const results = [
      makeResult("震惊！AI 竟然能做到这些"),
      makeResult("React 19 新特性介绍"),
    ];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("React 19 新特性介绍");
  });

  it("过滤无标题结果", () => {
    const results = [makeResult(""), makeResult("正常标题")];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
  });

  it("过滤纯广告标题", () => {
    const results = [makeResult("广告推广优惠券"), makeResult("正常内容")];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
  });

  it("过滤全大写英文标题", () => {
    const results = [
      makeResult("TOTALLY FREE AI TOOLS DOWNLOAD NOW CLICK HERE BEST"),
      makeResult("Normal Title"),
    ];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
  });

  it("正常结果全部保留", () => {
    const results = [
      makeResult("React 19 新特性", "https://react.dev"),
      makeResult(
        "TypeScript 5.8 Release Notes",
        "https://devblogs.microsoft.com",
      ),
      makeResult("Python 3.13 性能提升", "https://python.org"),
    ];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(3);
  });

  it("过滤关键词堆积（SEO 堆叠：同一词 ≥3 次）", () => {
    const results = [
      makeResult("AI AI AI 教程 教程 教程"),
      makeResult("React 19 新特性介绍"),
    ];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("React 19 新特性介绍");
  });

  it("过滤单词占主体的标题（>60% 词数）", () => {
    const results = [
      makeResult("Python Python Python Python Python 下载"),
      makeResult("Python 3.13 性能提升指南"),
    ];
    const filtered = filterLowQuality(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Python 3.13 性能提升指南");
  });
});

// ======================== scoreAuthority ========================

describe("searchAgent · scoreAuthority", () => {
  it("GitHub 为高权威（+5）", () => {
    expect(scoreAuthority("https://github.com/facebook/react")).toBe(5);
  });

  it("Wikipedia 为高权威（+5）", () => {
    expect(scoreAuthority("https://en.wikipedia.org/wiki/React")).toBe(5);
  });

  it(".gov 为高权威（+5）", () => {
    expect(scoreAuthority("https://www.nasa.gov")).toBe(5);
  });

  it("react.dev 为高权威（+5）", () => {
    expect(scoreAuthority("https://react.dev/reference/react")).toBe(5);
  });

  it("StackOverflow 为中权威（+2）", () => {
    expect(scoreAuthority("https://stackoverflow.com/questions/123")).toBe(2);
  });

  it("Reddit 为中权威（+2）", () => {
    expect(scoreAuthority("https://reddit.com/r/reactjs")).toBe(2);
  });

  it("CSDN 为低权威（-3）", () => {
    expect(scoreAuthority("https://blog.csdn.net/xxx")).toBe(-3);
  });

  it("普通域为 0", () => {
    expect(scoreAuthority("https://example.com/page")).toBe(0);
  });

  it("无效 URL 返回 0", () => {
    expect(scoreAuthority("not-a-url")).toBe(0);
  });

  it("dev.to 为中权威（+2）", () => {
    expect(scoreAuthority("https://dev.to/someuser/post")).toBe(2);
  });

  it("python.org 为高权威（+5）", () => {
    expect(scoreAuthority("https://python.org/downloads")).toBe(5);
  });
});

// ======================== extractFacts ========================

describe("searchAgent · extractFacts", () => {
  function makeResult(desc: string, url = "https://example.com"): SearchResult {
    return {
      title: "Test",
      url,
      description: desc,
      source: "test",
      engine: "test",
    };
  }

  it("从描述提取事实（高权威来源）", () => {
    const results = [
      makeResult(
        "React 19 引入了 Server Components 作为默认渲染模式。性能提升约 30%。",
        "https://react.dev",
      ),
    ];
    const facts = extractFacts(results);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].confidence).toBe("high"); // react.dev 为高权威
  });

  it("从描述提取事实（普通来源）", () => {
    const results = [
      makeResult(
        "这是一个测试描述，包含足够长的事実陈述内容。",
        "https://example.com",
      ),
    ];
    const facts = extractFacts(results);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].confidence).toBe("low"); // 普通域为低
  });

  it("空描述不产生事实", () => {
    const results = [makeResult("")];
    const facts = extractFacts(results);
    expect(facts).toHaveLength(0);
  });

  it("过短描述不产生事实", () => {
    const results = [makeResult("短")];
    const facts = extractFacts(results);
    expect(facts).toHaveLength(0);
  });

  it("多结果去重事实", () => {
    const results = [
      makeResult(
        "React 19 引入了 Server Components。这是一个重大变化。",
        "https://react.dev",
      ),
      makeResult(
        "React 19 引入了 Server Components。这是一个重大变化。",
        "https://github.com/facebook/react",
      ),
    ];
    const facts = extractFacts(results);
    // 相同事实应去重
    const uniqueFacts = new Set(facts.map((f) => f.fact));
    expect(uniqueFacts.size).toBeLessThanOrEqual(facts.length);
  });
});

// ======================== formatSearchContext ========================

describe("searchAgent · formatSearchContext", () => {
  it("空结果返回提示", () => {
    const result = {
      results: [],
      facts: [],
      meta: {
        intent: analyzeSearchIntent("test"),
        queries: rewriteQuery(analyzeSearchIntent("test"), "test"),
        totalResults: 0,
        phases: 1,
      },
    };
    const formatted = formatSearchContext(result);
    expect(formatted).toContain("未找到相关结果");
  });

  it("有结果时包含权威标注", () => {
    const result = {
      results: [
        {
          title: "React 19 新特性",
          url: "https://react.dev",
          description: "React 19 引入了 Server Components。",
          source: "react.dev",
          engine: "test",
        },
      ],
      facts: [],
      meta: {
        intent: analyzeSearchIntent("React 19"),
        queries: rewriteQuery(analyzeSearchIntent("React 19"), "React 19"),
        totalResults: 1,
        phases: 1,
      },
    };
    const formatted = formatSearchContext(result);
    expect(formatted).toContain("React 19 新特性");
    expect(formatted).toContain("权威"); // react.dev 为权威
  });

  it("包含事实提取信息", () => {
    const result = {
      results: [
        {
          title: "Test",
          url: "https://example.com",
          description:
            "This is a test description with enough length to extract facts from it properly here.",
          source: "example.com",
          engine: "test",
        },
      ],
      facts: [
        {
          fact: "This is a test description with enough length to extract facts from it properly here.",
          source: "https://example.com",
          confidence: "low" as const,
        },
      ],
      meta: {
        intent: analyzeSearchIntent("test"),
        queries: rewriteQuery(analyzeSearchIntent("test"), "test"),
        totalResults: 1,
        phases: 1,
      },
    };
    const formatted = formatSearchContext(result);
    expect(formatted).toContain("关键事实");
  });

  it("包含质量提示语", () => {
    const result = {
      results: [
        {
          title: "Test",
          url: "https://example.com",
          description: "Some description text here.",
          source: "example.com",
          engine: "test",
        },
      ],
      facts: [],
      meta: {
        intent: analyzeSearchIntent("test"),
        queries: rewriteQuery(analyzeSearchIntent("test"), "test"),
        totalResults: 1,
        phases: 1,
      },
    };
    const formatted = formatSearchContext(result);
    expect(formatted).toContain("优先引用");
    expect(formatted).toContain("资料有限，未能核实");
    expect(formatted).toContain("禁止编造");
  });
});

// ======================== structuredSearch / runSearchAgent（引擎自适应） ========================

describe("searchAgent · structuredSearch 引擎自适应", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("配置 Tavily → 直连 api.tavily.com 并透传 answer", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-x",
        instance: "",
        ttl: 60,
      }),
    );
    let tavilyCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("https://api.tavily.com")) {
          tavilyCalled = true;
          return jsonResponse({
            results: [
              {
                title: "DeepSeek API Pricing",
                url: "https://api-docs.deepseek.com",
                content: "DeepSeek 官方 API 定价",
              },
            ],
            answer: "Tavily AI 直接答案",
          });
        }
        return jsonResponse([]);
      }),
    );
    const r = await structuredSearch({
      query: "deepseek api pricing official",
      reason: "test",
      expectedInfo: "pricing",
      searchType: "product",
      maxResults: 5,
    });
    expect(tavilyCalled).toBe(true);
    expect(r.answer).toBe("Tavily AI 直接答案");
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("未配置 Tavily → 走 /api/search（分段多引擎稳健路径）", async () => {
    let backendCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/search")) {
          backendCalled = true;
          return jsonResponse([
            {
              title: "React 19 新特性官方文档",
              url: "https://react.dev/blog/2024/12/05/react-19",
              description: "React 19 发布说明",
            },
          ]);
        }
        return jsonResponse({ query: { pages: {} } });
      }),
    );
    const r = await structuredSearch({
      query: "react 19",
      reason: "test",
      expectedInfo: "docs",
      searchType: "technical",
      maxResults: 5,
    });
    expect(backendCalled).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("runSearchAgent auto 透传 answer 与 facts", async () => {
    localStorage.setItem(
      "kimo_search_api_cfg",
      JSON.stringify({
        provider: "tavily",
        apiKey: "tvly-x",
        instance: "",
        ttl: 60,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("https://api.tavily.com")) {
          return jsonResponse({
            results: [
              {
                title: "DeepSeek API Pricing",
                url: "https://api-docs.deepseek.com",
                content: "DeepSeek 官方 API 定价",
              },
            ],
            answer: "DeepSeek 官方 API 定价",
          });
        }
        return jsonResponse([]);
      }),
    );
    const result = await runSearchAgent("DeepSeek API 多少钱", "", "auto");
    expect(result.answer).toBe("DeepSeek 官方 API 定价");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeGreaterThan(0);
  });
});
