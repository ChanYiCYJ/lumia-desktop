/**
 * 搜索 API 平台配置（自由接入第三方搜索 API）
 * ------------------------------------------------------------------
 * 用户可在设置中自由选择搜索平台并填写自己的 API Key（如 Tavily / Brave Search / SearXNG），
 * 配置存 localStorage（同「自定义模型」模式），搜索时随请求传给 Worker `/api/search` 代理执行（免 CORS）。
 *
 * - 纯函数 + 可注入 fetch，便于 vitest 单测
 * - 被网络拦截/失败时一律优雅降级：不硬刚，走免费引擎（Wikipedia / Google News RSS / AI 兜底）
 */

export type SearchApiProvider = "auto" | "tavily" | "brave" | "searxng";

/** 缓存时效（分钟）：15 分钟 / 1 小时 / 6 小时 */
export type SearchApiTtl = 15 | 60 | 360;

export interface SearchApiCfg {
  /** 平台：auto=不配置，用免费引擎 */
  provider: SearchApiProvider;
  /** API Key（tavily/brave 必填） */
  apiKey: string;
  /** SearXNG 实例地址（provider=searxng 时必填，如 https://searx.be） */
  instance: string;
  /** 搜索/文章缓存时效（分钟），保证数据实时更新 */
  ttl: SearchApiTtl;
}

export interface SearchApiTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  provider?: SearchApiProvider;
}

const KEY = "kimo_search_api_cfg";
const VALID_TTL: SearchApiTtl[] = [15, 60, 360];
const VALID_PROVIDERS: SearchApiProvider[] = [
  "auto",
  "tavily",
  "brave",
  "searxng",
];

/** 平台元信息（供设置 UI 展示） */
export const SEARCH_API_PROVIDERS: {
  value: SearchApiProvider;
  label: string;
  desc: string;
  needKey: boolean;
  needInstance: boolean;
}[] = [
  {
    value: "auto",
    label: "Auto",
    desc: "默认免费引擎",
    needKey: false,
    needInstance: false,
  },
  {
    value: "tavily",
    label: "Tavily",
    desc: "免费 1000 次/月，支持当天新闻",
    needKey: true,
    needInstance: false,
  },
  {
    value: "brave",
    label: "Brave",
    desc: "免费 2000 次/月，隐私搜索",
    needKey: true,
    needInstance: false,
  },
  {
    value: "searxng",
    label: "SearXNG",
    desc: "开源元搜索，填实例地址",
    needKey: false,
    needInstance: true,
  },
];

// ---- localStorage 读写 ----

export function loadSearchApiCfg(): SearchApiCfg {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || "null");
    if (r && typeof r === "object") {
      return {
        provider: VALID_PROVIDERS.includes(r.provider) ? r.provider : "auto",
        apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
        instance: typeof r.instance === "string" ? r.instance : "",
        ttl: VALID_TTL.includes(r.ttl) ? r.ttl : 60,
      };
    }
  } catch {
    /* 忽略 */
  }
  return { provider: "auto", apiKey: "", instance: "", ttl: 60 };
}

export function saveSearchApiCfg(cfg: SearchApiCfg): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 忽略 */
  }
}

export function clearSearchApiCfg(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

/** 是否已配置可用的搜索 API（tavily/brave 需 key，searxng 需实例地址） */
export function hasSearchApi(cfg: SearchApiCfg | null | undefined): boolean {
  if (!cfg) return false;
  if (cfg.provider === "tavily") return !!cfg.apiKey?.trim();
  if (cfg.provider === "searxng")
    return /^https?:\/\//i.test(cfg.instance?.trim() || "");
  return false;
}

/** 缓存时效（毫秒）：默认 1 小时（保证能获取当天信息） */
export function cacheTtlMs(cfg?: SearchApiCfg | null): number {
  const ttl = cfg && VALID_TTL.includes(cfg.ttl) ? cfg.ttl : 60;
  return ttl * 60 * 1000;
}

/** 当天日期（YYYY-MM-DD），供提示词注入与文章时效标注 */
export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 时敏查询检测：含 今天/最新/新闻/发布 等词 → 需要当天/近期数据（触发 news 主题 + 短时窗） */
const FRESH_RE =
  /今天|今日|最新|新闻|突发|实时|刚刚|昨天|昨日|新作|上市|发布|发售|更新|近期|today|now|recent|latest|news|break/i;
export function isFreshQuery(q: string): boolean {
  return FRESH_RE.test(q || "");
}

// ---- 连接测试 ----

function describeError(status: number, detail: string): string {
  if (status === 401 || status === 403)
    return "认证失败：API Key 无效或没有权限（401/403）";
  if (status === 429) return "请求过于频繁或额度不足（429），请稍后再试";
  if (status >= 500) return `服务端错误（${status}），请稍后再试`;
  return `请求失败（${status}）${detail ? `：${detail}` : ""}`;
}

/** 直连第三方 API 校验 Key（若被 CORS/网络拦截返回 null，交由代理路径兜底） */
async function testDirect(
  cfg: SearchApiCfg,
  fetchImpl: typeof fetch,
): Promise<SearchApiTestResult | null> {
  const start = Date.now();
  try {
    let res: Response;
    if (cfg.provider === "tavily") {
      res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey.trim()}`,
        },
        body: JSON.stringify({
          query: "ping",
          max_results: 1,
          search_depth: "basic",
        }),
      });
    } else if (cfg.provider === "searxng") {
      res = await fetchImpl(
        `${cfg.instance.trim().replace(/\/+$/, "")}/search?q=ping&format=json`,
        { headers: { Accept: "application/json" } },
      );
    } else {
      return null;
    }
    const latencyMs = Date.now() - start;
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as {
        results?: unknown[];
        web?: { results?: unknown[] };
      } | null;
      const has =
        (Array.isArray(j?.results) && j!.results!.length > 0) ||
        (Array.isArray(j?.web?.results) && j!.web!.results!.length > 0);
      return {
        ok: has,
        message: has ? "连接成功" : "连接成功但未返回结果（可正常使用）",
        latencyMs,
        provider: cfg.provider,
      };
    }
    const detail = (await res.text().catch(() => "")).slice(0, 150);
    return {
      ok: false,
      message: describeError(res.status, detail),
      latencyMs,
      provider: cfg.provider,
    };
  } catch {
    // 浏览器直连被 CORS/网络拦截 → 交给 Worker 代理再试一次（不硬刚）
    return null;
  }
}

/** 经同源 Worker /api/search 代理测试（生产环境免 CORS，与真实搜索同一路径） */
async function testViaProxy(
  cfg: SearchApiCfg,
  fetchImpl: typeof fetch,
): Promise<SearchApiTestResult> {
  const params = new URLSearchParams({ q: "ping", limit: "1" });
  params.set("provider", cfg.provider);
  if (cfg.provider === "tavily") params.set("apiKey", cfg.apiKey.trim());
  if (cfg.provider === "searxng") params.set("instance", cfg.instance.trim());
  const start = Date.now();
  try {
    const res = await fetchImpl(`/api/search?${params.toString()}`);
    const latencyMs = Date.now() - start;
    if (res.ok) {
      const j = (await res.json().catch(() => [])) as unknown[];
      const ok = Array.isArray(j) && j.length > 0;
      return {
        ok,
        message: ok
          ? "连接成功（经代理）"
          : "代理未返回结果，请检查配置（Key/实例地址）",
        latencyMs,
        provider: cfg.provider,
      };
    }
    return {
      ok: false,
      message: `代理请求失败（${res.status}），请稍后再试`,
      latencyMs,
      provider: cfg.provider,
    };
  } catch (e) {
    return {
      ok: false,
      message: `网络错误：${
        e instanceof Error ? e.message : String(e)
      }（实际搜索走代理不受影响，请确认 Worker 已部署）`,
      provider: cfg.provider,
    };
  }
}

/**
 * 测试搜索 API 配置连通性。
 * 先直连第三方 API（Key 校验最准确）；被 CORS/网络拦截时走同源 Worker 代理再试（与真实搜索同路径）。
 */
export async function testSearchApi(
  cfg: SearchApiCfg,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchApiTestResult> {
  if (cfg.provider === "auto")
    return {
      ok: false,
      message: "请先选择一个搜索平台（Tavily/Brave/SearXNG）",
    };
  if (cfg.provider === "tavily") {
    if (!cfg.apiKey?.trim()) return { ok: false, message: "请先填写 API Key" };
  }
  if (cfg.provider === "searxng") {
    if (!/^https?:\/\//i.test(cfg.instance?.trim() || ""))
      return {
        ok: false,
        message: "请先填写 SearXNG 实例地址（如 https://searx.be）",
      };
  }
  const direct = await testDirect(cfg, fetchImpl);
  if (direct) return direct;
  return testViaProxy(cfg, fetchImpl);
}
