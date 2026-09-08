/**
 * 高级搜索智能代理（Advanced Search Agent）
 *
 * 搜索优化管线（基于搜索智能优化策略）：
 *   User Intent Analysis → Query Planning → Search Tool Calling →
 *   Result Evaluation → Result Filtering → Knowledge Extraction
 *
 * 核心原则：
 *   - 搜索不是简单调用 Search API，而是智能编排
 *   - 目标不是找到最多网页，而是找到最可信、最相关、最低噪音的信息
 *   - 优先信任官方来源（官网/文档/GitHub），自动过滤垃圾/SEO农场/AI 生成页面
 *   - 区分事实与推测，不引用低质量网页，不编造链接
 *
 * 与现有搜索基础设施的关系：作为上层编排层，复用现有 6 搜索引擎
 *  （backend/duckduckgo/wikipedia/brave/AI/Tavily），不替代、不破坏。
 */

import type { SearchResult, QueryType } from "./search";
import {
  detectQueryType,
  detectQueryLang,
  searchFast,
  searchFastWithAnswer,
  searchAI,
} from "./search";
import { hasSearchApi, loadSearchApiCfg } from "./searchApi";
import { rankAndConsolidate, searchSegmented } from "./searchPlanner";

// ======================== 类型定义 ========================

/** 搜索意图分类 */
export type SearchIntentCategory =
  | "technical" // 技术/编程/API/文档
  | "news" // 新闻/时事/最新动态
  | "product" // 产品/价格/购买
  | "anime" // 动漫/番剧/角色
  | "general"; // 通用/其他

/** 搜索意图分析结果 */
export interface SearchIntent {
  /** 意图分类 */
  category: SearchIntentCategory;
  /** 是否需要最新/实时数据 */
  needsLatest: boolean;
  /** 查询主要语言 */
  language: "zh" | "en" | "ja" | "ko";
  /** 提取的实体词（人名/产品名/技术名） */
  entities: string[];
  /** 原始查询类型（复用现有 detectQueryType） */
  queryType: QueryType;
}

/** 查询重写结果 */
export interface QueryRewrite {
  /** 优化后的主查询词（带领域后缀） */
  optimizedQuery: string;
  /** 备用查询词（不同角度/语言） */
  alternativeQuery: string;
  /** 搜索类型标记 */
  searchType:
    | "official"
    | "technical"
    | "news"
    | "product"
    | "anime"
    | "general";
}

/** 结构化搜索调用参数 */
export interface StructuredSearchParams {
  query: string;
  /** 为什么发起这次搜索 */
  reason: string;
  /** 期望获取什么信息 */
  expectedInfo: string;
  /** 搜索类型 */
  searchType: string;
  /** 最大结果数 */
  maxResults?: number;
}

/** 结构化搜索结果 */
export interface StructuredSearchResult {
  results: SearchResult[];
  /** 是否来自缓存 */
  cached: boolean;
  /** Tavily 官方 AI 直接答案（未配置 Tavily 时为空字符串） */
  answer?: string;
  /** 搜索元数据 */
  meta: {
    query: string;
    reason: string;
    expectedInfo: string;
    searchType: string;
    totalFound: number;
  };
}

/** 提取的事实项 */
export interface FactItem {
  /** 事实陈述 */
  fact: string;
  /** 来源 URL */
  source: string;
  /** 置信度 */
  confidence: "high" | "medium" | "low";
  /** 信息更新时间（若可提取） */
  updatedAt?: string;
}

/** 搜索代理编排结果 */
export interface SearchAgentResult {
  results: SearchResult[];
  facts: FactItem[];
  /** Tavily 官方 AI 直接答案（未配置 Tavily 时为空字符串） */
  answer?: string;
  meta: {
    intent: SearchIntent;
    queries: QueryRewrite;
    totalResults: number;
    phases: number;
  };
}

// ======================== 意图分析 ========================

/** 技术/编程意图检测正则 */
const TECHNICAL_RE =
  /api|接口|文档|documentation|代码|code|编程|programming|github|git|npm|pip|库|library|框架|framework|sdk|版本|version|release|更新日志|changelog|bug|issue|pr|pull.?request|commit|部署|deploy|配置|config|sdk|cli|命令|command|终端|terminal|编译器|compiler|运行时|runtime|新特性|更新|升级|教程|入门|指南|示例|用法|怎么用|如何使用|参考|reference|源码|source|原理|架构|architecture|性能|优化|optimize/i;

/** 产品/价格意图检测正则 */
const PRODUCT_RE =
  /多少钱|价格|pricing|购买|buy|购买|价格|售价|费用|cost|收费|免费|free|付费|paid|套餐|plan|订阅|subscribe|优惠|折扣|discount|测评|评测|review|开箱|对比|vs\.?|哪个好|推荐|排行/i;

/** 动漫/角色意图检测正则 */
const ANIME_CHAR_RE =
  /角色|character|人设|设定|配音|声优|cv|番剧|新番|动漫|动画|anime|漫画|manga|轻小说|小说|原作|监督|制作|staff|cast|周边|手办|figure|cos|cosplay/i;

/**
 * 分析用户搜索意图。
 * 复用现有 detectQueryType / detectQueryLang，扩展为更细粒度的意图分类。
 */
export function analyzeSearchIntent(
  userMsg: string,
  _context?: string,
): SearchIntent {
  const msg = (userMsg || "").trim();
  const queryType = detectQueryType(msg);
  const language = detectQueryLang(msg);

  // 意图分类优先级：产品(含价格词) > 技术 > 动漫 > 新闻 > 通用
  let category: SearchIntentCategory = "general";
  const isTech = TECHNICAL_RE.test(msg);
  const isProduct = PRODUCT_RE.test(msg);
  const isAnime = ANIME_CHAR_RE.test(msg) || queryType.anime;
  const isNews = queryType.news || queryType.fresh;

  // 产品意图优先：当同时命中技术和产品时，若含明确价格/购买词则优先产品
  const hasPriceWord =
    /多少钱|价格|pricing|费用|售价|cost|price|收费|付费|订阅|subscribe/i.test(
      msg,
    );
  if (isProduct && hasPriceWord) {
    category = "product";
  } else if (isTech) {
    category = "technical";
  } else if (isProduct) {
    category = "product";
  } else if (isAnime) {
    category = "anime";
  } else if (isNews) {
    category = "news";
  }

  // 实体提取：引号内文本 / 专有名词（首字母大写连续词） / 中文专名
  const entities: string[] = [];
  const quoted = msg.match(/[""「]([^""」]{2,30})[""」]/g);
  if (quoted) {
    for (const q of quoted) {
      entities.push(q.replace(/[""「」]/g, ""));
    }
  }
  // 英文：连续大写开头词（>=2 个）可能是专名
  const enProper = msg.match(
    /\b([A-Z][a-zA-Z0-9.]{1,20}(?:\s+[A-Z][a-zA-Z0-9.]{1,20}){0,3})\b/g,
  );
  if (enProper) {
    for (const ep of enProper) {
      const clean = ep.trim();
      if (clean.length >= 2 && !entities.includes(clean)) {
        entities.push(clean);
      }
    }
  }

  return {
    category,
    needsLatest: queryType.fresh,
    language,
    entities: entities.slice(0, 5),
    queryType,
  };
}

// ======================== 查询重写 ========================

/**
 * 按意图自动追加高价值后缀词，优化搜索命中率。
 *
 * 策略：
 *   technical → + official documentation github
 *   product   → + pricing official review
 *   news      → + latest 2026（当前年份）
 *   anime     → + 公式 サイト official wiki
 *   general   → + official
 */
export function rewriteQuery(
  intent: SearchIntent,
  query: string,
): QueryRewrite {
  const base = (query || "").trim();
  if (!base) {
    return {
      optimizedQuery: base,
      alternativeQuery: "",
      searchType: "general",
    };
  }

  const year = new Date().getFullYear();
  let optimizedQuery = base;
  let alternativeQuery = "";
  let searchType: QueryRewrite["searchType"] = "general";

  switch (intent.category) {
    case "technical":
      // 技术查询：追加 official + documentation + github
      if (!/official|官方/i.test(base)) optimizedQuery += " official";
      if (!/documentation|docs|文档/i.test(base))
        optimizedQuery += " documentation";
      if (!/github/i.test(base)) optimizedQuery += " github";
      alternativeQuery = intent.entities.length
        ? `${intent.entities[0]} API reference`
        : base.replace(/[^a-zA-Z\s]/g, " ") + " documentation";
      searchType = "technical";
      break;

    case "product":
      // 产品查询：追加 pricing + official
      if (!/pricing|价格|price/i.test(base)) optimizedQuery += " pricing";
      if (!/official|官方/i.test(base)) optimizedQuery += " official";
      alternativeQuery = `${base} review ${year}`;
      searchType = "product";
      break;

    case "news":
      // 新闻查询：追加 latest + 年份
      if (!/latest|最新|recent/i.test(base)) optimizedQuery += " latest";
      if (!base.includes(String(year))) optimizedQuery += ` ${year}`;
      alternativeQuery = base.replace(/[^\w\s]/g, " ") + " news today";
      searchType = "news";
      break;

    case "anime":
      // 动漫查询：追加公式/官方网站/wiki
      if (intent.language === "ja" || intent.language === "zh") {
        if (!/公式|official/i.test(base)) optimizedQuery += " 公式";
        if (!/サイト|site/i.test(base)) optimizedQuery += " サイト";
      }
      if (!/wiki/i.test(base)) optimizedQuery += " wiki";
      alternativeQuery = intent.entities.length
        ? `${intent.entities[0]} anime official`
        : base + " official";
      searchType = "anime";
      break;

    default:
      // 通用查询：追加 official
      if (!/official|官方/i.test(base) && base.length > 5) {
        optimizedQuery += " official";
      }
      alternativeQuery = base;
      searchType = "general";
      break;
  }

  return {
    optimizedQuery: optimizedQuery.replace(/\s{2,}/g, " ").trim(),
    alternativeQuery: alternativeQuery.replace(/\s{2,}/g, " ").trim(),
    searchType,
  };
}

// ======================== 结构化搜索 ========================

/** 是否配置 Tavily 直连（structuredSearch / phasedSearch 引擎自适应的依据） */
function hasTavily(): boolean {
  const cfg = loadSearchApiCfg();
  return hasSearchApi(cfg) && cfg.provider === "tavily";
}

/**
 * 结构化搜索调用：封装现有搜索函数，附加搜索元数据。
 *
 * 引擎自适应（准确率与速度并重）：
 *   - 配置 Tavily → searchFastWithAnswer 直连（快 ~1-2s + AI 直接答案）
 *   - 未配置 Tavily → searchSegmented 分段多引擎（子查询并发 + 纠错重试 + AI 兜底，稳健）
 * 空结果一律 searchAI 兜底，保证「搜索必有结果」。
 */
export async function structuredSearch(
  params: StructuredSearchParams,
): Promise<StructuredSearchResult> {
  const limit = params.maxResults || 6;
  let results: SearchResult[] = [];
  let answer = "";
  if (hasTavily()) {
    // Tavily：直连专属路径（advanced 深度 + AI 直接答案 answer），不与免费引擎混排稀释
    const r = await searchFastWithAnswer(params.query, limit);
    results = r.results;
    answer = r.answer;
  } else {
    // 未配置 Tavily：保留分段多引擎搜索的稳健性
    const seg = await searchSegmented(params.query, { limit });
    results = seg.results;
  }

  // 空结果 → AI 兜底（复用现有 searchAI，保证「搜索必有结果」）
  if (!results.length) {
    const ai = await searchAI(params.query, Math.min(limit, 6)).catch(() => []);
    if (ai.length) results = ai;
  }

  // 低质过滤 + 相关性排序合并（复用现有 rankAndConsolidate）
  const ranked = rankAndConsolidate(filterLowQuality(results), params.query, {
    limit,
  });

  return {
    results: ranked,
    cached: false,
    answer,
    meta: {
      query: params.query,
      reason: params.reason,
      expectedInfo: params.expectedInfo,
      searchType: params.searchType,
      totalFound: results.length,
    },
  };
}

// ======================== 结果质量过滤 ========================

/** 标题党特征正则 */
const CLICKBAIT_RE =
  /震惊|惊呆|竟然|居然|必看|不看后悔|绝了|炸裂|爆了|太牛|牛了|逆天|神了|万万没想到|你绝对|所有人|别再说|终于知道/i;

/** 已知低质/SEO 农场域名模式 */
const LOW_QUALITY_DOMAIN_PATTERNS = [
  /\.SEO/i,
  /spam/i,
  /content.?farm/i,
  /scraper/i,
];

/** AI 生成垃圾标题模式 */
const AI_GARBAGE_TITLE_RE =
  /^(最全|全网最|202\d年最|你必须知道的|什么是.{1,30}？一文读懂|一篇文章带你|干货\|精华\|收藏\|速览\|盘点\|一文看懂)/i;

/**
 * 关键词堆积检测：SEO 站把同一关键词在标题里反复堆叠（如 "AI AI AI 教程 教程"）。
 * 规则：同一词出现 ≥3 次，或单一词占标题词数 >60%（且标题 ≥4 词）。
 */
function isKeywordStuffed(title: string): boolean {
  const tokens = (title || "")
    .split(/[\s,，、;；|·\-—:：()（）]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length < 3) return false;
  const freq: Record<string, number> = {};
  for (const t of tokens) {
    const k = t.toLowerCase();
    freq[k] = (freq[k] || 0) + 1;
    if (freq[k] >= 3) return true;
  }
  const top = Math.max(...Object.values(freq));
  return tokens.length >= 4 && top / tokens.length > 0.6;
}

/**
 * 垃圾/低质量结果过滤。
 * 过滤规则：
 *   - 标题党（夸张/震惊体）
 *   - 已知低质域名
 *   - AI 生成垃圾标题模式
 *   - 无标题的结果
 *   - 纯广告/推广标题
 * 返回过滤后的结果数组。
 */
export function filterLowQuality(results: SearchResult[]): SearchResult[] {
  return results.filter((r) => {
    const title = (r.title || "").trim();

    // 无标题：直接过滤
    if (!title) return false;

    // 标题党检测
    if (CLICKBAIT_RE.test(title)) return false;

    // 关键词堆积检测（SEO 关键词堆叠）
    if (isKeywordStuffed(title)) return false;

    // AI 生成垃圾标题
    if (AI_GARBAGE_TITLE_RE.test(title)) return false;

    // 纯广告/推广
    if (
      /广告|推广|sponsored|ad\.|affiliate/i.test(title) &&
      title.length < 30
    ) {
      return false;
    }

    // 低质域名
    let host = "";
    try {
      host = new URL(r.url || "").hostname;
    } catch {
      /* ignore */
    }
    for (const pattern of LOW_QUALITY_DOMAIN_PATTERNS) {
      if (pattern.test(host)) return false;
    }

    // 标题全大写（英文垃圾特征）
    if (/^[A-Z\s\d]{20,}$/.test(title)) return false;

    // 夸张感叹号密度 >30%
    const exclamCount = (title.match(/!/g) || []).length;
    if (exclamCount > 0 && exclamCount / title.length > 0.3) return false;

    return true;
  });
}

// ======================== 来源权威性评分 ========================

/**
 * 来源权威性评分（附加分，叠加到现有相关性打分）。
 *
 * 高权威（+5）：政府/教育/官方文档/GitHub/包管理器
 * 中权威（+2）：技术社区/专业博客/知名媒体
 * 低权威（-3）：已知 SEO 农场/聚合站
 */
export function scoreAuthority(url: string): number {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return 0;
  }

  // 高权威域
  if (
    /\.gov$/.test(host) ||
    /\.edu$/.test(host) ||
    host === "github.com" ||
    host === "gitlab.com" ||
    host === "npmjs.com" ||
    host === "pypi.org" ||
    host === "crates.io" ||
    host === "docs.rs" ||
    /^developer\.(mozilla|apple|google|android)\./.test(host) ||
    host === "react.dev" ||
    host === "nodejs.org" ||
    host === "typescriptlang.org" ||
    host === "python.org" ||
    host === "rust-lang.org" ||
    host === "golang.org" ||
    host === "kubernetes.io" ||
    host === "docker.com" ||
    host === "arxiv.org" ||
    host === "doi.org" ||
    /wikipedia\.org$/.test(host) ||
    /wikimedia\.org$/.test(host)
  ) {
    return 5;
  }

  // 低权威域（必须在中权威之前检查——csdn.net 也会命中 /^blog\./）
  if (
    /csdn\.net$/.test(host) ||
    /jianshu\.com$/.test(host) ||
    /cnblogs\.com$/.test(host) ||
    /51cto\.com$/.test(host) ||
    /oschina\.net$/.test(host) ||
    /segmentfault\.com$/.test(host) ||
    /juejin\.cn$/.test(host) ||
    /infoq\.cn$/.test(host) ||
    /(?:baike|wiki|encyclopedia)\.(?!wikipedia|wikimedia)/.test(host)
  ) {
    return -3;
  }

  // 中权威域
  if (
    host === "stackoverflow.com" ||
    host === "serverfault.com" ||
    host === "superuser.com" ||
    host === "askubuntu.com" ||
    /^.*\.stackexchange\.com$/.test(host) ||
    host === "reddit.com" ||
    host === "news.ycombinator.com" ||
    host === "medium.com" ||
    host === "dev.to" ||
    host === "hashnode.dev" ||
    host === "freecodecamp.org" ||
    /^blog\./.test(host) ||
    /\.blogspot\./.test(host) ||
    host === "techcrunch.com" ||
    host === "theverge.com" ||
    host === "arstechnica.com" ||
    host === "wired.com" ||
    host === "reuters.com" ||
    host === "bbc.com" ||
    host === "bbc.co.uk" ||
    host === "nature.com" ||
    host === "science.org" ||
    host === "ieee.org" ||
    host === "acm.org"
  ) {
    return 2;
  }

  return 0;
}

// ======================== 事实提取 ========================

/**
 * 从搜索结果与抓取正文中提取关键事实。
 *
 * 每条事实含：
 *   - fact: 事实陈述
 *   - source: 来源 URL
 *   - confidence: 置信度（official来源=high、社区=medium、其他=low）
 *   - updatedAt: 信息更新时间（若可提取）
 */
export function extractFacts(
  results: SearchResult[],
  _content?: string,
): FactItem[] {
  const facts: FactItem[] = [];

  for (const r of results) {
    // 从描述中提取有意义的句子
    const desc = (r.description || "").trim();
    if (!desc || desc.length < 15) continue;

    // 按句号/分号切分
    const sentences = desc
      .split(/[.。;；!！?？\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 15 && s.length <= 200);

    for (const sentence of sentences.slice(0, 2)) {
      const authorityScore = scoreAuthority(r.url);
      let confidence: FactItem["confidence"] = "low";
      if (authorityScore >= 5) confidence = "high";
      else if (authorityScore >= 2) confidence = "medium";

      facts.push({
        fact: sentence,
        source: r.url,
        confidence,
      });
    }
  }

  // 去重（Dice bigram ≥0.8 视为重复事实）
  const unique: FactItem[] = [];
  const seenBigrams: string[] = [];
  for (const f of facts) {
    const normF = f.fact.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    if (!normF) continue;

    // 简易 bigram 重叠检测
    let isDup = false;
    for (const seen of seenBigrams) {
      let overlap = 0;
      const minLen = Math.min(normF.length, seen.length);
      for (let i = 0; i + 1 < minLen; i++) {
        if (normF.slice(i, i + 2) === seen.slice(i, i + 2)) overlap++;
      }
      const score = (2 * overlap) / (normF.length + seen.length - 2);
      if (score >= 0.8) {
        isDup = true;
        break;
      }
    }
    if (isDup) continue;

    seenBigrams.push(normF);
    unique.push(f);
  }

  return unique.slice(0, 10);
}

// ======================== 多阶段搜索策略 ========================

/**
 * 三阶段搜索（仅 Deep 模式 / 复杂查询启用）。
 *
 * Phase A - Broad（广度）：用优化查询广泛搜索，快速了解领域
 * Phase B - Precision（精准）：用精确关键词 + site: 限制缩小范围
 * Phase C - Verification（验证）：用备用查询交叉验证关键事实
 */
export async function phasedSearch(
  intent: SearchIntent,
  originalQuery: string,
  mode: "auto" | "deep",
): Promise<SearchResult[]> {
  const { optimizedQuery, alternativeQuery } = rewriteQuery(
    intent,
    originalQuery,
  );

  const useTavily = hasTavily();

  // Phase A: 广度搜索（Tavily → 直连快路径；否则分段多引擎稳健搜索）
  const broadResults = useTavily
    ? await searchFast(optimizedQuery, 8)
    : (await searchSegmented(optimizedQuery, { limit: 8 })).results;

  // Auto 模式：只用 Phase A
  if (mode === "auto") {
    const filtered = filterLowQuality(broadResults);
    return rankAndConsolidate(filtered, originalQuery, { limit: 6 });
  }

  // 未配置 Tavily：免费引擎稳健性优先，只做 Phase A（三阶段对慢速免费引擎价值低且拖慢），
  // 质量提升由「查询改写 + 低质过滤 + 权威排序」承担
  if (!useTavily) {
    return rankAndConsolidate(filterLowQuality(broadResults), originalQuery, {
      limit: 10,
    });
  }

  // Phase B: 精准搜索（仅 Deep 模式）
  let precisionResults: SearchResult[] = [];
  if (intent.category === "technical" && intent.entities.length > 0) {
    // 技术查询：用 site:github.com 限制来源
    const siteQuery = `${intent.entities[0]} site:github.com`;
    precisionResults = await searchFast(siteQuery, 5);
  } else if (intent.category === "news") {
    // 新闻查询：带年份精准搜索
    const year = new Date().getFullYear();
    precisionResults = await searchFast(`${originalQuery} ${year}`, 5);
  } else {
    // 通用精准搜索
    precisionResults = await searchFast(optimizedQuery, 5);
  }

  // Phase C: 验证搜索
  let verificationResults: SearchResult[] = [];
  if (alternativeQuery && alternativeQuery !== optimizedQuery) {
    verificationResults = await searchFast(alternativeQuery, 4);
  }

  // 合并、去重、排序
  const allResults = [
    ...broadResults,
    ...precisionResults,
    ...verificationResults,
  ];

  // URL 去重
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of allResults) {
    const key = (r.url || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  const filtered = filterLowQuality(deduped);
  return rankAndConsolidate(filtered, originalQuery, { limit: 10 });
}

// ======================== 主编排函数 ========================

/**
 * 搜索代理主编排：一站式搜索智能编排。
 *
 * 输入用户消息和对话上下文，输出结构化搜索结果 + 提取的事实。
 *
 * 管线：
 *   1. analyzeSearchIntent  →  分析意图
 *   2. rewriteQuery         →  优化查询词
 *   3. 根据模式选择策略：
 *      - Auto: structuredSearch (Phase A only)
 *      - Deep: phasedSearch (三阶段)
 *   4. extractFacts         →  提取关键事实
 *   5. 返回 SearchAgentResult
 */
export async function runSearchAgent(
  userMsg: string,
  context?: string,
  mode: "auto" | "deep" = "auto",
): Promise<SearchAgentResult> {
  // Step 1: 意图分析
  const intent = analyzeSearchIntent(userMsg, context);

  // Step 2: 查询重写
  const queries = rewriteQuery(intent, userMsg);

  // Step 3: 搜索
  let results: SearchResult[];
  let answer = "";
  if (mode === "deep") {
    results = await phasedSearch(intent, userMsg, "deep");
  } else {
    const sr = await structuredSearch({
      query: queries.optimizedQuery,
      reason: `用户查询：「${userMsg.slice(0, 80)}」→ 意图：${intent.category}`,
      expectedInfo:
        intent.category === "technical"
          ? "技术文档/官方 API/代码示例"
          : intent.category === "product"
            ? "产品规格/价格/用户评价"
            : intent.category === "news"
              ? "最新动态/时效性信息"
              : "相关信息与权威来源",
      searchType: queries.searchType,
      maxResults: 6,
    });
    results = sr.results;
    answer = sr.answer ?? "";
  }

  // Step 4: 事实提取
  const facts = extractFacts(results);

  return {
    results,
    facts,
    answer,
    meta: {
      intent,
      queries,
      totalResults: results.length,
      phases: mode === "deep" ? 3 : 1,
    },
  };
}

// ======================== 格式化输出（注入 AI system prompt） ========================

/**
 * 将搜索结果和事实格式化为 AI system prompt 可用的文本段。
 * 包含来源权威性标注和置信度信息，帮助 AI 区分事实与推测。
 */
export function formatSearchContext(result: SearchAgentResult): string {
  const lines: string[] = [];

  if (result.results.length === 0) {
    return "（本次搜索未找到相关结果，请基于既有知识诚实回答，不确定请说明。）";
  }

  lines.push(
    `搜索返回 ${result.results.length} 条结果（意图：${result.meta.intent.category}）：\n`,
  );

  // 搜索结果
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const authScore = scoreAuthority(r.url);
    const authLabel =
      authScore >= 5 ? "🔴权威" : authScore >= 2 ? "🔵可信" : "⚪一般";
    lines.push(
      `${i + 1}. [${authLabel}] **${r.title}**\n   来源：${r.source} | ${r.url}\n   摘要：${(r.description || "").slice(0, 200)}`,
    );
  }

  // 关键事实
  if (result.facts.length > 0) {
    lines.push(`\n关键事实（共 ${result.facts.length} 条，置信度标注）：`);
    for (const f of result.facts.slice(0, 5)) {
      const confLabel =
        f.confidence === "high"
          ? "🟢高"
          : f.confidence === "medium"
            ? "🟡中"
            : "⚪低";
      lines.push(
        `- [${confLabel}] ${f.fact.slice(0, 150)}（来源：${f.source}）`,
      );
    }
  }

  lines.push(
    `\n提示：优先引用标记"权威"和"可信"的来源。若信息不足或相互矛盾请如实说明。不确定的数据请标注"资料有限，未能核实"。禁止编造链接或数据。`,
  );

  return lines.join("\n");
}
