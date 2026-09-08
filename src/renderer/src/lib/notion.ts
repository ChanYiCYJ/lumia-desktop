/**
 * Notion 融合源（📓）：接入 Notion Workspace 实时数据。
 * - 经 Worker `/api/notion/*` 代理（Notion API 无 CORS 头，浏览器直连必被拦），
 *   Token 放 `x-notion-token` 头（避免进 URL/日志），Worker 服务端转发到 api.notion.com。
 * - Token 存 localStorage（kimo_notion_cfg），与站点既有「密钥仅保存在当前浏览器」约定一致。
 * - 纯函数 + 可注入 fetch，便于 vitest 单测；未配置/网络失败时优雅降级为空（不阻塞对话）。
 * - 桌面端：主进程直连（免 CORS，见 ./remote）。
 */

import { isNative, notion } from './remote'

export interface NotionCfg {
  /** Notion Integration Token（secret_...） */
  token: string
}

export interface NotionSearchResult {
  id: string
  title: string
  url: string
  lastEdited: string
  type: 'page' | 'database' | 'other'
  /** 父级信息（Content access 层级：子页=page_id、工作区顶层=workspace、数据库条目=database_id） */
  parent?: { type?: string; id?: string }
}

const KEY = 'kimo_notion_cfg'

// ---- localStorage 配置 ----

export function loadNotionCfg(): NotionCfg {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (r && typeof r === 'object' && typeof r.token === 'string') {
      return { token: r.token }
    }
  } catch {}
  return { token: '' }
}

export function saveNotionCfg(cfg: NotionCfg): void {
  localStorage.setItem(KEY, JSON.stringify({ token: (cfg.token || '').trim() }))
}

export function clearNotionCfg(): void {
  localStorage.removeItem(KEY)
}

export function hasNotionCfg(cfg?: NotionCfg): boolean {
  const c = cfg || loadNotionCfg()
  return !!c.token.trim()
}

/**
 * 生成 notion.so 页面/数据库链接（设置页「在 Notion 中打开」）。
 * 搜索结果有官方 url 时优先用 url（含标题可读路径），否则按 id 构造（去横线）。
 */
export function notionPageUrl(id: string, url?: string): string {
  if (!id) return ''
  if (url && /^https?:\/\//i.test(url)) return url
  return `https://www.notion.so/${id.replace(/-/g, '')}`
}

// ---- 知识库来源分区选中（kimo_notion_sel） ----

export interface NotionSel {
  /** 勾选「加入知识库」的 Notion 页面 ID */
  pageIds: string[]
}

const SEL_KEY = 'kimo_notion_sel'

export function loadNotionSel(): NotionSel {
  try {
    const r = JSON.parse(localStorage.getItem(SEL_KEY) || 'null')
    if (r && Array.isArray(r.pageIds)) {
      return {
        pageIds: r.pageIds.filter((x: unknown) => typeof x === 'string')
      }
    }
  } catch {}
  return { pageIds: [] }
}

export function saveNotionSel(sel: NotionSel): void {
  const unique = [...new Set((sel.pageIds || []).filter((x: unknown) => typeof x === 'string'))]
  localStorage.setItem(SEL_KEY, JSON.stringify({ pageIds: unique.slice(0, 20) }))
}

export function hasNotionSel(sel?: NotionSel): boolean {
  const s = sel || loadNotionSel()
  return s.pageIds.length > 0
}

// ---- 统一请求（经 Worker 代理） ----

/** 经 /api/notion/{path} 代理请求（path 可含子路径与查询串，如 blocks/{id}/children?page_size=30） */
export async function notionRequest<T>(
  path: string,
  opts: {
    method?: string
    body?: unknown
    token: string
    fetchImpl?: typeof fetch
  }
): Promise<T> {
  const f = opts.fetchImpl || fetch
  const init: RequestInit = {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-notion-token': opts.token
    }
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  // 429 限流退避重试（并发请求后更易触发 Notion 速率限制；最多重试 2 次，指数退避）
  const MAX_RETRIES = 2
  for (let attempt = 0; ; attempt++) {
    let res: { status: number; text: string }
    // 桌面端：主进程直连 Notion（免 CORS）
    if (isNative()) {
      res = (await notion({
        path,
        method: opts.method,
        body: opts.body,
        token: opts.token
      })) as { status: number; text: string }
    } else {
      const r = await f('/api/notion/' + path, init)
      // 兼容：真实 Response 用 text()；测试 mock 可能仅提供 json()
      res =
        typeof r.text === 'function'
          ? { status: r.status, text: await r.text() }
          : {
              status: (r.status as number) ?? 200,
              text: JSON.stringify(
                (await (r as { json?: () => Promise<unknown> }).json?.().catch(() => ({}))) ?? {}
              )
            }
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)))
      continue
    }
    const j = (() => {
      try {
        return JSON.parse(res.text || '{}') as {
          message?: unknown
          error?: unknown
        }
      } catch {
        return {}
      }
    })()
    if (res.status >= 400) {
      const msg = j?.message || j?.error || `Notion 请求失败 (${res.status})`
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    return j as T
  }
}

// ---- 解析（纯函数） ----

/** 从 Notion 页面 properties 提取标题文本（title 类型属性） */
export function pageTitle(properties: Record<string, unknown> | undefined): string {
  if (!properties) return ''
  for (const key of Object.keys(properties)) {
    const p = properties[key] as { type?: string; title?: unknown }
    // 仅当 title 是数组才提取（页面的 title 属性是 [{plain_text}]；
    // 数据库的 title 属性定义是 {} 对象，直接跳过避免 .map 崩溃）
    if (p && Array.isArray(p.title)) {
      return (p.title as { plain_text?: string }[]).map((t) => t.plain_text || '').join('')
    }
  }
  return ''
}

/** 从块对象提取富文本（paragraph/heading_1..3/list/to_do/quote/code 等按 type 取 rich_text） */
export function blockText(block: { type?: string; [k: string]: unknown }): string {
  const type = block.type || ''
  const b = block[type] as { rich_text?: { plain_text?: string }[] } | undefined
  if (!b || !Array.isArray(b.rich_text)) return ''
  return b.rich_text.map((t) => t.plain_text || '').join('')
}

/** 从 Notion parent 对象提取父级 id（page_id / database_id） */
function extractParentId(parent: unknown): string {
  const p = parent as { type?: string; page_id?: string; database_id?: string } | undefined
  if (!p || typeof p !== 'object') return ''
  if (typeof p.page_id === 'string') return p.page_id
  if (typeof p.database_id === 'string') return p.database_id
  return ''
}

/** 解析 /v1/search 响应 → 搜索结果列表 */
export function parseSearchResponse(data: { results?: unknown[] }): NotionSearchResult[] {
  const out: NotionSearchResult[] = []
  for (const r of data.results || []) {
    const item = r as {
      object?: string
      id?: string
      url?: string
      last_edited_time?: string
      properties?: Record<string, unknown>
      title?: unknown
      parent?: unknown
    }
    if (!item || typeof item.id !== 'string') continue
    const type = item.object === 'page' ? 'page' : item.object === 'database' ? 'database' : 'other'
    // 数据库标题在顶层 title 数组（不在 properties 里）；页面标题在 properties.title
    const dbTitle = Array.isArray(item.title)
      ? (item.title as { plain_text?: string }[]).map((t) => t.plain_text || '').join('')
      : ''
    const p = item.parent as { type?: string } | undefined
    out.push({
      id: item.id,
      title: dbTitle || pageTitle(item.properties),
      url: item.url || '',
      lastEdited: item.last_edited_time || '',
      type,
      parent: {
        type: p?.type || '',
        id: extractParentId(item.parent)
      }
    })
  }
  return out
}

// ---- Content access 层级（根 → 页面 → 子页面） ----

export interface NotionRootMap {
  /** 根页面（Content access root）列表 */
  roots: NotionSearchResult[]
  /** 页面 id → 根页面 id */
  rootOf: Map<string, string>
  /** 页面 id → 直接父页面 id（顶层为 null） */
  parentOf: Map<string, string | null>
}

/**
 * 根据搜索到的页面列表构建「Content access 根 → 页面 → 子页面」层级。
 * 根 = 父级不在可访问集合（或父为 workspace/database）的页面；沿 parent 链上溯，环/深链安全封顶。
 * 纯函数，供知识库按根分组与子页面树使用。
 */
export function resolveNotionRoots(pages: NotionSearchResult[]): NotionRootMap {
  const byId = new Map<string, NotionSearchResult>()
  for (const p of pages) if (p?.id) byId.set(p.id, p)
  const roots: NotionSearchResult[] = []
  const rootOf = new Map<string, string>()
  const parentOf = new Map<string, string | null>()
  const ensureRoot = (id: string, root: NotionSearchResult) => {
    if (!rootOf.has(id)) {
      rootOf.set(id, root.id)
      if (!roots.some((r) => r.id === root.id)) roots.push(root)
    }
  }
  for (const p of pages) {
    if (!p?.id) continue
    let cur: NotionSearchResult | undefined = p
    const visited = new Set<string>()
    for (let guard = 0; cur && guard < 50; guard++) {
      const parentId = cur.parent?.id || ''
      const parentType = cur.parent?.type || ''
      if (cur.id === p.id) {
        parentOf.set(p.id, parentId || null)
      }
      // 父是 workspace / database（或没有父）→ 自己是根
      if (!parentId || parentType === 'workspace' || parentType === 'database_id') {
        ensureRoot(p.id, cur)
        break
      }
      const parentPage = byId.get(parentId)
      // 父不在可访问集合 → 自己是根（该共享页就是 Content access 根）
      if (!parentPage) {
        ensureRoot(p.id, cur)
        break
      }
      if (visited.has(cur.id)) {
        // 环：把当前页作为根兜底，避免死循环
        ensureRoot(p.id, cur)
        break
      }
      visited.add(cur.id)
      cur = parentPage
    }
  }
  return { roots, rootOf, parentOf }
}

/** 解析块 children 响应 → 可读文本行（跳过 image/child_page/table 等无正文块） */
export function parseBlocks(data: { results?: unknown[] }): string[] {
  const lines: string[] = []
  for (const r of data.results || []) {
    const block = r as { type?: string; [k: string]: unknown }
    if (!block || typeof block.type !== 'string') continue
    const t = blockText(block)
    if (t.trim()) lines.push(t.trim())
  }
  return lines
}

// ---- 意图检测 ----

/**
 * 判断用户消息是否涉及 Notion Workspace（📓 源）。命中才实时检索 Notion（省 token/省请求）。
 * 保守：显式提 Notion，或「我的/工作区 + 数据库/页面/笔记/文档/记录/资料/项目」指向性组合。
 */
export function isNotionQuery(userMsg: string): boolean {
  const t = (userMsg || '').trim()
  if (!t) return false
  if (/notion/i.test(t)) return true
  if (/(我的|我创建的|工作区)/.test(t) && /(数据库|页面|笔记|文档|记录|资料|项目)/.test(t))
    return true
  return false
}

/**
 * 判断是否为「个人知识/内容」类查询（我的知识库/知识/笔记/内容/资料/项目/记录/文章…）。
 * 用于 Notion 已配置时把这些查询也融合进 Notion 检索（📓 P1 源，把 Notion 当作知识库的一部分）；
 * 未配置时不会触发（避免对「我的知识库」误报「Notion 未连接」）。
 */
export function isPersonalKnowledgeQuery(userMsg: string): boolean {
  const t = (userMsg || '').trim()
  if (!t) return false
  // ① 我的 + 通用个人内容名词 + 查询意图
  if (
    /(我的|我创建的|自己的)/.test(t) &&
    /(知识库|知识|笔记|内容|资料|项目|记录|文章|文档)/.test(t) &&
    /(什么|有哪些|看看|查|找|整理|总结|列出|浏览|进展|状态|情况)/.test(t)
  )
    return true
  // ② 我的 + Notion 专属名词（数据库/清单/列表/看板/页面）——直接视为要查这类内容
  if (/(我的|我创建的)/.test(t) && /(数据库|清单|列表|看板|页面)/.test(t)) return true
  return false
}

// ---- 上下文构建 ----

/** 把搜索结果 + 页面正文格式化为注入文本（供 notionSection 注入 system） */
export function buildNotionContext(
  results: NotionSearchResult[],
  pages: Record<string, string>,
  intro = '以下是当前 Notion Workspace 中检索到的相关内容：'
): string {
  if (!results.length) return ''
  const lines: string[] = [`【Notion 资料】${intro}`]
  for (const r of results.slice(0, 6)) {
    const body = pages[r.id] ? '\n' + pages[r.id] : ''
    const edited = r.lastEdited ? `（更新于 ${r.lastEdited.slice(0, 10)}）` : ''
    lines.push(
      `- ${r.title || '(无标题)'} [${r.type === 'page' ? '页面' : '数据库'}]${edited}${body}`
    )
  }
  return lines.join('\n')
}

export interface FetchNotionOptions {
  token: string
  maxPages?: number
  maxBlocksPerPage?: number
  maxChars?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 检索 Notion 上下文：搜索 → 拉取前 maxPages 个页面正文 → 格式化为注入文本。
 * 限时返回（慢/失败 → 空串，不阻塞对话）。
 */
export async function fetchNotionContext(query: string, opts: FetchNotionOptions): Promise<string> {
  const {
    token,
    maxPages = 3,
    maxBlocksPerPage = 30,
    maxChars = 4000,
    timeoutMs = 8000,
    fetchImpl
  } = opts
  if (!token.trim()) return ''
  const run = async (): Promise<string> => {
    const searchOnce = (q: string) =>
      notionRequest<{ results?: unknown[] }>('search', {
        method: 'POST',
        body: {
          query: q,
          page_size: maxPages,
          filter: { value: 'page', property: 'object' }
        },
        token,
        fetchImpl
      })
    let data = await searchOnce(query)
    let results = parseSearchResponse(data)
    // 兜底：整句/自然语言查询通常不匹配 Notion 关键词搜索（如"看看我的 Notion 里有什么"），
    // 空查询列出最近页面，让「浏览我的 Notion」类意图也能拿到内容
    if (!results.length) {
      data = await searchOnce('')
      results = parseSearchResponse(data)
    }
    if (!results.length) return ''
    const pages: Record<string, string> = {}
    // 并发拉取各页正文（最多 maxPages 个），大幅减少串行 RTT，加速 AI 对话实时检索
    await Promise.all(
      results.slice(0, maxPages).map(async (r) => {
        try {
          const blockData = await notionRequest<{ results?: unknown[] }>(
            `blocks/${r.id}/children?page_size=${maxBlocksPerPage}`,
            { token, fetchImpl }
          )
          const lines = parseBlocks(blockData)
          pages[r.id] = lines.join('\n').slice(0, 1500)
        } catch {
          /* 单页失败跳过，不影响其余 */
        }
      })
    )
    return buildNotionContext(results, pages).slice(0, maxChars)
  }
  return Promise.race([
    run().catch(() => ''),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs))
  ])
}

/** 拉取 Notion 页面元信息（标题/更新时间），供来源分区展示与选中内容构建 */
export async function notionFetchPage(
  id: string,
  token: string,
  fetchImpl?: typeof fetch
): Promise<{ title: string; lastEdited: string; parentId: string }> {
  const data = await notionRequest<{
    properties?: Record<string, unknown>
    last_edited_time?: string
    parent?: unknown
  }>(`pages/${id}`, { token, fetchImpl })
  return {
    title: pageTitle(data.properties),
    lastEdited: data.last_edited_time || '',
    parentId: extractParentId(data.parent)
  }
}

/** 拉取 Notion 页面/数据库列表（空查询，不拉正文，供 Agent 知识库来源分区展示） */
export async function fetchNotionPageList(
  token: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {}
): Promise<NotionSearchResult[]> {
  const { limit = 8, fetchImpl } = opts
  if (!token.trim()) return []
  try {
    const data = await notionRequest<{ results?: unknown[] }>('search', {
      method: 'POST',
      body: { query: '', page_size: limit },
      token,
      fetchImpl
    })
    return parseSearchResponse(data)
  } catch {
    return []
  }
}

/** 拉取用户在知识库中选中的 Notion 页面正文 → 格式化注入文本（供 AI 上下文） */
export async function fetchNotionSelectedContent(
  token: string,
  pageIds: string[],
  opts: {
    maxPages?: number
    maxBlocksPerPage?: number
    maxChars?: number
    fetchImpl?: typeof fetch
  } = {}
): Promise<string> {
  const { maxPages = 3, maxBlocksPerPage = 30, maxChars = 4000, fetchImpl } = opts
  if (!token.trim() || !pageIds.length) return ''
  const results: NotionSearchResult[] = []
  const pages: Record<string, string> = {}
  // 并发拉取各选中页（元信息 + 正文），减少串行 RTT
  await Promise.all(
    pageIds.slice(0, maxPages).map(async (id) => {
      try {
        const meta = await notionFetchPage(id, token, fetchImpl)
        const blockData = await notionRequest<{ results?: unknown[] }>(
          `blocks/${id}/children?page_size=${maxBlocksPerPage}`,
          { token, fetchImpl }
        )
        const lines = parseBlocks(blockData)
        results.push({
          id,
          title: meta.title,
          url: '',
          lastEdited: meta.lastEdited,
          type: 'page'
        })
        pages[id] = lines.join('\n').slice(0, 1500)
      } catch {
        /* 单页失败跳过，不影响其余 */
      }
    })
  )
  return buildNotionContext(results, pages, '以下是你在知识库中选中的 Notion 内容：').slice(
    0,
    maxChars
  )
}

/** 测试 Notion 连接（空查询搜 1 条验证 Token/权限） */
export async function testNotionConnection(
  token: string,
  fetchImpl?: typeof fetch
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  if (!token.trim()) return { ok: false, message: '请先填写 Notion Integration Token' }
  const t0 = performance.now()
  try {
    const data = await notionRequest<{ results?: unknown[] }>('search', {
      method: 'POST',
      body: { query: '', page_size: 1 },
      token: token.trim(),
      fetchImpl
    })
    const ms = Math.round(performance.now() - t0)
    const n = parseSearchResponse(data).length
    return {
      ok: true,
      message: n
        ? '连接成功'
        : '连接成功（工作区暂无可访问内容，请确认 Integration 已共享到页面/数据库）',
      latencyMs: ms
    }
  } catch (e) {
    const ms = Math.round(performance.now() - t0)
    const msg = e instanceof Error ? e.message : '请求失败'
    const friendly = /401|unauthor|invalid/i.test(msg)
      ? 'Token 无效或无权限（请确认 Token 正确且 Integration 已共享到目标页面）'
      : msg
    return { ok: false, message: friendly, latencyMs: ms }
  }
}

// ================= Notion 数据库结构化查询（P1） =================
// 经 Worker 透传代理直接打 /v1/databases/{id}/query 与 /v1/pages（无需改 Worker 转发逻辑）。
// 全部纯函数 + 可注入 fetch，便于 vitest 单测；失败时优雅降级（空数组/false/null，不阻塞对话）。

export interface NotionPropertyOption {
  id?: string
  name: string
  color?: string
}

export interface NotionDatabaseProperty {
  id: string
  name: string
  /** title/rich_text/select/status/multi_select/checkbox/number/date/url/people… */
  type: string
  options: NotionPropertyOption[]
}

export interface NotionDatabaseSchema {
  id: string
  title: string
  properties: Record<string, NotionDatabaseProperty>
}

export interface NotionDbRow {
  id: string
  title: string
  url: string
  lastEdited: string
  /** 可读属性值（属性名 → 文本，如 状态 → 进行中） */
  props: Record<string, string>
}

export interface NotionDbQuery {
  filter?: unknown
  sorts?: unknown[]
  page_size?: number
}

/** 列出工作区所有数据库（search filter=object:database，不拉正文） */
export async function fetchNotionDatabases(
  token: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {}
): Promise<NotionSearchResult[]> {
  const { limit = 10, fetchImpl } = opts
  if (!token.trim()) return []
  try {
    const data = await notionRequest<{ results?: unknown[] }>('search', {
      method: 'POST',
      body: {
        query: '',
        page_size: limit,
        filter: { value: 'database', property: 'object' }
      },
      token,
      fetchImpl
    })
    return parseSearchResponse(data)
  } catch {
    return []
  }
}

/** 读取数据库 schema（properties 定义），供写入与属性筛选 UI 使用 */
export async function fetchNotionDatabaseSchema(
  token: string,
  databaseId: string,
  fetchImpl?: typeof fetch
): Promise<NotionDatabaseSchema> {
  const data = await notionRequest<{
    id?: string
    title?: unknown
    properties?: Record<string, unknown>
  }>(`databases/${databaseId}`, { token, fetchImpl })
  return parseDatabaseSchema(data)
}

/** 解析数据库 schema（纯函数） */
export function parseDatabaseSchema(data: {
  id?: string
  title?: unknown
  properties?: Record<string, unknown>
}): NotionDatabaseSchema {
  const titleArr = Array.isArray(data.title)
    ? (data.title as { plain_text?: string }[]).map((t) => t.plain_text || '').join('')
    : ''
  const properties: Record<string, NotionDatabaseProperty> = {}
  for (const [name, raw] of Object.entries(data.properties || {})) {
    const p = raw as {
      id?: string
      type?: string
      select?: { options?: unknown[] }
      status?: { options?: unknown[] }
      multi_select?: { options?: unknown[] }
    }
    if (!p || typeof p !== 'object') continue
    const type = p.type || ''
    const optionList = p.select?.options || p.status?.options || p.multi_select?.options || []
    properties[name] = {
      id: p.id || '',
      name,
      type,
      options: optionList
        .map((o) => {
          const opt = o as { id?: string; name?: string; color?: string }
          return {
            id: opt.id || '',
            name: opt.name || '',
            color: opt.color || ''
          }
        })
        .filter((o) => o.name)
    }
  }
  return { id: data.id || '', title: titleArr, properties }
}

/** 从数据库 schema 找到 title 属性名（用于写入时填标题） */
export function resolveDbTitleProperty(schema: NotionDatabaseSchema): string {
  for (const [name, p] of Object.entries(schema.properties)) {
    if (p.type === 'title') return name
  }
  // 兜底：第一个属性（尽量不空）
  return Object.keys(schema.properties)[0] || 'Name'
}

// ---- schema 缓存（写入提速：创建/更新不再每次都拉数据库 schema） ----
const SCHEMA_CACHE = new Map<string, { titleProp: string; expire: number }>()
const SCHEMA_TTL_MS = 5 * 60 * 1000

/** 解析写入目标数据库的 title 属性名（带 TTL 缓存，写入提速） */
export async function resolveDbTitlePropertyCached(
  token: string,
  databaseId: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  if (!databaseId) return 'Name'
  const hit = SCHEMA_CACHE.get(databaseId)
  if (hit && hit.expire > Date.now()) return hit.titleProp
  const schema = await fetchNotionDatabaseSchema(token, databaseId, fetchImpl)
  const titleProp = resolveDbTitleProperty(schema)
  SCHEMA_CACHE.set(databaseId, {
    titleProp,
    expire: Date.now() + SCHEMA_TTL_MS
  })
  return titleProp
}

/** 从属性值对象提取可读文本（title/rich_text/select/status/multi_select/checkbox/number/date/url/people） */
export function propValueText(prop: Record<string, unknown> | undefined): string {
  if (!prop || typeof prop !== 'object') return ''
  const type = prop.type as string
  if (type === 'select' || type === 'status') {
    const v = prop[type] as { name?: string } | null
    return v?.name || ''
  }
  if (type === 'multi_select') {
    const arr = prop[type] as { name?: string }[] | undefined
    return (arr || [])
      .map((o) => o?.name || '')
      .filter(Boolean)
      .join('、')
  }
  if (type === 'title' || type === 'rich_text') {
    const arr = prop[type] as { plain_text?: string }[] | undefined
    return (arr || []).map((t) => t?.plain_text || '').join('')
  }
  if (type === 'checkbox') return prop.checkbox ? '✓' : ''
  if (type === 'number') return prop.number != null ? String(prop.number) : ''
  if (type === 'date') {
    const d = prop.date as { start?: string; end?: string } | null
    return d ? (d.start || '') + (d.end ? ' ~ ' + d.end : '') : ''
  }
  if (type === 'url') return typeof prop.url === 'string' ? prop.url : ''
  if (type === 'people') {
    const arr = prop.people as { name?: string }[] | undefined
    return (arr || [])
      .map((o) => o?.name || '')
      .filter(Boolean)
      .join('、')
  }
  return ''
}

/** 解析数据库查询响应 → 行列表（title 属性作标题，其余作 props） */
export function parseDatabaseRows(data: { results?: unknown[] }): NotionDbRow[] {
  const out: NotionDbRow[] = []
  for (const r of data.results || []) {
    const row = r as {
      id?: string
      url?: string
      last_edited_time?: string
      properties?: Record<string, Record<string, unknown>>
    }
    if (!row || typeof row.id !== 'string') continue
    const props: Record<string, string> = {}
    let title = ''
    for (const [name, p] of Object.entries(row.properties || {})) {
      const t = propValueText(p)
      if (!t) continue
      if ((p?.type as string) === 'title' && !title) title = t
      else props[name] = t
    }
    out.push({
      id: row.id,
      title,
      url: row.url || '',
      lastEdited: row.last_edited_time || '',
      props
    })
  }
  return out
}

/** 查询数据库（支持按属性 filter + 排序），失败返回空数组 */
export async function queryNotionDatabase(
  token: string,
  databaseId: string,
  opts: NotionDbQuery = {},
  fetchImpl?: typeof fetch
): Promise<NotionDbRow[]> {
  if (!token.trim() || !databaseId) return []
  try {
    const body: Record<string, unknown> = {}
    if (opts.filter) body.filter = opts.filter
    if (opts.sorts && opts.sorts.length) body.sorts = opts.sorts
    body.page_size = opts.page_size || 50
    const data = await notionRequest<{ results?: unknown[] }>(`databases/${databaseId}/query`, {
      method: 'POST',
      body,
      token,
      fetchImpl
    })
    return parseDatabaseRows(data)
  } catch {
    return []
  }
}

/** 构造属性筛选 filter（select/status → equals；multi_select → contains；checkbox → equals bool） */
export function buildDbFilter(
  propType: string,
  propName: string,
  value: string | boolean
): Record<string, unknown> | null {
  if (!propName) return null
  if (value === '' || value === null || value === undefined || value === 'all') return null
  if (propType === 'select' || propType === 'status') {
    return { property: propName, [propType]: { equals: String(value) } }
  }
  if (propType === 'multi_select') {
    return { property: propName, multi_select: { contains: String(value) } }
  }
  if (propType === 'checkbox') {
    return { property: propName, checkbox: { equals: !!value } }
  }
  if (propType === 'number') {
    const n = Number(value)
    if (Number.isNaN(n)) return null
    return { property: propName, number: { equals: n } }
  }
  return null
}

/** 把数据库查询结果格式化为注入文本（供 AI 上下文 / 展示） */
export function buildNotionDbContext(
  rows: NotionDbRow[],
  schemaTitle: string,
  intro = '以下是当前 Notion 数据库中的条目：'
): string {
  if (!rows.length) return ''
  const dbName = schemaTitle ? `「${schemaTitle}」` : ''
  const lines: string[] = [`【Notion 数据库】${dbName}${intro}`]
  for (const r of rows.slice(0, 20)) {
    const propText = Object.entries(r.props)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ')
    const edited = r.lastEdited ? `（更新于 ${r.lastEdited.slice(0, 10)}）` : ''
    lines.push(`- ${r.title || '(无标题)'}${edited}${propText ? `\n  ${propText}` : ''}`)
  }
  return lines.join('\n')
}

// ================= Notion 写入（创建页面 / 追加块 / 更新属性） =================

/** 把 markdown 内容切成 Notion paragraph blocks（每块 ≤1900 字符，按段落切分） */
export function contentToBlocks(content: string): unknown[] {
  const MAX = 1900
  const blocks: unknown[] = []
  const pushBlock = (text: string) => {
    const t = text.trim()
    if (!t) return
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: t.slice(0, MAX) } }]
      }
    })
  }
  for (const para of (content || '').split(/\n\s*\n/)) {
    if (para.length <= MAX) {
      pushBlock(para)
      continue
    }
    // 长段落按行二分；超长单行再硬切块，避免内容截断丢失
    let buf = ''
    for (const line of para.split('\n')) {
      if (buf && (buf + '\n' + line).length > MAX) {
        pushBlock(buf)
        buf = line
      } else {
        buf = buf ? buf + '\n' + line : line
      }
      // 单行本身超长 → 硬切
      while (buf.length > MAX) {
        pushBlock(buf.slice(0, MAX))
        buf = buf.slice(MAX)
      }
    }
    pushBlock(buf)
  }
  return blocks
}

/** 构造数据库条目 properties（title 属性 + 可选额外属性） */
export function buildDbPageProperties(
  titleProp: string,
  title: string,
  extraProps?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [titleProp]: {
      title: [{ text: { content: (title || '').slice(0, 1900) } }]
    },
    ...(extraProps || {})
  }
}

/** 构造独立页面（父=页面，非数据库）的标题 properties：标题属性键固定为 "title" */
export function buildPageTitleProps(title: string): Record<string, unknown> {
  return {
    title: {
      title: [{ text: { content: (title || '').slice(0, 1900) } }]
    }
  }
}

/** 在数据库中创建页面（写入 Notion），返回新页面 id；失败返回 null */
export async function createNotionPageInDatabase(
  token: string,
  databaseId: string,
  opts: {
    titleProp: string
    title: string
    content: string
    extraProps?: Record<string, unknown>
    fetchImpl?: typeof fetch
  }
): Promise<{ id: string } | null> {
  const { titleProp, title, content, extraProps, fetchImpl } = opts
  if (!token.trim() || !databaseId) return null
  const blocks = contentToBlocks(content)
  try {
    const res = await notionRequest<{ id?: string }>('pages', {
      method: 'POST',
      body: {
        parent: { database_id: databaseId },
        properties: buildDbPageProperties(titleProp, title, extraProps),
        // children 不能为空数组（Notion API 400）；无内容则不传
        ...(blocks.length ? { children: blocks } : {})
      },
      token,
      fetchImpl
    })
    return res && res.id ? { id: res.id } : null
  } catch {
    return null
  }
}

/** 在父页面下创建子页面（parent=page_id），返回新页面 id；失败返回 null */
export async function createNotionSubPage(
  token: string,
  parentPageId: string,
  opts: {
    title: string
    content: string
    fetchImpl?: typeof fetch
  }
): Promise<{ id: string } | null> {
  const { title, content, fetchImpl } = opts
  if (!token.trim() || !parentPageId) return null
  const blocks = contentToBlocks(content)
  try {
    const res = await notionRequest<{ id?: string }>('pages', {
      method: 'POST',
      body: {
        parent: { page_id: parentPageId },
        properties: {
          title: {
            title: [{ text: { content: (title || '').slice(0, 1900) } }]
          }
        },
        // children 不能为空数组（Notion API 400）；无内容则不传
        ...(blocks.length ? { children: blocks } : {})
      },
      token,
      fetchImpl
    })
    return res && res.id ? { id: res.id } : null
  } catch {
    return null
  }
}

/** 向已有页面追加内容块（写入 Notion） */
export async function appendNotionBlocks(
  token: string,
  pageId: string,
  content: string,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!token.trim() || !pageId || !content.trim()) return false
  try {
    await notionRequest(`blocks/${pageId}/children`, {
      method: 'PATCH',
      body: { children: contentToBlocks(content) },
      token,
      fetchImpl
    })
    return true
  } catch {
    return false
  }
}

/**
 * 镜像覆盖页面内容（知识库为编辑入口，Notion 为镜像）：
 * 列出子块 → 有界并发删除旧块 → 追加新内容块。
 * 语义=Notion 页面内容与知识库完全一致（替代 append 追加历史，避免多次编辑累积重复）。
 */
const DELETE_CONCURRENCY = 4
const DELETE_MAX_BLOCKS = 500

export async function replaceNotionPageContent(
  token: string,
  pageId: string,
  content: string,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!token.trim() || !pageId) return false
  try {
    // 1) 列出子块（分页，最多 DELETE_MAX_BLOCKS）
    const blocks: { id?: string }[] = []
    let cursor: string | null = null
    let hasMore = true
    while (hasMore && blocks.length < DELETE_MAX_BLOCKS) {
      const path: string = cursor
        ? `blocks/${pageId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `blocks/${pageId}/children?page_size=100`
      const data: {
        results?: unknown[]
        next_cursor?: string | null
      } = await notionRequest(path, { token, fetchImpl })
      for (const raw of data.results || []) {
        blocks.push(raw as { id?: string })
      }
      hasMore = !!data.next_cursor
      cursor = data.next_cursor || null
    }
    // 2) 有界并发删除旧块
    if (blocks.length) {
      let i = 0
      const workers = Array.from(
        { length: Math.min(DELETE_CONCURRENCY, blocks.length) },
        async () => {
          while (i < blocks.length) {
            const b = blocks[i++]
            if (!b?.id) continue
            try {
              await notionRequest(`blocks/${b.id}`, {
                method: 'DELETE',
                token,
                fetchImpl
              })
            } catch {
              /* 单块删除失败忽略 */
            }
          }
        }
      )
      await Promise.all(workers)
    }
    // 3) 追加新内容（Notion 每次最多 100 个块，分批串行追加，避免大内容静默失败）
    const newBlocks = contentToBlocks(content)
    const APPEND_BATCH = 100
    for (let i = 0; i < newBlocks.length; i += APPEND_BATCH) {
      const chunk = newBlocks.slice(i, i + APPEND_BATCH)
      if (!chunk.length) continue
      await notionRequest(`blocks/${pageId}/children`, {
        method: 'PATCH',
        body: { children: chunk },
        token,
        fetchImpl
      })
    }
    return true
  } catch {
    return false
  }
}

/** 更新已有页面属性（如标题），失败返回 false */
export async function updateNotionPageProps(
  token: string,
  pageId: string,
  properties: Record<string, unknown>,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!token.trim() || !pageId || !Object.keys(properties).length) return false
  try {
    await notionRequest(`pages/${pageId}`, {
      method: 'PATCH',
      body: { properties },
      token,
      fetchImpl
    })
    return true
  } catch {
    return false
  }
}

/** 按标题查找 Notion 页面（用于避免重复创建；返回首个精确匹配） */
export async function findNotionPageByTitle(
  token: string,
  title: string,
  fetchImpl?: typeof fetch
): Promise<{ id: string } | null> {
  if (!token.trim() || !title.trim()) return null
  try {
    const data = await notionRequest<{ results?: unknown[] }>('search', {
      method: 'POST',
      body: { query: title.trim(), page_size: 5 },
      token,
      fetchImpl
    })
    const rows = parseSearchResponse(data)
    const t = title.trim().toLowerCase()
    const hit = rows.find((r) => r.type === 'page' && r.title.trim().toLowerCase() === t)
    return hit ? { id: hit.id } : null
  } catch {
    return null
  }
}

// ================= Notion 默认数据库（写入/查询目标） =================
const DB_KEY = 'kimo_notion_db'

/** 读取默认数据库 id（写入/查询 Notion 条目的目标） */
export function loadNotionDbId(): string {
  try {
    return localStorage.getItem(DB_KEY) || ''
  } catch {
    return ''
  }
}

export function saveNotionDbId(dbId: string): void {
  try {
    localStorage.setItem(DB_KEY, (dbId || '').trim())
  } catch {
    /* 忽略 */
  }
}

/** 删除 Notion 页面（按 id）；404（页面已被删除/悬空）也视为成功，不阻塞 */
export async function deleteNotionPage(
  token: string,
  pageId: string,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!token.trim() || !pageId) return false
  try {
    await notionRequest(`pages/${pageId}`, {
      method: 'DELETE',
      token,
      fetchImpl
    })
    return true
  } catch {
    return true
  }
}

// ================= 数据库查询结果（加入 AI 上下文） =================
const DB_ROWS_KEY = 'kimo_notion_db_rows'

/** 读取知识库卡片上最近一次数据库查询结果（格式化文本），供 AI 上下文注入 */
export function loadNotionDbRows(): string {
  try {
    return localStorage.getItem(DB_ROWS_KEY) || ''
  } catch {
    return ''
  }
}

export function saveNotionDbRows(text: string): void {
  try {
    if (text) localStorage.setItem(DB_ROWS_KEY, text)
    else localStorage.removeItem(DB_ROWS_KEY)
  } catch {
    /* 忽略 */
  }
}

// ================= 主数据库兜底 + 页面正文 =================

/**
 * 解析实际使用的数据库 id：优先默认库；未配置时自动用主数据库（第一个可访问数据库）。
 * 返回空串 = 工作区无可用数据库（写入将失败降级为仅本地）。
 * 主数据库网络查找结果带 TTL 缓存（提速，避免每次保存都重复搜索）。
 */
const MAIN_DB_TTL_MS = 5 * 60 * 1000
let mainDbCache: { id: string; expire: number } | null = null

export async function resolveMainDatabaseId(
  token: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  const configured = loadNotionDbId()
  if (configured) return configured
  if (!token.trim()) return ''
  if (mainDbCache && mainDbCache.expire > Date.now()) return mainDbCache.id
  const list = await fetchNotionDatabases(token, { limit: 1, fetchImpl })
  const id = list[0]?.id || ''
  // 只缓存非空结果（空=未配置/无库，每次重试；也避免测试/运行时污染）
  if (id) mainDbCache = { id, expire: Date.now() + MAIN_DB_TTL_MS }
  return id
}

/** 清空 Notion 内存缓存（schema/主库），供测试使用 */
export function resetNotionCaches(): void {
  mainDbCache = null
  SCHEMA_CACHE.clear()
}

/**
 * 分页拉取全部可访问页面（title + lastEdited，不含正文），供知识库自动拉取/删除对账。
 * complete=false 表示达到 limit 上限、可能未拉完（此时不做删除对账，避免误删）。
 */
export async function listNotionPagesAll(
  token: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ pages: NotionSearchResult[]; complete: boolean }> {
  const { limit = 100, fetchImpl } = opts
  const out: NotionSearchResult[] = []
  if (!token.trim()) return { pages: [], complete: true }
  let cursor: string | null = null
  try {
    while (out.length < limit) {
      const body: Record<string, unknown> = {
        query: '',
        page_size: Math.min(100, limit - out.length),
        ...(cursor ? { start_cursor: cursor } : {})
      }
      const data = await notionRequest<{
        results?: unknown[]
        has_more?: boolean
        next_cursor?: string | null
      }>('search', { method: 'POST', body, token, fetchImpl })
      out.push(...parseSearchResponse(data).filter((r) => r.type === 'page'))
      if (!data.has_more || !data.next_cursor) break
      cursor = data.next_cursor
    }
  } catch {
    /* 失败时返回已拿到的部分 */
  }
  return { pages: out, complete: out.length < limit }
}

/**
 * 拉取页面正文纯文本（分页拉全，按 maxChars 截断）。
 * 返回 string：成功（可能为空串=页面真空）；返回 null：读取失败（网络/API 错误）。
 * ——区分「真空」与「读取失败」，供备份同步避免读失败时用本机覆盖云端。
 */
export async function fetchNotionPageText(
  token: string,
  pageId: string,
  fetchImpl?: typeof fetch,
  maxChars = 15000
): Promise<string | null> {
  if (!token.trim() || !pageId) return ''
  try {
    const lines: string[] = []
    let cursor: string | null = null
    while (true) {
      const path: string = cursor
        ? `blocks/${pageId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `blocks/${pageId}/children?page_size=100`
      const data = await notionRequest<{
        results?: unknown[]
        next_cursor?: string | null
      }>(path, { token, fetchImpl })
      lines.push(...parseBlocks(data))
      if (!data.next_cursor) break
      cursor = data.next_cursor
    }
    return lines.join('\n').slice(0, maxChars)
  } catch {
    return null // 读取失败（页面不存在/网络/API 错误）
  }
}
