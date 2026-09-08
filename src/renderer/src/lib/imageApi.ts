/**
 * 图片 API 资源库（Image API Registry）
 * 依据 skill 文档实现：图片搜索 / 免费图库 / 二次元图库 的统一图片搜索能力。
 *
 * 统一返回结构（与 skill 文档一致）：
 *   { title, url, thumbnail, source, type, width, height, tags }
 *
 * 来源（无需 API Key，优先经 Worker 代理规避 CORS）：
 *   1. Worker `/api/image/search`（Wikimedia Commons + DuckDuckGo i.js 兜底）
 *   2. 回退：Wikimedia Commons 浏览器直连（origin=*，CORS 友好）
 */

import { resolveMaxTokens } from "./providerPresets";

export interface ImageResult {
  title: string;
  url: string;
  thumbnail: string;
  source: string;
  type: string;
  width: number;
  height: number;
  tags: string[];
}

/** 带超时的 fetch */
async function fetchImageJson(
  url: string,
  timeoutMs = 12000,
): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 经 Worker 代理搜索图片（Wikimedia + DDG 兜底，无 CORS 问题） */
async function searchViaProxy(
  query: string,
  type: string,
  limit: number,
): Promise<ImageResult[]> {
  const j = await fetchImageJson(
    `/api/image/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=${limit}`,
    12000,
  );
  const items = (j as { items?: ImageResult[] } | null)?.items;
  return Array.isArray(items) ? items : [];
}

/** Wikimedia Commons 浏览器直连（CORS 友好，无需 key） */
async function searchWikimediaDirect(
  query: string,
  limit: number,
): Promise<ImageResult[]> {
  const j = await fetchImageJson(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=640&format=json&origin=*`,
    12000,
  );
  const pages = (j as { query?: { pages?: Record<string, unknown> } } | null)
    ?.query?.pages;
  if (!pages) return [];
  const out: ImageResult[] = [];
  for (const p of Object.values(pages)) {
    if (out.length >= limit) break;
    const rec = p as {
      title?: string;
      imageinfo?: Array<{
        url?: string;
        thumburl?: string;
        width?: number;
        height?: number;
        mime?: string;
      }>;
    };
    const ii = rec.imageinfo?.[0];
    if (!ii?.url) continue;
    // 过滤 svg / 极小图
    if (ii.mime?.startsWith("image/svg") || (ii.width || 0) < 400) continue;
    out.push({
      title: rec.title || "",
      url: ii.thumburl || ii.url,
      thumbnail: ii.thumburl || ii.url,
      source: "wikimedia",
      type: "photo",
      width: ii.width || 0,
      height: ii.height || 0,
      tags: [],
    });
  }
  return out;
}

/** 判断查询是否偏动漫/二次元 */
export function inferImageCategory(query: string): string {
  return /动漫|动画|二次元|anime|manga|角色|galgame|壁纸/.test(query)
    ? "anime"
    : /产品|商品|手机|数码|相机|汽车|product/.test(query)
      ? "product"
      : "photo";
}

interface AICfgLike {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 动漫检索：把中文角色/作品名转换为英文/罗马音标签（供 Danbooru/Safebooru/Pixiv 搜索）。
 * 例如「千石由乃 未来日记」→「yuno_gasai mirai_nikki」。失败时原样返回。
 */
export async function animeSearchKeyword(
  query: string,
  cfg?: AICfgLike | null,
): Promise<string> {
  if (!cfg?.endpoint || !cfg?.apiKey || !cfg?.model) return query;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(
        cfg.endpoint.replace(/\/+$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              {
                role: "system",
                content:
                  "你是动漫检索助手。把用户提到的角色/作品/动漫名转换为 1-3 个英文或罗马音搜索标签（如 千石由乃→yuno_gasai、未来日记→mirai_nikki、千恋万花→senren_banka），用空格分隔。只输出标签，不要解释、不要换行。",
              },
              { role: "user", content: query },
            ],
            temperature: 0.3,
            // 推理模型会先消耗 reasoning token，按模型调大避免 content 为空
            max_tokens: resolveMaxTokens(cfg.model, 1200),
            stream: false,
          }),
        },
      );
      if (!res.ok) return query;
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const t = String(j?.choices?.[0]?.message?.content || "")
        .trim()
        .toLowerCase()
        .replace(/[，,。.、"']/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return t || query;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return query;
  }
}

/**
 * 统一图片搜索入口（skill 调度规则）。
 * @param keyword  搜索关键词
 * @param category photo / anime / product
 * @param limit    返回数量
 */
export async function imageSearch(
  keyword: string,
  category = "photo",
  limit = 6,
): Promise<ImageResult[]> {
  const type =
    category === "anime"
      ? "anime"
      : category === "product"
        ? "product"
        : "photo";
  const viaProxy = await searchViaProxy(keyword, type, limit);
  if (viaProxy.length) return viaProxy.slice(0, limit);
  // Worker 代理不可用（如本地 dev 无后端）时回退 Wikimedia 直连
  const direct = await searchWikimediaDirect(keyword, limit);
  return direct.slice(0, limit);
}

/** 提取可用的图片 URL 列表（去重、过滤 data:/svg） */
export function imageUrls(results: ImageResult[], max = 3): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (out.length >= max) break;
    const u = r.url || r.thumbnail;
    if (
      /^https?:\/\//i.test(u) &&
      !u.includes("data:") &&
      !u.endsWith(".svg")
    ) {
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}
