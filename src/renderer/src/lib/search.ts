/**
 * 网络搜索 & 网页抓取模块
 * 参考 open-webSearch (https://github.com/Aas-ee/open-webSearch) 架构重构
 *
 * 架构：
 *   - SearchResult 统一类型
 *   - 每个搜索引擎实现统一签名 (query, limit) => SearchResult[]
 *   - searchMulti() 多引擎聚合搜索
 *   - webSearch() 保持向后兼容（返回格式化文本）
 *   - fetchWebContent() 增强网页抓取
 *   - fetchWebpage() 保持向后兼容
 *
 * 搜索引擎：
 *   1. backend  — /api/search（Worker 多引擎；可携带用户自配的搜索 API 平台 Tavily/Brave/SearXNG）
 *   2. duckduckgo — DuckDuckGo Lite HTML 版（浏览器直连）
 *   3. wikipedia — Wikipedia opensearch API（CORS 友好）
 *   4. brave     — Brave Search 抓取（需后端代理转接）
 *   5. ai        — AI 模型生成搜索结果（回退）
 *
 * 设计原则：被网络拦截/失败时一律优雅降级（免费引擎 + AI 兜底），不硬刚、不做绕过。
 */

import { loadSearchApiCfg, hasSearchApi, cacheTtlMs, todayStr, isFreshQuery } from './searchApi'
import { loadSearchSpeed } from './chatSettings'
import { Readability } from '@mozilla/readability'
import { runSearchAgent } from './searchAgent'
import { resolveMaxTokens } from './providerPresets'
import { isNative, search, fetchPage } from './remote'
import { getAIConfig } from './ai'

// ======================== 类型定义 ========================

/** 搜索结果（与 open-webSearch SearchResult 对齐） */
export interface SearchResult {
  title: string
  url: string
  description: string
  /** 来源站点名 */
  source: string
  /** 搜索引擎名 */
  engine: string
}

/** 网页抓取结果 */
export interface FetchWebContentResult {
  url: string
  finalUrl: string
  contentType: string
  title: string
  /** 抓取方式：direct(浏览器直连) | proxy(后端代理) */
  retrievalMethod: 'direct' | 'proxy'
  truncated: boolean
  content: string
  /** 封面图（og:image，经 Worker /api/fetch 提取） */
  ogImage?: string
  /** 正文图片列表（经 Worker /api/fetch 提取，最多 8 张） */
  images?: string[]
}

/** 搜索引擎执行器签名 */
export type SearchEngineExecutor = (query: string, limit: number) => Promise<SearchResult[]>

/** 多引擎搜索结果 */
export interface MultiSearchResult {
  query: string
  engines: string[]
  totalResults: number
  results: SearchResult[]
  partialFailures: Array<{ engine: string; message: string }>
}

// ======================== 查询类型 / 语言检测 ========================

/** 查询类型：用于决定引擎组合（时敏/天气/新番/新闻走专用引擎） */
export interface QueryType {
  /** 需要最新/实时数据（天气、新番、新闻等） */
  fresh: boolean
  /** 天气查询 */
  weather: boolean
  /** 新番/番剧查询 */
  anime: boolean
  /** 新闻/资讯查询 */
  news: boolean
}

const WEATHER_RE =
  /天气|气温|温度|下雨|降水|降雨|湿度|风力|台风|weather|forecast|temperature|rain|humidity|wind/i
const ANIME_RE = /新番|本季|当季|番剧|夏番|冬番|春番|秋番|动漫新|anime|season|animation/i
const NEWS_RE =
  /今天|今日|最新|新闻|突发|实时|刚刚|昨天|昨日|新作|上市|发布|发售|更新|近期|today|now|recent|latest|news|break/i

/** 检测查询类型（天气/新番/新闻/其他），供引擎组合与深度判断 */
export function detectQueryType(q: string): QueryType {
  const s = q || ''
  const weather = WEATHER_RE.test(s)
  const anime = ANIME_RE.test(s)
  const news = NEWS_RE.test(s)
  return { fresh: weather || anime || news, weather, anime, news }
}

/**
 * 检测查询语言：中文/日文/韩文/英文（用于后端 mkt/locale 自适应）。
 * 多语言混合关键词时取主要语言：日文假名（平/片假名）→ ja；韩文谚文 → ko；中文汉字 → zh；其余 → en。
 * （日文汉字也在 CJK 区间，但含假名的日文查询优先判 ja）
 */
export function detectQueryLang(q: string): 'zh' | 'en' | 'ja' | 'ko' {
  const s = q || ''
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(s)) return 'ja'
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(s)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
  return 'en'
}

// ======================== 工具函数 ========================

const MAX_CHARS_DEFAULT = 30000
const FETCH_TIMEOUT_MS = 8000

/** 后端 /api/search（Worker 多引擎 / Tavily 等第三方 API）超时：放宽到 20s——
 *  Tavily 经 Cloudflare Worker 中转常需 ~8s+，8s 默认超时会导致请求被中止、
 *  搜索回退到 searchAI 垃圾结果（线上实测：worker 带 Tavily 返回 8.4s） */
const SEARCH_TIMEOUT_MS = 20000

/** 带超时的 fetch */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 规范化文本（去除多余空白） */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → 纯文本 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从 URL 提取域名作为 source */
function extractSource(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 去重 URL */
function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter((r) => {
    if (seen.has(r.url)) return false
    seen.add(r.url)
    return true
  })
}

/** 按域名多样化：每站最多 perDomain 条，让结果覆盖多个不同网站（避免只爬单一站点） */
function diversifyByDomain(results: SearchResult[], max: number, perDomain = 2): SearchResult[] {
  const hostCount: Record<string, number> = {}
  const out: SearchResult[] = []
  for (const r of results) {
    let host = r.source || ''
    try {
      host = new URL(r.url).hostname.replace(/^www\./i, '')
    } catch {}
    // bilibili 站内源时效性/相关性优先，放宽每站条数（避免被"每站≤perDomain"稀释）
    const cap = host.includes('bilibili.com') ? 4 : perDomain
    if ((hostCount[host] || 0) >= cap) continue
    hostCount[host] = (hostCount[host] || 0) + 1
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

// ======================== AI 配置读取 ========================

function getAICfg() {
  try {
    // 本地自定义 API 优先（桌面本地模型/用户自配；与 AIChat mergeEffCfg 方向一致）
    // 注意：不能依赖 Object.keys(localStorage) 前缀扫描——部分环境（Electron WebView/测试
    // polyfill）的存储数据键不可枚举，会漏掉 kimo_ai_local_*，导致本地 AI 在搜索兜底里
    // 读不到配置（「AI 搜索资料」断在半路）。统一用 length+key(i) 遍历（同 backupSync/secureStorage）
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('kimo_ai_local_')) continue
      const lc = JSON.parse(localStorage.getItem(k) || 'null')
      if (lc?.endpoint && lc?.apiKey && lc?.model) {
        return { endpoint: lc.endpoint, apiKey: lc.apiKey, model: lc.model }
      }
    }
  } catch {
    /* ignore */
  }
  // 与 ai.ts getAIConfig 对齐：AI 改写选中的机器人（非 bots[0]），再回退首个/旧配置
  try {
    const cfg = getAIConfig()
    if (cfg.enabled && cfg.endpoint && cfg.apiKey && cfg.model) {
      return { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model }
    }
  } catch {
    /* ignore */
  }
  return null
}

// ======================== 引擎 1：后端搜索 ========================

export async function searchBackend(query: string, limit: number): Promise<SearchResult[]> {
  try {
    // 携带用户自配的搜索 API 平台（Tavily/Brave/SearXNG），Worker 代理执行免 CORS
    const cfg = loadSearchApiCfg()
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    if (hasSearchApi(cfg)) {
      params.set('provider', cfg.provider)
      if (cfg.provider === 'tavily') params.set('apiKey', cfg.apiKey.trim())
      if (cfg.provider === 'brave') params.set('apiKey', cfg.apiKey.trim())
      if (cfg.provider === 'searxng') params.set('instance', cfg.instance.trim())
    }
    // 查询类型 → 引擎组合（时敏/天气/新番/新闻用专用引擎；Fast 精简引擎集提速度）
    const type = detectQueryType(query)
    const lang = detectQueryLang(query)
    const fast = loadSearchSpeed() === 'fast'
    let engines: string
    if (type.weather) engines = 'weather,wikipedia,googlenews'
    else if (type.anime) engines = 'bangumi,bilibili,wikipedia'
    else if (type.news || type.fresh) engines = 'googlenews,bingnews,bing,wikipedia'
    else if (fast) engines = 'duckduckgo,wikipedia,bing'
    // 通用查询：只保留高质量可靠引擎（去掉 baidu/qwant/mojeek/bilibili/brave 噪音源，提速提准）
    else engines = 'wikipedia,bing,duckduckgo,googlenews'
    params.set('engines', engines)
    params.set('lang', lang)
    if (fast) params.set('fast', '1')

    // 多语言搜索：非英文查询额外并行一次 lang=en（关键词本身已是多语言混合时，
    // 英文 mkt/locale 能命中英文数据库/海外源，显著提升多语言准确度），结果合并去重。
    // Tavily 直连已覆盖多语言 → 回退 backend 时单次调用即可（提速）
    const tavilyOn = hasSearchApi(cfg) && cfg.provider === 'tavily'
    const langs = lang === 'en' || tavilyOn ? [lang] : [lang, 'en']
    const settled = await Promise.allSettled(
      langs.map(async (l) => {
        const p = new URLSearchParams(params)
        p.set('lang', l)
        // 桌面端：走主进程本地引擎（无 CORS、支持代理）
        if (isNative()) {
          const d = (await search({
            query,
            engines: p.get('engines') || undefined,
            lang: l,
            provider: cfg.provider || undefined,
            apiKey: cfg.apiKey?.trim() || undefined,
            instance: cfg.instance || undefined,
            limit,
            fast
          })) as { items?: SearchResult[] } | null
          return { ok: true, data: d }
        }
        const res = await fetchWithTimeout(
          `/api/search?${p.toString()}`,
          { headers: { Accept: 'application/json' } },
          SEARCH_TIMEOUT_MS
        )
        const data = res.ok
          ? ((await res.json().catch(() => null)) as
              { items?: SearchResult[] } | SearchResult[] | null)
          : null
        return { ok: res.ok, data }
      })
    )
    const items: SearchResult[] = []
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !s.value.ok) continue
      const data = s.value.data
      const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
      items.push(
        ...arr.slice(0, limit).map((it) => ({
          title: it.title || '',
          url: it.url || '',
          description: it.description || '',
          source: it.source || extractSource(it.url || ''),
          engine: 'backend'
        }))
      )
    }
    return dedupeByUrl(items).slice(0, limit)
  } catch {
    return []
  }
}

// ======================== 引擎 2：DuckDuckGo Lite ========================

export async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const res = await fetchWithTimeout(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
    )
    if (!res.ok) return []
    const html = await res.text()
    const results: SearchResult[] = []

    const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g

    const links = [...html.matchAll(linkRegex)]
    const snippets = [...html.matchAll(snippetRegex)]

    for (let i = 0; i < Math.min(links.length, snippets.length, limit); i++) {
      const title = (links[i]?.[2] || '').replace(/<[^>]+>/g, '').trim()
      const url = links[i]?.[1] || ''
      const description = (snippets[i]?.[1] || '').replace(/<[^>]+>/g, '').trim()
      if (title && url) {
        results.push({
          title,
          url,
          description,
          source: extractSource(url),
          engine: 'duckduckgo'
        })
      }
    }
    return results
  } catch {
    return []
  }
}

// ======================== 引擎 3：Wikipedia ========================

export async function searchWikipedia(query: string, limit: number): Promise<SearchResult[]> {
  const results: SearchResult[] = []

  for (const lang of ['zh', 'en']) {
    try {
      const api = `https://${lang}.wikipedia.org/w/api.php`
      const res = await fetchWithTimeout(
        `${api}?action=opensearch&format=json&origin=*&limit=${limit}&namespace=0&search=${encodeURIComponent(query)}`
      )
      if (!res.ok) continue
      const d = (await res.json()) as [string, string[], string[], string[]]
      const titles = (d[1] || []).filter(Boolean)
      const descs = d[2] || []
      const urls = d[3] || []
      if (!titles.length) continue

      const extracts: Record<string, string> = {}
      try {
        const r2 = await fetchWithTimeout(
          `${api}?action=query&prop=extracts&exintro&explaintext&redirects=1&format=json&origin=*&titles=${encodeURIComponent(titles.join('|'))}`
        )
        if (r2.ok) {
          const j2 = (await r2.json()) as {
            query?: {
              pages?: Record<string, { title?: string; extract?: string }>
            }
          }
          for (const p of Object.values(j2.query?.pages || {})) {
            if (p.title && p.extract) extracts[p.title] = p.extract
          }
        }
      } catch {
        /* ignore */
      }

      for (let i = 0; i < titles.length && results.length < limit; i++) {
        const title = titles[i]
        const url = urls[i] || ''
        const desc = (extracts[title] || descs[i] || '').trim().replace(/\s+/g, ' ')
        if (title) {
          results.push({
            title,
            url,
            description: desc,
            source: `${lang}.wikipedia.org`,
            engine: 'wikipedia'
          })
        }
      }
      if (results.length > 0) break
    } catch {
      continue
    }
  }
  return results.slice(0, limit)
}

// ======================== 引擎 4：Brave Search ========================

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const res = await fetchWithTimeout(
      `/api/proxy/search/brave?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { Accept: 'application/json' } }
    )
    if (!res.ok) return []
    const data = await res.json().catch(() => null)
    if (!Array.isArray(data)) return []
    return data.slice(0, limit)
  } catch {
    return searchBraveDirect(query, limit)
  }
}

async function searchBraveDirect(query: string, limit: number): Promise<SearchResult[]> {
  try {
    const res = await fetchWithTimeout(
      `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html'
        }
      }
    )
    if (!res.ok) return []
    const html = await res.text()
    const results: SearchResult[] = []
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    const snippets = doc.querySelectorAll('#results .snippet')
    for (const el of snippets) {
      if (results.length >= limit) break
      const content = el.querySelector('.result-content')
      if (!content) continue
      const mainLink = content.querySelector('> a')
      const url = mainLink?.getAttribute('href') || ''
      const title = mainLink?.querySelector('.search-snippet-title')?.textContent?.trim() || ''
      const description =
        content.querySelector('.generic-snippet')?.textContent?.trim().replace(/\s+/g, ' ') || ''

      if (title && url) {
        results.push({
          title,
          url,
          description,
          source: extractSource(url),
          engine: 'brave'
        })
      }
    }
    return results
  } catch {
    return []
  }
}

// ======================== 引擎 5：AI 生成 ========================

export async function searchAI(query: string, limit: number): Promise<SearchResult[]> {
  const cfg = getAICfg()
  if (!cfg?.endpoint || !cfg?.apiKey || !cfg?.model) return []
  // 推理模型（deepseek-v4-flash 等）会先消耗 token 在思考上：加大 max_tokens 且内容为空时重试一次，
  // 避免「思考占满 token → content 空 → 搜索兜底也空 → 重答不触发」的静默失败
  const tryOnce = async (): Promise<string> => {
    try {
      const res = await fetchWithTimeout(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'system',
              content:
                '你是搜索引擎助手。今天是 ' +
                todayStr() +
                '。用户查询后，请以JSON数组格式返回搜索结果，每条包含title、url、description字段。' +
                '**只能输出你非常有把握真实存在、且与查询直接相关的网站 URL（如知名官网/百科/主流媒体域名）；若不确定某个 URL 是否真实存在，绝对不要编造或拼凑看似合理的链接**。' +
                '最多返回' +
                limit +
                '条；若确实找不到可靠来源，请返回空数组 []。只返回JSON数组，不要其他内容。'
            },
            { role: 'user', content: '查询：' + query }
          ],
          temperature: 0.3,
          max_tokens: resolveMaxTokens(cfg.model, 1200),
          stream: false
        })
      })
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return (j.choices?.[0]?.message?.content || '').trim()
    } catch {
      return ''
    }
  }
  const parseRaw = (raw: string): SearchResult[] => {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.slice(0, limit).map((it: Record<string, string>) => ({
          title: it.title || '',
          url: it.url || '',
          description: it.description || '',
          source: extractSource(it.url || ''),
          engine: 'ai'
        }))
      }
    } catch {
      /* fall through */
    }
    return parseTextResults(raw, limit).map((r) => ({ ...r, engine: 'ai' }))
  }
  let raw = await tryOnce()
  const first = parseRaw(raw)
  if (first.length > 0) return first
  // 首次为空（content 空 / 模型返回空数组）→ 重试一次再兜底
  raw = await tryOnce()
  return parseRaw(raw)
}

function parseTextResults(raw: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const items = raw
    .split(/\n(?=(?:-\s|\d+[.、)]\s))/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const it of items) {
    if (results.length >= limit) break
    let body = it.replace(/^(?:-\s|\d+[.、)]\s+)/, '').replace(/\*\*/g, '')
    const md = body.match(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/)
    const paren = body.match(/\(?(https?:\/\/[^\s)\]】>,;]+)/)
    let title = ''
    let url = ''
    if (md) {
      title = md[1].trim()
      url = md[2].replace(/[)\]】>]+$/, '')
      body = body.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/, ' ')
    } else if (paren) {
      url = paren[1]
      body = body.replace(/\(?https?:\/\/[^\s)\]】>,;]+\)?/, ' ')
    }
    const lines = body
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const first = lines.shift() || ''
    if (!title) title = first.replace(/[\s()）【】\[\]—–-]+$/g, '').trim()
    const desc = lines.join(' ').replace(/\s+/g, ' ').trim()
    if (title || url) {
      results.push({
        title: title || url,
        url: url || '',
        description: desc.slice(0, 300),
        source: extractSource(url),
        engine: 'ai'
      })
    }
  }
  return results
}

// ======================== 引擎 6：Tavily（前端直连） ========================

/**
 * Tavily 直连原始请求（统一封装）。
 * 配置 Tavily API Key 后自动启用；时敏查询（isFreshQuery）自动切 news topic + 短时窗，
 * 保证实时新闻命中（与 Tavily 官网同配置），advanced 深度 + include_answer 拿 AI 直接答案。
 */
async function tavilyRequest(
  query: string,
  limit: number,
  opts: {
    depth?: 'basic' | 'advanced'
    answer?: boolean
    timeout?: number
  } = {}
): Promise<{ results: Record<string, string>[]; answer?: string } | null> {
  try {
    const cfg = loadSearchApiCfg()
    if (cfg.provider !== 'tavily' || !cfg.apiKey?.trim()) return null
    const fresh = isFreshQuery(query)
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey.trim()
        },
        body: JSON.stringify({
          query,
          search_depth: opts.depth || 'basic',
          max_results: Math.min(limit, 10),
          topic: fresh ? 'news' : 'general',
          time_range: fresh ? 'day' : 'week',
          include_answer: opts.answer ? 'advanced' : false,
          include_raw_content: false
        })
      },
      opts.timeout || 8000
    )
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

function tavilyResults(
  raw: { results?: Record<string, string>[] } | null,
  limit: number
): SearchResult[] {
  if (!raw?.results || !Array.isArray(raw.results)) return []
  return raw.results.slice(0, limit).map((it: Record<string, string>) => ({
    title: it.title || '',
    url: it.url || '',
    description: it.content || it.description || '',
    source: extractSource(it.url || ''),
    engine: 'tavily'
  }))
}

/**
 * Tavily Search API 客户端（浏览器直连，免 Worker 代理）。
 * 配置 Tavily API Key 后自动启用，支持 search_depth/topic/include_answer。
 * @param fast 轻量模式（分段采集用）：basic 深度 + 不生成 AI 回答 + 更短超时 → 更快
 */
export async function searchTavilyClient(
  query: string,
  limit: number,
  fast = false
): Promise<SearchResult[]> {
  const j = await tavilyRequest(query, limit, {
    depth: fast ? 'basic' : 'advanced',
    answer: !fast,
    timeout: fast ? 6000 : 8000
  })
  return tavilyResults(j, limit)
}

/** Tavily 深度搜索结果（含 AI 直接答案 answer） */
export interface TavilyDeepResult {
  results: SearchResult[]
  /** Tavily 官方 AI 直接答案（advanced 深度 + include_answer 时返回，官网核心展示内容） */
  answer: string
}

/**
 * Tavily 深度直连：advanced 深度 + 解析 AI 直接答案 answer。
 * 与 Tavily 官网/官方查询同一套参数（news topic 时敏自适应），直连 api.tavily.com。
 */
export async function searchTavilyDeep(query: string, limit: number): Promise<TavilyDeepResult> {
  const j = await tavilyRequest(query, limit, {
    depth: 'advanced',
    answer: true,
    timeout: 8000
  })
  return {
    results: tavilyResults(j, limit),
    answer: typeof j?.answer === 'string' ? j.answer : ''
  }
}

/**
 * 快速搜索（Auto 模式联网用）：
 * 配置 Tavily 时优先浏览器直连 api.tavily.com（~1-2s，远快于经 Cloudflare Worker
 * 中转的实测 ~8s+），限时 6s 有结果即返回；直连超时/无结果再回退 Worker 多引擎代理。
 * 目标：auto 联网搜索「快」——Tavily 直连命中即走快路径，不等慢的后端中转。
 */
export async function searchFast(query: string, limit: number): Promise<SearchResult[]> {
  const cfg = loadSearchApiCfg()
  if (hasSearchApi(cfg) && cfg.provider === 'tavily') {
    const direct = await Promise.race([
      searchTavilyClient(query, limit, true),
      new Promise<SearchResult[]>((resolve) => setTimeout(() => resolve([]), 6000))
    ])
    if (direct.length) return direct
  }
  return searchBackend(query, limit)
}

/**
 * Auto 模式联网搜索专属路径（一次搜索 + Tavily AI 直接答案）：
 * 配置 Tavily 时直接浏览器直连 api.tavily.com（advanced 深度 + answer），返回
 * { results, answer }——answer 注入 AI 上下文让回答更准，结果不与免费引擎混排稀释；
 * 直连超时/无结果再回退 Worker 多引擎代理（answer 为空）。未配置 Tavily 直接走 backend。
 */
export async function searchFastWithAnswer(
  query: string,
  limit: number
): Promise<TavilyDeepResult> {
  const cfg = loadSearchApiCfg()
  if (hasSearchApi(cfg) && cfg.provider === 'tavily') {
    const direct = await Promise.race([
      searchTavilyDeep(query, limit),
      new Promise<TavilyDeepResult>((resolve) =>
        setTimeout(() => resolve({ results: [], answer: '' }), 6000)
      )
    ])
    if (direct.results.length) return direct
  }
  const results = await searchBackend(query, limit)
  return { results, answer: '' }
}

/**
 * 判断 AI 请求错误是否为「内容安全/违规拒绝」。
 * 命中（400/403/422 + 内容安全关键词）时前端用友好提示兜底，避免用户看到"错误：…"红字。
 * （搜索/回答触及违规、敏感内容时，模型/网关常返回 400/403 内容策略错误）
 */
const CONTENT_BLOCK_RE =
  /content.?policy|moderation|safety|inappropriate|blocked|政治|色情|暴力|违法|违规|敏感|审核|不当|不适宜/i
export function isContentBlocked(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err ?? '')
  return /(400|403|422)/.test(s) && CONTENT_BLOCK_RE.test(s)
}

/**
 * 搜索结果敏感内容过滤：标题/描述/URL 命中明确违规词（色情/赌博/毒品/违法等）的条目
 * 直接过滤掉——auto 折叠结果卡里违规内容「默默隐藏」，不展示也不外跳。
 * 仅用明确的违规词，避免误伤正常内容（如「成人教育」「暴力美学」等）。
 */
const SENSITIVE_RE =
  /(色情|情色|裸体|裸照|黄片|黄色网站|成人电影|成人视频|av资源|伦理片|大尺度|赌博|博彩|赌场|线上赌|毒品|冰毒|大麻|海洛因|可卡因|违禁品|非法集资|传销|邪教|血腥|恐怖袭击|枪支弹药)/i
export function filterSensitiveResults(results: SearchResult[]): SearchResult[] {
  return (results || []).filter((r) => {
    const hay = `${r.title || ''} ${r.description || ''} ${r.url || ''}`
    return !SENSITIVE_RE.test(hay)
  })
}

// ======================== 抓取缓存（view 提速：同一批来源只抓一次） ========================

const FETCH_CACHE_MAX = 50
const FETCH_CACHE_TTL = 5 * 60 * 1000
const fetchCache = new Map<string, { res: FetchWebContentResult; ts: number }>()

/**
 * 网页抓取（带会话内缓存）：webSearchWithContent 与 webSearchToArticle 会串行抓取同一批
 * 来源 URL（阶段1 content + 阶段2 文章），缓存命中直接复用，省去重复抓取耗时（view 提速）。
 * 仅缓存成功且非空结果（失败不缓存，允许下次重试）。
 */
export async function fetchWebContent(
  url: string,
  maxChars: number = MAX_CHARS_DEFAULT
): Promise<FetchWebContentResult> {
  const u = url.trim()
  try {
    const hit = fetchCache.get(u)
    if (hit && Date.now() - hit.ts < FETCH_CACHE_TTL) return hit.res
  } catch {
    /* ignore */
  }
  const res = await fetchWebContentInner(u, maxChars)
  if (res.content || res.ogImage || (res.images && res.images.length)) {
    try {
      if (fetchCache.size >= FETCH_CACHE_MAX) {
        const oldest = [...fetchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
        if (oldest) fetchCache.delete(oldest[0])
      }
      fetchCache.set(u, { res, ts: Date.now() })
    } catch {
      /* ignore */
    }
  }
  return res
}

// ======================== 多引擎聚合搜索 ========================

export const SEARCH_ENGINES: Record<string, SearchEngineExecutor> = {
  backend: searchBackend,
  duckduckgo: searchDuckDuckGo,
  wikipedia: searchWikipedia,
  brave: searchBrave,
  ai: searchAI,
  tavily: searchTavilyClient
}

export async function searchMulti(
  query: string,
  engines: string[] = ['duckduckgo', 'wikipedia'],
  limit: number = 10
): Promise<MultiSearchResult> {
  const perEngineLimit = Math.max(3, Math.ceil(limit / Math.max(1, engines.length)))
  const allResults: SearchResult[] = []
  const partialFailures: MultiSearchResult['partialFailures'] = []

  const settled = await Promise.allSettled(
    engines.map(async (name) => {
      const executor = SEARCH_ENGINES[name]
      if (!executor) {
        partialFailures.push({
          engine: name,
          message: `不支持的搜索引擎: ${name}`
        })
        return []
      }
      try {
        return await executor(query, perEngineLimit)
      } catch (e) {
        partialFailures.push({
          engine: name,
          message: e instanceof Error ? e.message : String(e)
        })
        return []
      }
    })
  )

  for (const s of settled) {
    if (s.status === 'fulfilled') allResults.push(...s.value)
  }

  return {
    query,
    engines,
    totalResults: allResults.length,
    results: dedupeByUrl(allResults).slice(0, limit),
    partialFailures
  }
}

export function formatResults(results: SearchResult[]): string {
  if (!results.length) return '- 未找到结果\n  请尝试更换关键词或确保AI已配置'
  return results.map((r) => `- ${r.title} (${r.url})\n  ${r.description.slice(0, 300)}`).join('\n')
}

// ======================== 向后兼容：webSearch ========================

export async function webSearch(query: string): Promise<string> {
  // 并行：后端多引擎 + Tavily 前端直连（若已配置），取最先返回的结果
  const tasks: Promise<SearchResult[]>[] = [searchBackend(query, 6)]
  if (hasSearchApi(loadSearchApiCfg()) && loadSearchApiCfg().provider === 'tavily') {
    tasks.push(searchTavilyClient(query, 6))
  }
  const settled = await Promise.allSettled(tasks)
  const all: SearchResult[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') all.push(...s.value)
  }
  const merged = dedupeByUrl(all).slice(0, 6)
  if (merged.length) return formatResults(merged)

  // 客户端直连引擎仅保留 CORS 友好的 Wikipedia（duckduckgo/brave 浏览器直连被 CORS 拦截，已由 backend 覆盖）
  const multi = await searchMulti(query, ['wikipedia'], 6)
  if (multi.results.length) return formatResults(multi.results)

  const ai = await searchAI(query, 6)
  if (ai.length) return formatResults(ai)

  return '- 未找到结果\n  请确保AI已配置，或尝试输入完整网址直接访问'
}

// ======================== 网页抓取 ========================

/** 用 @mozilla/readability（Firefox 同款）提取网页正文，失败返回空串（回退 worker content） */
function extractReadable(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const reader = new Readability(doc)
    const article = reader.parse()
    const text = (article && article.textContent ? article.textContent : '').trim()
    if (text.length >= 40) return normalizeText(text)
  } catch {
    /* 解析失败回退 */
  }
  return ''
}

async function fetchWebContentInner(
  url: string,
  maxChars: number = MAX_CHARS_DEFAULT
): Promise<FetchWebContentResult> {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) {
    throw new Error('仅支持 HTTP(S) 链接')
  }

  let retrievalMethod: 'direct' | 'proxy' = 'proxy'
  let finalUrl = u
  let raw = ''
  let contentType = 'text/plain'
  let ct = ''

  try {
    // 桌面端优先：主进程本地抓取（无 CORS、经代理）
    if (isNative()) {
      const j = (await fetchPage({
        url: u,
        maxChars,
        raw: true
      })) as {
        finalUrl?: string
        contentType?: string
        title?: string
        ogImage?: string
        images?: string[]
        rawHtml?: string
        content?: string
        truncated?: boolean
      } | null
      if (j && (j.content || j.rawHtml)) {
        const base = {
          url: u,
          finalUrl: j.finalUrl || u,
          contentType: j.contentType || 'text/html',
          title: j.title || '',
          ogImage: j.ogImage || '',
          images: Array.isArray(j.images)
            ? j.images.filter((im: string) => /^https?:\/\//i.test(im) && !im.includes('data:'))
            : [],
          retrievalMethod: 'proxy' as const
        }
        if (typeof j.rawHtml === 'string') {
          const readContent = extractReadable(j.rawHtml)
          if (readContent) {
            const truncated = readContent.length > maxChars
            return {
              ...base,
              truncated,
              content: truncated
                ? readContent.slice(0, maxChars) +
                  `\n\n[...truncated ${readContent.length - maxChars} characters]`
                : readContent
            }
          }
        }
        if (j.content) {
          return {
            ...base,
            truncated: j.truncated || false,
            content: normalizeText(j.content)
          }
        }
      }
    } else {
      const res = await fetchWithTimeout(
        `/api/fetch?url=${encodeURIComponent(u)}&maxChars=${maxChars}&raw=1`,
        { headers: { Accept: 'text/plain,application/json' } },
        12000
      )
      if (res.ok) {
        ct = res.headers.get('content-type') || ''
        if (ct.includes('json')) {
          const j = await res.json()
          const base = {
            url: u,
            finalUrl: (j && j.finalUrl) || u,
            contentType: (j && j.contentType) || 'text/html',
            title: (j && j.title) || '',
            ogImage: (j && j.ogImage) || '',
            images: Array.isArray(j && j.images)
              ? j.images.filter((im: string) => /^https?:\/\//i.test(im) && !im.includes('data:'))
              : [],
            retrievalMethod: 'proxy' as const
          }
          // readability 优先：浏览器端提取干净正文（无导航/页脚噪音）
          if (j && typeof j.rawHtml === 'string') {
            const readContent = extractReadable(j.rawHtml)
            if (readContent) {
              const truncated = readContent.length > maxChars
              return {
                ...base,
                truncated,
                content: truncated
                  ? readContent.slice(0, maxChars) +
                    `\n\n[...truncated ${readContent.length - maxChars} characters]`
                  : readContent
              }
            }
          }
          if (j && j.content) {
            return {
              ...base,
              truncated: j.truncated || false,
              content: normalizeText(j.content)
            }
          }
        }
        raw = await res.text()
      }
    }
    if (raw && raw.trim().length > 40) {
      contentType = ct || 'text/plain'
      retrievalMethod = 'proxy'
    }
  } catch {
    /* 代理不可用，回退直连 */
  }

  if (!raw) {
    try {
      const res = await fetchWithTimeout(
        u,
        {
          headers: {
            Accept: 'text/html,text/plain,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        },
        12000
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      finalUrl = res.url || u
      contentType = res.headers.get('content-type') || 'text/plain'
      raw = await res.text()
      retrievalMethod = 'direct'
    } catch (e) {
      throw new Error(`无法抓取网页: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  let title = ''
  let content = ''

  if (contentType.includes('text/html') || raw.includes('<html')) {
    const doc = new DOMParser().parseFromString(raw, 'text/html')
    title = doc.querySelector('title')?.textContent?.trim() || ''

    const selectors = [
      'article',
      'main',
      '[role="main"]',
      '.markdown-body',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content',
      '#content'
    ]
    for (const sel of selectors) {
      const el = doc.querySelector(sel)
      if (el && (el.textContent?.length || 0) >= 120) {
        content = htmlToText(el.innerHTML)
        break
      }
    }
    if (!content) {
      doc
        .querySelectorAll('script, style, noscript, nav, footer, header')
        .forEach((e) => e.remove())
      content = htmlToText(doc.body?.innerHTML || raw)
    }
  } else {
    content = normalizeText(raw)
  }

  const truncated = content.length > maxChars
  const finalContent = truncated
    ? content.slice(0, maxChars) + `\n\n[...truncated ${content.length - maxChars} characters]`
    : content

  return {
    url: u,
    finalUrl,
    contentType,
    title,
    retrievalMethod,
    truncated,
    content: finalContent
  }
}

export async function fetchWebpage(url: string): Promise<string> {
  try {
    const result = await fetchWebContent(url)
    return result.content
  } catch {
    const u = url.trim()
    if (!/^https?:\/\//i.test(u)) return ''
    try {
      const res = await fetch(u, {
        headers: { Accept: 'text/html,text/plain' }
      })
      if (!res.ok) return ''
      const html = await res.text()
      const text = htmlToText(html)
      return text.length > 40 ? normalizeText(text) : ''
    } catch {
      return ''
    }
  }
}

export function getAvailableEngines(): string[] {
  return Object.keys(SEARCH_ENGINES)
}

// ======================== 搜索 + 多结果内容抓取 ========================

/**
 * 增强搜索：获取搜索结果列表，并对前 maxSources 个来源抓取正文内容。
 * 返回「搜索结果列表 + 各来源内容摘要」，供 AI 筛选综合多个资料后作答。
 *
 * 格式（供 AI 参考，标注来源便于引用）：
 *   【搜索结果】
 *   1. 标题 (url) — 描述
 *   ...
 *   【来源内容 · N 个】
 *   来源1 (url)：正文摘要...
 *   ...
 */
export async function webSearchWithContent(
  query: string,
  maxSources: number = 3,
  perSourceChars: number = 2500
): Promise<string> {
  // 1) 高级搜索智能：Deep 三阶段搜索（意图分析 → 查询改写 → Broad→Precision→Verification）
  //    —— 配置 Tavily 直连三阶段（技术查询 site: 限制等精准化）；未配置则单阶段分段多引擎稳健搜索；
  //    结果已含低质过滤（标题党/关键词堆积/AI 垃圾）+ 权威排序 + 相关性合并
  const agentResult = await runSearchAgent(query, '', 'deep').catch(() => null)
  let searchResults = agentResult?.results ?? []
  if (!searchResults.length) {
    // 回退 AI 生成列表
    const ai = await searchAI(query, 6)
    if (ai.length) searchResults.push(...ai)
  }
  if (!searchResults.length) return ''

  const out: string[] = []
  out.push('【搜索结果】')
  searchResults.slice(0, 8).forEach((r, i) => {
    out.push(`${i + 1}. ${r.title} (${r.url})\n   ${(r.description || '').slice(0, 200)}`)
  })

  // 2) 对前 maxSources 个来源抓取正文（按域名多样化，覆盖多个不同网站）
  const targets = diversifyByDomain(
    dedupeByUrl(searchResults).filter((r) => /^https?:\/\//i.test(r.url)),
    maxSources,
    2
  )

  if (targets.length) {
    out.push(`\n【来源内容 · ${targets.length} 个】`)
    const contents = await Promise.allSettled(
      targets.map((t) =>
        fetchWebContent(t.url, perSourceChars).then((c) => ({
          url: t.url,
          title: c.title || t.title,
          content: c.content
        }))
      )
    )
    contents.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.content.trim()) {
        out.push(
          `\n来源${i + 1} (${s.value.url}${s.value.title ? ' | ' + s.value.title : ''})：\n${s.value.content.slice(0, perSourceChars)}`
        )
      } else {
        out.push(`\n来源${i + 1} (${targets[i]?.url})：内容抓取失败或为空`)
      }
    })
  }

  return out.join('\n')
}

// ======================== AI 生成 markdown 文章（综合筛选） ========================

/** 从网页提取 og:image 封面图（优先经本地/Worker 代理，解决 CORS） */
async function extractOgImage(url: string): Promise<string> {
  try {
    if (isNative()) {
      const j = (await fetchPage({
        url,
        maxChars: 5000
      })) as { ogImage?: string } | null
      if (j?.ogImage) return j.ogImage
    } else {
      const res = await fetchWithTimeout(
        `/api/fetch?url=${encodeURIComponent(url)}&maxChars=5000`,
        { headers: { Accept: 'application/json' } },
        8000
      )
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as {
          ogImage?: string
        } | null
        if (j?.ogImage) return j.ogImage
      }
    }
  } catch {
    /* 代理不可用，回退直连 */
  }
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: { Accept: 'text/html' }
      },
      6000
    )
    const html = await res.text()
    const m =
      html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/**
 * 深度搜索 + AI 综合筛选 → 标准 markdown 文章（含标题/分节/列表/引用/图片/来源）。
 * 流程：
 *   1. 多引擎搜索拿结果列表
 *   2. 对前 maxSources 个来源抓取正文 + 提取 og:image 封面
 *   3. 调用 AI 按标准格式筛选综合生成文章
 */
export async function webSearchToArticle(
  query: string,
  maxSources: number = 6,
  seedUrls: string[] = []
): Promise<{ article: string; sources: SearchResult[] }> {
  const cfg = getAICfg()
  if (!cfg?.endpoint || !cfg?.apiKey || !cfg?.model) {
    return { article: '', sources: [] }
  }

  // 1) 来源：优先复用已抓取到的 URL（避免并发重复搜索被限流导致空结果），
  //    否则多引擎搜索
  let tavilyAnswer = ''
  let results: SearchResult[] = seedUrls.map((u) => {
    let host = ''
    try {
      host = new URL(u).hostname.replace(/^www\./i, '')
    } catch {
      host = u
    }
    return {
      title: host,
      url: u,
      description: '',
      source: host,
      engine: 'seed'
    }
  })
  if (!results.length) {
    const scfg = loadSearchApiCfg()
    const tavilyOn = hasSearchApi(scfg) && scfg.provider === 'tavily'
    if (tavilyOn) {
      // Tavily 专属：advanced + AI 直接答案（answer 作蒸馏信号注入文章，提高准确度）
      const tv = await searchTavilyDeep(query, 8)
      results = dedupeByUrl(tv.results)
      tavilyAnswer = tv.answer || ''
    }
    // Tavily 结果不足时用免费引擎补充（backend 含 bing/duckduckgo/news；wikipedia CORS 兜底）
    if (results.length < 4) {
      const multi = await searchMulti(query, ['backend', 'wikipedia'], 10)
      results = dedupeByUrl([...results, ...multi.results])
    }
    if (!results.length) {
      const ai = await searchAI(query, 6)
      results = dedupeByUrl(ai)
    }
  }
  if (!results.length) return { article: '', sources: results }

  // 2) 抓取正文 + 封面图（按域名多样化，覆盖多个不同网站）
  const targets = diversifyByDomain(
    results.filter((r) => /^https?:\/\//i.test(r.url)),
    maxSources,
    2
  )
  const fetched = await Promise.allSettled(
    targets.map(async (t) => {
      let content = ''
      let image = ''
      let images: string[] = []
      try {
        const c = await fetchWebContent(t.url, 2200)
        content = c.content
        image = c.ogImage || ''
        images = (c.images || [])
          .filter((im) => /^https?:\/\//i.test(im) && !im.includes('data:'))
          .filter((u, i, a) => a.indexOf(u) === i)
      } catch {
        /* 单点失败不影响整体 */
      }
      if (!image) image = await extractOgImage(t.url)
      if (image && !images.includes(image)) images.unshift(image)
      return { url: t.url, title: t.title, content, image, images }
    })
  )

  const sourcesBlock = fetched
    .map((s, i) => {
      if (s.status !== 'fulfilled') return ''
      const f = s.value
      const imgs = (f.images || [])
        .filter((u: string) => /^https?:\/\//i.test(u) && !u.includes('data:'))
        .slice(0, 5)
        .map((u: string) => `\n[图片]: ${u}`)
        .join('')
      return `来源${i + 1} (${f.url} | ${f.title})${imgs}：\n${(f.content || '').slice(0, 2200) || '(内容抓取失败或为空——资料有限，请勿编造该来源的细节，可明确标注资料不足)'}`
    })
    .filter(Boolean)
    .join('\n\n')

  // 3) AI 综合筛选生成标准 markdown 文章
  const sys =
    '你是资深内容研究员。今天是 ' +
    todayStr() +
    '（检索时间）。基于用户提供的【搜索结果】与【来源内容】，筛选、交叉验证并综合多个资料，' +
    '用**标准 Markdown 格式**生成一篇结构化文章。要求：\n' +
    '- 首行 H1 标题（中文，概括主题）\n' +
    '- 开头 2-3 句引言摘要（加粗要点）\n' +
    '- 用 H2 分节（3-5 节），每节用有序/无序列表或短段落呈现关键信息\n' +
    '- 尽量引用具体数据/版本号/日期/数字/案例，内容充实有料，避免空泛套话；信息可能已过时请如实说明（资料检索于 ' +
    todayStr() +
    '）\n' +
    '- **来源约束（重要）：文章中的事实、数据、日期只能来自【来源内容】与【搜索结果】；来源未覆盖的信息绝对不要编造，明确标注『资料有限，未能核实』；禁止凭空编造来源 URL、机构名、版本号或数据**\n' +
    '- 若提供了来源图片（[图片]: URL），请把多张图片分布到文章各处（封面放 H1 标题后，其余每节各插 1 张），用 `![配图](图片URL)` 插入\n' +
    '- 引用事实时用 `> 引用` 块，末尾附「参考来源」列表（Markdown 链接，只能列真实来源）\n' +
    '- 安全合规：若主题涉及成人/敏感/争议内容，仅做客观克制的信息介绍，绝不输出露骨、色情、暴力、仇恨或违法违规内容；资料不足时如实说明\n' +
    '- 只输出文章正文，不要额外说明'
  const userMsg = `${
    tavilyAnswer
      ? 'Tavily 官方 AI 检索答案（优先依据，可作核心参考）：\n' + tavilyAnswer + '\n\n'
      : ''
  }查询主题：${query}\n\n【搜索结果】\n${results
    .slice(0, 10)
    .map(
      (r, i) =>
        `${i + 1}. ${r.title} (${r.url})${r.engine === 'ai' ? '（AI 补充，未经抓取验证）' : ''}\n   ${r.description?.slice(0, 200)}`
    )
    .join(
      '\n'
    )}\n\n【来源内容】\n${sourcesBlock || '(未能抓取到来源正文。不要编造来源内容与数据，请仅基于搜索结果条目的标题/摘要作有限作答，并在文末注明『资料有限，未能核实』)'}`

  // AI 调用（推理模型可能把 token 用尽在思考上，加大 max_tokens 并在 content 为空时重试一次）
  let article = ''
  const tryGenerate = async () => {
    try {
      const res = await fetchWithTimeout(
        cfg.endpoint.replace(/\/+$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + cfg.apiKey
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.5,
            max_tokens: 4000,
            stream: false
          })
        },
        60000
      )
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return (j.choices?.[0]?.message?.content || '').trim()
    } catch {
      return ''
    }
  }
  article = await tryGenerate()
  if (!article) article = await tryGenerate()

  // 多图增强：收集所有来源图片（og:image + 正文图），封面 1 张 + 各 H2 小节前各 1 张，最多共 3 张
  if (article) {
    const imgs = fetched
      .filter(
        (
          f
        ): f is PromiseFulfilledResult<{
          url: string
          title: string
          content: string
          image: string
          images: string[]
        }> => f.status === 'fulfilled'
      )
      .flatMap((f) =>
        (f.value.images.length ? f.value.images : f.value.image ? [f.value.image] : []).filter(
          (u: string) => /^https?:\/\//i.test(u) && !u.includes('data:')
        )
      )
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, 5)
    if (imgs.length) {
      // 1) 封面：H1 标题后（若文章还没有任何图）
      if (!article.includes('![') && /^#/.test(article)) {
        const nl = article.indexOf('\n')
        article =
          nl > 0
            ? article.slice(0, nl) + '\n\n![配图](' + imgs[0] + ')\n' + article.slice(nl)
            : article + '\n\n![配图](' + imgs[0] + ')'
      }
      // 2) 各 H2 小节前补图（从最后一个 H2 往前插保证索引有效；最多再补 2 张）
      const used = article.split('![').length - 1
      const h2s = [...article.matchAll(/^##\s.+$/gm)].map((m) => m.index!)
      let added = 0
      for (let k = h2s.length - 1; k >= 1 && added < 3 && used + added < imgs.length; k--) {
        const img = imgs[used + added]
        article = article.slice(0, h2s[k]) + '\n\n![配图](' + img + ')\n' + article.slice(h2s[k])
        added++
      }
    }
  }
  return { article, sources: results }
}

// ======================== 搜索/文章历史缓存（避免重复生成） ========================

interface SearchCacheEntry {
  content: string
  article: string
  sources: SearchResult[]
  time: number
  loading: boolean
  /** 标记 loading 的时间戳：搜索被中断（关页/报错）时条目可能永久停在 loading，靠它判定过期并重试 */
  loadingAt?: number
}

const SEARCH_CACHE_KEY = 'kimo_search_cache_v1'
const SEARCH_CACHE_MAX = 30
const SEARCH_CACHE_TTL = 60 * 60 * 1000 // 默认 1 小时（保证能获取当天信息，可在设置中调整）
/** loading 条目超过该时长视为"卡死"（搜索被中断），清理后允许重新搜索 */
const LOADING_STALE_MS = 5 * 60 * 1000

function searchCacheKey(q: string): string {
  return q.trim().toLowerCase()
}

function loadSearchCache(): Record<string, SearchCacheEntry> {
  try {
    const r = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '{}')
    return r && typeof r === 'object' ? r : {}
  } catch {
    return {}
  }
}

function saveSearchCache(map: Record<string, SearchCacheEntry>): void {
  try {
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* 忽略 */
  }
}

/** 读取缓存（生成中返回 loading 标记；过期自动清理） */
export function readSearchCache(query: string): (SearchCacheEntry & { cached: boolean }) | null {
  const map = loadSearchCache()
  const e = map[searchCacheKey(query)]
  if (!e) return null
  // 生成中：返回 loading，不当作完成；但若卡死超时（搜索被中断）则清理，允许重新搜索
  if (e.loading) {
    const startedAt = e.loadingAt || e.time || 0
    if (Date.now() - startedAt > LOADING_STALE_MS) {
      delete map[searchCacheKey(query)]
      saveSearchCache(map)
      return null
    }
    return { ...e, cached: false, loading: true }
  }
  // 过期清理（TTL 默认 1 小时，可在设置中调整为 15min/6h；bilibili 站内源时效性要求更高 → 30min）
  const hasBili = (e.sources || []).some((s) => {
    try {
      return /bilibili\.com/i.test(new URL(s.url || '').hostname)
    } catch {
      return false
    }
  })
  const ttl = hasBili ? 30 * 60 * 1000 : cacheTtlMs(loadSearchApiCfg()) || SEARCH_CACHE_TTL
  if (Date.now() - e.time > ttl) {
    delete map[searchCacheKey(query)]
    saveSearchCache(map)
    return null
  }
  return { ...e, cached: true }
}

/** 写入缓存（保留最近 SEARCH_CACHE_MAX 条） */
export function writeSearchCache(query: string, entry: Partial<SearchCacheEntry>): void {
  const map = loadSearchCache()
  const key = searchCacheKey(query)
  const prev = map[key] || {}
  const merged: SearchCacheEntry = { ...prev, ...entry, time: Date.now() }
  // 进入 loading 时记录起始时间（用于"卡死"判定）；完成时清除
  if (entry.loading === true) merged.loadingAt = Date.now()
  else if (entry.loading === false) delete merged.loadingAt
  map[key] = merged
  // 限制条数：超限删最旧
  const keys = Object.keys(map)
  if (keys.length > SEARCH_CACHE_MAX) {
    keys
      .sort((a, b) => (map[a].time || 0) - (map[b].time || 0))
      .slice(0, keys.length - SEARCH_CACHE_MAX)
      .forEach((k) => delete map[k])
  }
  saveSearchCache(map)
}

/** 清除某条缓存 */
export function clearSearchCache(query?: string): void {
  const map = loadSearchCache()
  if (query) delete map[searchCacheKey(query)]
  else {
    Object.keys(map).forEach((k) => delete map[k])
  }
  saveSearchCache(map)
}

/** 从已抓取的搜索内容里提取来源 URL（供文章生成复用，避免并发重复搜索） */
function extractSourceUrls(content: string, max = 4): string[] {
  if (!content) return []
  const urls: string[] = []
  const re = /https?:\/\/[^\s)\]】>]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) && urls.length < max) {
    const u = m[0].replace(/[)\]】>]+$/, '')
    if (/^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u)
  }
  return urls
}

/**
 * 带缓存的深度搜索 + AI 文章（供浏览面板使用）：
 * - 命中缓存直接返回（不重复生成）
 * - 未命中则搜索+抓取+AI 生成，完成后自动写入历史
 * - 生成中标记 loading，避免并发重复生成
 */
export type SearchWithCacheResult = {
  content: string
  article: string
  sources: SearchResult[]
  time: number
  cached: boolean
  loading: boolean
  fresh: boolean
}

export async function searchWithCache(
  query: string,
  opts: {
    maxSources?: number
    perSourceChars?: number
    /** 强制刷新：绕过缓存重新搜索 + 生成（实时更新用） */
    force?: boolean
  } = {}
): Promise<SearchWithCacheResult> {
  // 非强制刷新时先查缓存
  if (!opts.force) {
    const hit = readSearchCache(query)
    // 命中缓存：有文章（或没有内容）直接返回；有内容但文章为空（上次生成失败）→ 补生成文章，
    // 避免空文章长期占位导致永远不生成
    if (hit && (hit.article || !hit.content)) {
      return { ...hit, loading: !!hit.loading, fresh: false }
    }
    if (hit) {
      writeSearchCache(query, { loading: true })
      try {
        const articleRes = await webSearchToArticle(
          query,
          opts.maxSources ?? 6,
          extractSourceUrls(hit.content, opts.maxSources ?? 6)
        )
        const entry: SearchCacheEntry = {
          content: hit.content,
          article: articleRes.article || '',
          sources: articleRes.sources?.length > 0 ? articleRes.sources : hit.sources,
          time: Date.now(),
          loading: false
        }
        writeSearchCache(query, entry)
        return { ...entry, loading: false, cached: true, fresh: false }
      } catch {
        writeSearchCache(query, { loading: false })
        return { ...hit, loading: false, cached: true, fresh: false }
      }
    }
  }

  // 标记生成中（同关键词并发只生成一次）
  writeSearchCache(query, { loading: true })

  try {
    // 先抓内容，再复用其来源生成文章（串行：避免并发重复搜索被限流导致文章为空）
    const content = await webSearchWithContent(
      query,
      opts.maxSources ?? 5,
      opts.perSourceChars ?? 2200
    )
    const articleRes = await webSearchToArticle(
      query,
      opts.maxSources ?? 6,
      extractSourceUrls(content, opts.maxSources ?? 6)
    )
    const entry: SearchCacheEntry = {
      content: content || '',
      article: articleRes.article || '',
      sources: articleRes.sources || [],
      time: Date.now(),
      loading: false
    }
    writeSearchCache(query, entry)
    return { ...entry, loading: false, cached: false, fresh: true }
  } catch {
    writeSearchCache(query, { loading: false })
    return {
      content: '',
      article: '',
      sources: [],
      time: Date.now(),
      cached: false,
      loading: false,
      fresh: true
    }
  }
}
