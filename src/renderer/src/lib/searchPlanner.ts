/**
 * 分段多线程搜索编排模块
 *
 * 功能：
 *   - 查询分段（拆分为多个子查询并发搜索）
 *   - 多语言关键词增强
 *   - 无结果自动纠错
 *   - 结果合并去重/多样化/相关性过滤
 *   - 搜索定式缓存（学习最优引擎组合）
 */

import {
  searchBackend,
  searchAI,
  searchFast,
  detectQueryLang,
  detectQueryType,
} from "./search";
import type { SearchResult, QueryType } from "./search";

// ====== 内部工具 ======

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function diversifyByDomain(
  results: SearchResult[],
  max: number,
  perDomain = 2,
): SearchResult[] {
  const hostCount: Record<string, number> = {};
  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= max) break;
    let host = r.source || "";
    try {
      host = new URL(r.url).hostname.replace(/^www\./i, "");
    } catch {
      /* ignore */
    }
    const cap =
      host.includes("bilibili.com") || host.includes("bgm.tv") ? 4 : perDomain;
    if ((hostCount[host] || 0) >= cap) continue;
    hostCount[host] = (hostCount[host] || 0) + 1;
    out.push(r);
  }
  return out;
}

// ====== 查询分段 ======

const SPLIT_RE =
  /(?:和|与|以及|还有|还有啥|另外|此外|同时|顺便|对比|比较|区别|vs\.?|VS|，|；|;)/;

/** 季节/列表通用词 */
const SEASON_RE =
  /新番|当季|本季|番表|在播|新作|夏季|冬季|春季|秋季|夏アニメ|冬アニメ|春アニメ|秋アニメ|夏番|冬番|春番|秋番|一覧|推荐|おすすめ|202\d|anime|season|list|lineup/gi;

/** 去除查询中所有季节/列表通用词和日期噪声 */
function stripSeason(query: string): string {
  return query
    .replace(SEASON_RE, "")
    .replace(/[年月度、，。:：（）()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 规则式查询分段。fast 最多 2 段，standard 最多 4 段。
 */
export function splitSubQueries(
  query: string,
  _lang: string,
  type: QueryType,
  speed: "fast" | "standard",
): string[] {
  const q = (query || "").trim();
  if (!q) return [];

  const maxSubs = speed === "fast" ? 2 : 4;
  const parts = q
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, maxSubs);

  // anime：分离主标题和季节后缀
  if (type.anime) {
    const main = stripSeason(q);
    if (main && main !== q) return [main, q].slice(0, maxSubs);
  }
  return [q];
}

// ====== 多语言关键词增强 ======

/**
 * 为查询生成多语言混合关键词（保留原语言 + 英文，动漫附日文）。
 */
export function enrichKeywords(
  query: string,
  lang: string,
  type: QueryType,
): string {
  const q = (query || "").trim();
  if (!q) return q;
  const parts = [q];

  // 非英文：追加已有拉丁词（原文已包含则跳过，避免重复拼接稀释相关性）
  if (lang !== "en") {
    const enWords = q.match(/[a-zA-Z]{2,}/g);
    if (enWords && enWords.length > 0) {
      const en = enWords.join(" ");
      if (!q.includes(en)) parts.push(en);
    }
  }

  // anime：追加日文关键词块（已包含则跳过）
  if (type.anime) {
    const jp = q.match(/[\u3040-\u30ff\u4e00-\u9fff]{2,}/g);
    if (jp) {
      const j = jp.join(" ");
      if (!q.includes(j)) parts.push(j);
    }
  }
  return parts.join(" ");
}

// ====== 相关性过滤（反污染） ======

/**
 * anime 类型强制按标题相关性过滤，列表类查询（纯新番/季节）放行。
 */
export function filterRelevant(
  results: SearchResult[],
  query: string,
  type: QueryType,
): SearchResult[] {
  const q = (query || "").trim().toLowerCase();
  if (!q || !type.anime) return results;

  // 纯列表类查询放行
  const pure = stripSeason(q).replace(/[\s\d]/g, "");
  if (pure.length < 2) return results;

  // 提取显著 token（长度 ≥2）
  const tokens = q
    .split(/[\s.,;:、，；：（）()「」\[\]【】\-–—/]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  if (!tokens.length) return results;

  return results.filter((r) => {
    const t = (r.title || "").toLowerCase();
    return tokens.some((tk) => t.includes(tk));
  });
}

// ====== 相关性排序与合并（反噪音，供 AI 上下文注入） ======

/** 已知噪音/低质站点（保守黑名单，按需补充——内容农场/聚合/纯转码站） */
const NOISE_DOMAINS = new Set<string>([
  // 占位：后续实测发现垃圾站再补充（避免误伤正常站）
]);

/** 清理 URL：还原搜索跳转 + 去跟踪参数 + 去尾斜杠/首页路径（保留大小写，供展示/抓取） */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    // 搜索引擎点击追踪链接 → 还原真实地址（bing /ck/a 的 u 为 base64）
    if (/^\/ck\/a/i.test(u.pathname) && u.searchParams.get("u")) {
      try {
        const real = atob(u.searchParams.get("u")!);
        if (/^https?:\/\//i.test(real)) return cleanUrl(real);
      } catch {
        /* 非法 base64 忽略 */
      }
    }
    if (
      host.includes("baidu.com") &&
      (u.pathname.startsWith("/link") || u.pathname.startsWith("/s?")) &&
      u.searchParams.get("url")
    ) {
      const real = u.searchParams.get("url")!;
      if (/^https?:\/\//i.test(real)) return cleanUrl(real);
    }
    // 去掉常见跟踪参数
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "spm",
      "from",
      "from_source",
      "from_column",
      "trace",
      "share_token",
    ].forEach((k) => u.searchParams.delete(k));
    u.search = u.searchParams.toString();
    u.hash = "";
    let s = u.href.replace(/\/+$/, "");
    s = s.replace(/\/index\.(html|php|aspx?)$/, "");
    return s;
  } catch {
    return url.trim();
  }
}

/** 从 URL 提取规范化 key（小写，用于去重） */
function normalizeUrlKey(url: string): string {
  return cleanUrl(url).toLowerCase();
}

/** 查询核心 token（去标点/停用数字），用于相关性打分 */
function queryTokens(query: string): string[] {
  return (query || "")
    .toLowerCase()
    .split(/[\s,，。、;；:：()（）\[\]【】\-–—_/]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/** 字符 bigram 集合（中文近重复检测用） */
function bigramSet(s: string): Set<string> {
  const chars = s.replace(/[\s\p{P}\p{S}]+/gu, "");
  const set = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars.slice(i, i + 2));
  return set;
}

/** Dice 系数（0-1）：两串的重叠度，≥0.7 视为近重复 */
function overlapScore(a: string, b: string): number {
  const A = bigramSet(a);
  const B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 单条结果相关性打分（越高越可信） */
function rankResult(r: SearchResult, qTokens: string[]): number {
  let score = 0;
  const title = (r.title || "").toLowerCase();
  const desc = (r.description || "").toLowerCase();
  if (qTokens.length) {
    let hit = 0;
    for (const t of qTokens) if (title.includes(t)) hit++;
    const ratio = hit / qTokens.length;
    if (ratio >= 0.9) score += 3;
    else if (ratio >= 0.5) score += 2;
    else if (ratio >= 0.25) score += 1;
    let dHit = 0;
    for (const t of qTokens) if (desc.includes(t)) dHit++;
    if (dHit / qTokens.length >= 0.5) score += 1;
  }
  // AI 兜底结果：可能是生成/未验证 → 降权
  if (r.engine === "ai") score -= 2;
  let host = "";
  try {
    host = new URL(r.url || "").hostname.replace(/^www\./i, "");
  } catch {
    /* ignore */
  }
  // 搜索引擎/点击追踪域：不该作为结果（Wikipedia 除外）
  if (
    /(^|\.)(bing|duckduckgo|baidu|google|qwant|mojeek)\.(com|org|net|cn|co\.jp|io)$/.test(
      host,
    ) &&
    !host.includes("wikipedia.org")
  ) {
    score -= 4;
  }
  if (NOISE_DOMAINS.has(host)) score -= 3;
  // 权威域加分（高权威 +2，中权威 +1）
  if (
    /\.gov$|\.edu$|^github\.com$|^gitlab\.com$|^npmjs\.com$|^pypi\.org$|^crates\.io$|^docs\.rs$/.test(
      host,
    ) ||
    /^developer\.(mozilla|apple|google|android)\./.test(host) ||
    /^(react\.dev|nodejs\.org|typescriptlang\.org|python\.org|rust-lang\.org|golang\.org|kubernetes\.io|docker\.com|arxiv\.org|doi\.org)$/.test(
      host,
    ) ||
    /wikipedia\.org$/.test(host) ||
    /wikimedia\.org$/.test(host)
  ) {
    score += 2;
  } else if (
    /stackoverflow\.com$|\.stackexchange\.com$|reddit\.com$|news\.ycombinator\.com$|medium\.com$|dev\.to$|freecodecamp\.org$/.test(
      host,
    ) ||
    /^(techcrunch|theverge|arstechnica|wired|reuters|bbc|nature|science|ieee|acm)\.(com|org|net|co\.uk)$/.test(
      host,
    ) ||
    /^blog\./.test(host)
  ) {
    score += 1;
  }
  // 低权威域减分（内容农场/聚合站/纯 SEO 站）
  if (
    /csdn\.net$|jianshu\.com$|cnblogs\.com$|51cto\.com$|oschina\.net$|segmentfault\.com$|juejin\.cn$|infoq\.cn$/.test(
      host,
    )
  ) {
    score -= 2;
  }
  // 新鲜度加分：标题/描述含当前年份 +2
  const currentYear = String(new Date().getFullYear());
  if (
    title.includes(currentYear) ||
    (r.description || "").includes(currentYear)
  ) {
    score += 2;
  }
  // 模板/无意义标题
  const tt = (r.title || "").trim();
  if (/^(首页|主页|搜索|下载|最新更新|未找到|404)$/i.test(tt)) score -= 1;
  if (/(百度百科|搜狗百科|360百科)[\s\-—|]/i.test(tt)) score -= 1;
  if (!tt) score -= 1;
  // 标题党特征减分（震惊/必看/竟然等）
  if (/震惊|惊呆|竟然|居然|必看|不看后悔|绝了|炸裂|爆了/.test(tt)) score -= 2;
  // 全大写英文标题（垃圾特征）
  if (/^[A-Z\s\d]{20,}$/.test(tt)) score -= 1;
  return score;
}

/**
 * 相关性排序与合并（反噪音）：
 *   1. URL 规范化去重（剥跟踪参数/还原跳转）
 *   2. 近重复标题去重（Dice ≥0.7 视为同一篇）
 *   3. 相关性打分排序（权威域加成 / AI 结果降权 / 噪音域减分），截取 top N
 * 供 AI 上下文注入与结果卡使用（抓取目标仍用 diversifyByDomain 保证覆盖）。
 */
export function rankAndConsolidate(
  results: SearchResult[],
  query: string,
  opts: { limit?: number } = {},
): SearchResult[] {
  const limit = opts.limit ?? 6;
  const qTokens = queryTokens(query);
  // 1) URL 规范化去重（输出清理后的真实 URL）
  const seenUrl = new Set<string>();
  const urlDeduped: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrlKey(r.url || "");
    if (!key || seenUrl.has(key)) continue;
    seenUrl.add(key);
    urlDeduped.push({ ...r, url: cleanUrl(r.url || "") });
  }
  // 2) 近重复标题去重（长度差 ≤1 + Dice ≥0.85 才视为同一篇；保守避免误删正常结果）
  const seenTitle: string[] = [];
  const titleDeduped: SearchResult[] = [];
  for (const r of urlDeduped) {
    const norm = (r.title || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    if (!norm) {
      titleDeduped.push(r);
      continue;
    }
    if (
      seenTitle.some(
        (s) =>
          Math.abs(s.length - norm.length) <= 1 &&
          overlapScore(s, norm) >= 0.85,
      )
    ) {
      continue;
    }
    seenTitle.push(norm);
    titleDeduped.push(r);
  }
  // 3) 相关性打分排序 + 截取
  return titleDeduped
    .map((r) => ({ r, s: rankResult(r, qTokens) }))
    .sort(
      (a, b) =>
        b.s - a.s || (b.r.title || "").length - (a.r.title || "").length,
    )
    .slice(0, limit)
    .map((x) => x.r);
}

// ====== 无结果自动纠错 ======

/**
 * 无结果时生成纠错候选（去通用词 → 截短 → 换语言），最多 3 个。
 */
export function correctQuery(query: string, lang: string): string[] {
  const q = (query || "").trim();
  if (!q) return [];
  const out: string[] = [];

  // 1) 去季节/列表通用词
  const c1 = stripSeason(q);
  if (c1 && c1 !== q && c1.length >= 2) out.push(c1);

  // 2) 截短（前 20 字）
  const c2 = q.slice(0, 20).trim();
  if (c2 && c2 !== q && c2.length >= 2) out.push(c2);

  // 3) 非英文 → 追加英文泛化
  if (lang !== "en") {
    const alpha = q
      .replace(/[^\x00-\x7F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (alpha) {
      out.push(alpha);
    } else if (lang === "ja") {
      out.push(`${q} anime`);
    } else {
      out.push(`${q} search`);
    }
  }
  return [...new Set(out)].slice(0, 3);
}

// ====== 搜索定式缓存 ======

interface PatternEntry {
  queryType: string; // "anime"|"news"|"weather"|"general"
  lang: string;
  score: number; // 正值=偏好，负值=避坑
  updatedAt: number;
}

const PATTERN_KEY = "kimo_search_patterns_v1";
const PATTERN_MAX = 20;
const PATTERN_TTL_MS = 7 * 24 * 3600 * 1000;

function loadPatterns(): PatternEntry[] {
  try {
    const raw = localStorage.getItem(PATTERN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function savePatterns(pat: PatternEntry[]) {
  try {
    localStorage.setItem(PATTERN_KEY, JSON.stringify(pat));
  } catch {
    /* quota exceeded */
  }
}

/** 生成 pattern 键 */
function patternKey(type: QueryType, lang: string): string {
  if (type.weather) return `weather:${lang}`;
  if (type.anime) return `anime:${lang}`;
  if (type.news) return `news:${lang}`;
  if (type.fresh) return `fresh:${lang}`;
  return `general:${lang}`;
}

/** 按反馈更新定式分数：positive +1，negative -2 */
export function applyFeedbackToSearch(
  queryType: QueryType,
  lang: string,
  rating: 1 | -1,
): void {
  const key = patternKey(queryType, lang);
  const pat = loadPatterns();
  const now = Date.now();
  const existing = pat.find((p) => p.queryType === key);
  if (existing) {
    existing.score += rating === 1 ? 1 : -2;
    existing.updatedAt = now;
  } else {
    pat.push({
      queryType: key,
      lang,
      score: rating === 1 ? 1 : -2,
      updatedAt: now,
    });
  }
  // 清理过期 & 限数
  const valid = pat
    .filter((p) => now - p.updatedAt < PATTERN_TTL_MS)
    .slice(-PATTERN_MAX);
  savePatterns(valid);
}

/**
 * 查定式缓存：返回当前查询类型的得分（>0=有偏好，≤0=无偏好/避坑）。
 * 得分 >0 表示同类查询过去 👍 多于 👎，可以复用上次策略。
 */
export function getPatternScore(type: QueryType, lang: string): number {
  const key = patternKey(type, lang);
  const pat = loadPatterns();
  const now = Date.now();
  const hit = pat.find(
    (p) => p.queryType === key && now - p.updatedAt < PATTERN_TTL_MS,
  );
  return hit ? hit.score : 0;
}

// ====== 进度回调 ======

export interface SearchProgress {
  stage:
    | "thinking"
    | "planning"
    | "searching"
    | "correcting"
    | "merging"
    | "done";
  current?: number;
  total?: number;
  subQuery?: string;
  message?: string;
}

// ====== 分段搜索结果 ======

export interface SegmentedSearchResult {
  results: SearchResult[];
  subQueries: string[];
  corrected: boolean;
  totalSearches: number;
}

// ====== 主编排 ======

/**
 * 分段多线程搜索：拆分 → 并发 → 纠错 → AI 兜底 → 合并。
 */
export async function searchSegmented(
  query: string,
  opts: {
    limit?: number;
    speed?: "fast" | "standard";
    onProgress?: (p: SearchProgress) => void;
  } = {},
): Promise<SegmentedSearchResult> {
  const { limit = 8, speed = "standard", onProgress } = opts;
  const q = (query || "").trim();
  if (!q) {
    onProgress?.({ stage: "done" });
    return { results: [], subQueries: [], corrected: false, totalSearches: 0 };
  }

  // 阶段 1 & 2
  onProgress?.({ stage: "thinking" });
  const lang = detectQueryLang(q);
  const type = detectQueryType(q);
  const enriched = enrichKeywords(q, lang, type);
  const subs = splitSubQueries(enriched, lang, type, speed);

  onProgress?.({ stage: "planning" });

  const perSub = Math.max(3, Math.ceil(limit / Math.max(1, subs.length)));
  let totalSearches = subs.length;
  let corrected = false;

  // 阶段 3：并发搜索（每子查询走 searchFast——配置 Tavily 时浏览器直连优先，
  // ~1-2s 返回，不再等经 Worker 中转的慢路径 ~8s+，auto 联网明显提速）
  const settled = await Promise.allSettled(
    subs.map(async (sq, i) => {
      onProgress?.({
        stage: "searching",
        current: i + 1,
        total: subs.length,
        subQuery: sq,
      });
      // 修复：逐个子查询搜索（此前误传 enriched 整句 → 分段形同虚设）
      const results = await searchFast(sq, perSub);
      return { sub: sq, results };
    }),
  );

  const all: SearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") all.push(...s.value.results);
  }

  // 全空 → 纠错重试 + AI 兜底
  if (all.length === 0) {
    const corrections = correctQuery(enriched, lang);
    for (const cq of corrections) {
      onProgress?.({
        stage: "correcting",
        total: corrections.length,
        subQuery: cq,
        message: "未找到结果，正在自动纠错重试…",
      });
      const retry = await searchBackend(cq, limit);
      totalSearches++;
      if (retry.length > 0) {
        all.push(...retry);
        corrected = true;
        break;
      }
    }

    // 仍空 → AI 兜底
    if (all.length === 0) {
      const ai = await searchAI(enriched, Math.min(limit, 6));
      totalSearches++;
      if (ai.length > 0) {
        all.push(...ai);
        corrected = true;
      }
    }
  }

  // 阶段 4：合并
  onProgress?.({ stage: "merging" });
  const merged = diversifyByDomain(
    filterRelevant(dedupeByUrl(all), q, type),
    limit,
    2,
  );

  // 反馈命中缓存？仅记录得分（不改变本次结果，下一次同类查询可用 getPatternScore 参考）
  if (merged.length > 0) {
    // 本次搜索成功 → 记录正反馈（轻量 +1，后续用户 👍/👎 会加权覆盖）
    // applyFeedbackToSearch(type, lang, 1); -- 留到用户显式 👍 才写
  }

  onProgress?.({ stage: "done" });
  return { results: merged, subQueries: subs, corrected, totalSearches };
}
