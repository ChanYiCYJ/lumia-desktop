import { useState, useEffect, useRef, memo, lazy, Suspense, Component, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { TypeWriter } from './Spinner'
import { fetchWebpage, searchWithCache } from '../lib/search'
import { loadSearchSpeed, loadSearchDepth } from '../lib/chatSettings'
import { useToast } from '../lib/toast'
import { SettingsTab, type AgentSettingsProps } from './SettingsTab'
import { Live2DStage } from './Live2DStage'
import { saveKbNotes, downloadText, deriveEntryTitle, reorderKbEntries } from '../lib/kb'
import {
  loadKbStoreMode,
  saveKbEntrySmart,
  queueKbSync,
  deleteKbEntrySmart,
  restoreKbSnapshot,
  hasKbSnapshot,
  resolveKbStore,
  subscribeKbSync,
  autoBackfillLocalToNotion,
  pullNotionPagesToKb,
  migrateLocalKbToRoot,
  moveKbEntry,
  type KbSyncStatus
} from '../lib/kbStore'
import { hasNotionCfg } from '../lib/notion'
import { ConfirmDialog } from './ConfirmDialog'
import { NotionIcon } from './ui'
import { KbPageTree } from './KbPageTree'

// Notion 式块编辑器（懒加载：仅打开 KB 编辑 tab 时才拉取 BlockNote chunk，控制首屏体积）
const KbBlockEditor = lazy(() =>
  import('./KbBlockEditor').then((m) => ({ default: m.KbBlockEditor }))
)

/**
 * 编辑器错误边界：BlockNote 异常时降级为纯文本输入，避免整个 Agent 面板崩溃。
 * 只降级编辑区，其余知识库功能（列表/同步/迁移）仍可用。
 */
class KbEditorBoundary extends Component<
  {
    fallbackValue: string
    onFallbackChange: (v: string) => void
    children: ReactNode
  },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    if (this.state.hasError) {
      return (
        <textarea
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none"
          value={this.props.fallbackValue}
          onChange={(e) => this.props.onFallbackChange(e.target.value)}
          placeholder="编辑器异常，已降级为纯文本编辑"
        />
      )
    }
    return this.props.children
  }
}

// ===== Types =====
interface KbEntry {
  id: string
  name: string
  content: string
  createdAt: number
  /** 已同步到的 Notion 页面 id（双向删除/更新使用） */
  notionId?: string
  /** 最近一次成功同步到 Notion 的时间戳 */
  notionSyncedAt?: number
  /** Content access 根页面 id（1 根=整个知识库，≥2 根=按根分类） */
  notionRootId?: string
  /** Content access 根页面标题（分类组名） */
  notionRootName?: string
  /** 父页面 id（子页面有值；用于子页面树嵌套） */
  notionParentId?: string
  /** 父页面标题 */
  notionParentName?: string
  /** 本地父条目 id（未同步页面的父子关系） */
  parentId?: string
  /** 本地排序序号（页面树同级重排用） */
  order?: number
  /** 手动重命名后锁定标题（正文 H1 变化不再覆盖 name） */
  titleLocked?: boolean
}

const KB_KEY = 'kimo_kb_entries'

/** 文章 Markdown 渲染（memo 化）：articleMd 大文本未变化时跳过 ReactMarkdown+GFM 重复解析 */
const PanelMarkdown = memo(function PanelMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-body kimo-panel">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
})
/** Agent 面板 tab 记忆（刷新后恢复上次所在 tab，如停留在 Live2D 刷新不会跳回知识库） */
const AGENT_TAB_KEY = (pageId: number) => `kimo_ai_agent_tab_${pageId}`
const AGENT_TABS = ['web', 'kb', 'edit', 'settings', 'live2d'] as const
type AgentTab = (typeof AGENT_TABS)[number]
function loadAgentTab(pageId: number): AgentTab | null {
  try {
    const s = localStorage.getItem(AGENT_TAB_KEY(pageId))
    if (s && (AGENT_TABS as readonly string[]).includes(s)) return s as AgentTab
  } catch {}
  return null
}
function saveAgentTab(pageId: number, tab: AgentTab): void {
  try {
    localStorage.setItem(AGENT_TAB_KEY(pageId), tab)
  } catch {}
}

function loadEntries(): KbEntry[] {
  try {
    const r = localStorage.getItem(KB_KEY)
    if (r) return JSON.parse(r)
  } catch {}
  try {
    const prompts = JSON.parse(localStorage.getItem('kimo_agent_prompts') || '[]')
    const notes = JSON.parse(localStorage.getItem('kimo_kb_notes') || '[]')
    const merged: KbEntry[] = [
      ...prompts.map((p: Record<string, unknown>) => ({
        id: 'p_' + p.createdAt,
        name: (p.name as string) || '',
        content: p.content as string,
        createdAt: p.createdAt as number
      })),
      ...notes.map((n: Record<string, unknown>) => ({
        id: n.id as string,
        name: (n.title as string) || '',
        content: n.content as string,
        createdAt: n.createdAt as number
      }))
    ]
    if (merged.length) {
      localStorage.setItem(KB_KEY, JSON.stringify(merged))
      localStorage.removeItem('kimo_agent_prompts')
    }
    return merged
  } catch {
    return []
  }
}
function persist(e: KbEntry[]) {
  try {
    localStorage.setItem(KB_KEY, JSON.stringify(e))
  } catch {}
}

export function AgentPanel({
  initUrl,
  initTab,
  initEditContent,
  lastAssistantContent,
  pageId,
  onKbChanged,
  settings,
  kbOpen,
  onKbOpenConsumed,
  searchNonce,
  live2dOn,
  onTabChange,
  allowWebAutoDetect
}: {
  onClose: () => void
  initUrl?: string
  initTab?: 'web' | 'kb' | 'edit' | 'settings' | 'live2d'
  initEditContent?: string
  lastAssistantContent?: string
  pageId: number
  onKbChanged?: () => void
  settings?: AgentSettingsProps
  /** Live2D 开关（由 AIChat「/」弹窗控制；开启才显示 Live2D tab） */
  live2dOn?: boolean
  kbOpen?: {
    nonce: number
    entry: { id: string; name: string; content: string; createdAt: number }
  }
  onKbOpenConsumed?: () => void
  /** 卡片点击后递增，用于强制重新触发浏览 */
  searchNonce?: number
  /** tab 变化通知（AIChat 同步 agentTab，配合持久化让刷新后回到上次所在页） */
  onTabChange?: (t: AgentTab) => void
  /** 浏览 tab 自动检测（AI 回复含 URL 时自动切到 View）——仅 Deep 模式开启；auto/fast 不自动跳转 View */
  allowWebAutoDetect?: boolean
}) {
  // tab 记忆：优先 AI 工具调用指定的 tab；否则恢复上次所在 tab（刷新不丢，如停留 Live2D）；否则默认知识库
  const [tab, setTab] = useState<AgentTab>(
    () => initTab || (initUrl ? 'web' : loadAgentTab(pageId) || 'live2d')
  )
  // 每次切 tab 都持久化 + 通知 AIChat 同步 agentTab（刷新后回到上次所在页，含 Live2D）
  const onTabChangeRef = useRef(onTabChange)
  onTabChangeRef.current = onTabChange
  useEffect(() => {
    saveAgentTab(pageId, tab)
    onTabChangeRef.current?.(tab)
  }, [tab, pageId])
  const [webUrl, setWebUrl] = useState(initUrl || '')
  const [webLoading, setWebLoading] = useState(false)
  const [webContent, setWebContent] = useState('')
  /** 浏览失败/超时的提示（区别于空态占位） */
  const [webError, setWebError] = useState('')
  /** 记录当前正在执行的浏览关键词，防止陈旧轮询覆盖新浏览 */
  const activeBrowseRef = useRef('')
  /** 切 tab / 组件卸载时取消进行中的浏览轮询（避免后台空转写状态） */
  useEffect(() => {
    return () => {
      activeBrowseRef.current = ''
    }
  }, [tab, pageId])
  /** AI 综合筛选后生成的 markdown 文章（含图片/分节/来源） */
  const [articleMd, setArticleMd] = useState('')
  const [articleLoading, setArticleLoading] = useState(false)
  /** 本次结果是否来自历史缓存 */
  const [, setFromCache] = useState(false)
  const [mdContent, setMdContent] = useState(initEditContent || '')
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()

  // KB
  const [entries, setEntries] = useState<KbEntry[]>(loadEntries)
  /** 知识条目本地搜索 */
  const [entrySearch, setEntrySearch] = useState('')
  /** 底部操作胶囊面板（展开 新建/搜索/导入/多选操作） */
  const [kbPanelOpen, setKbPanelOpen] = useState(false)
  /** 多选搜索输入框（默认收起） */
  const [multiSearchOpen, setMultiSearchOpen] = useState(false)
  /** 数据操作保护：友好确认弹窗状态（替代 window.confirm） */
  const [confirm, setConfirm] = useState<{
    title: string
    message?: string
    danger?: boolean
    confirmText?: string
    onConfirm: () => void
  } | null>(null)
  const [draftWordCount, setDraftWordCount] = useState(0)
  const [draftSaved, setDraftSaved] = useState(true)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftContentRef = useRef('')
  const draftKey = 'kimo_editor_draft'

  // 恢复草稿 + beforeunload 防丢失
  useEffect(() => {
    try {
      const d = localStorage.getItem(draftKey)
      if (d && !mdContent) setMdContent(d)
    } catch {}
    const onBefore = () => {
      try {
        if (draftContentRef.current.trim()) localStorage.setItem(draftKey, draftContentRef.current)
      } catch {}
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [])

  // 同步 mdContent 到 ref（避免 beforeunload 重复注册）
  useEffect(() => {
    draftContentRef.current = mdContent
  }, [mdContent])

  // 自动保存草稿（1.5s 防抖）
  useEffect(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    setDraftSaved(false)
    setDraftWordCount(mdContent.replace(/\s/g, '').length)
    draftTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, mdContent)
      } catch {}
      setDraftSaved(true)
    }, 1500)
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
    }
  }, [mdContent])
  const [activeEntry, setActiveEntry] = useState<KbEntry | null>(null)
  /** 正在拖拽移动的条目 id（树内显示 loading） */
  const [movingId, setMovingId] = useState<string | null>(null)
  /** 新建条目的父页面（子页面）：在编辑器头部选择，留空=顶层页面 */
  const [draftParentId, setDraftParentId] = useState<string>('')
  /** Notion 同步状态（头部「同步中…/已连接」） */
  const [syncStatus, setSyncStatus] = useState<KbSyncStatus>({
    state: 'idle'
  })

  /** 父页面折叠状态（子页面树展开/收起） */
  const [collapsedPages, setCollapsedPages] = useState<Set<string>>(new Set())
  const toggleCollapsePage = (id: string) => {
    setCollapsedPages((prev) => {
      const nx = new Set(prev)
      if (nx.has(id)) nx.delete(id)
      else nx.add(id)
      return nx
    })
  }

  const [showExportMenu, setShowExportMenu] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  // Auto-detect（仅在面板已挂载后、lastAssistantContent 变化时触发；跳过首挂载，避免刷新恢复时覆盖用户所在 tab，如 Live2D 刷新后跳到编辑器）
  // 只对「AI 给了网页链接」自动切到浏览页；代码块不再自动切编辑器——编辑器只由明确的 [EDIT:] 指令打开（AIChat 通过 initEditContent/initTab 控制），避免 AI 普通回复带代码块就把用户从 Live2D 等 tab 切走
  const autoDetectFirst = useRef(true)
  useEffect(() => {
    if (autoDetectFirst.current) {
      autoDetectFirst.current = false
      return
    }
    if (!lastAssistantContent) return
    if (!allowWebAutoDetect) return
    const u = lastAssistantContent.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/)
    if (u) {
      setWebUrl(u[0])
      setTab('web')
    }
  }, [lastAssistantContent, allowWebAutoDetect])

  // 响应 AI 工具调用：切换 tab / 填入编辑内容（面板已挂载时也生效）
  useEffect(() => {
    if (initTab) setTab(initTab)
    if (initEditContent != null) {
      setMdContent(initEditContent)
      setActiveEntry(null)
    }
  }, [initTab, initEditContent])

  // AI 创建/编辑知识库：AIChat 已通过 kb.ts 写入存储，这里仅展示到编辑器并刷新列表
  useEffect(() => {
    if (!kbOpen) return
    setEntries(loadEntries())
    const { entry } = kbOpen
    if (entry && (entry.name.trim() || entry.content.trim())) {
      setActiveEntry({
        id: entry.id,
        name: entry.name,
        content: entry.content,
        createdAt: entry.createdAt
      })
      setMdContent(entry.content)
      setTab('edit')
    }
    onKbOpenConsumed?.()
  }, [kbOpen])

  // Notion 自动同步：订阅同步状态（头部「同步中…/已连接」）+ 后台回填后刷新网格
  useEffect(() => subscribeKbSync(setSyncStatus), [])
  useEffect(() => {
    const onEntriesChanged = () => {
      const list = loadEntries()
      setEntries(list)
      // 同步回填的 notionId/meta 到当前编辑条目（避免后续同步快照仍是「无 notionId」旧状态）
      setActiveEntry((cur) => {
        if (!cur) return cur
        const fresh = list.find((x) => x.id === cur.id)
        return fresh ? { ...cur, ...fresh } : cur
      })
    }
    window.addEventListener('kimo:kb:entries-changed', onEntriesChanged)
    return () => window.removeEventListener('kimo:kb:entries-changed', onEntriesChanged)
  }, [])
  // 打开知识库 tab：自动拉取 Notion 页面为卡片（防抖 + 后台不阻塞）+ 首次自动回填本地未同步条目
  const backfillOnce = useRef(false)
  useEffect(() => {
    if (tab !== 'kb' || !hasNotionCfg()) return
    const t = setTimeout(() => {
      void pullNotionPagesToKb().finally(() => {
        setEntries(loadEntries())
      })
      if (!backfillOnce.current) {
        backfillOnce.current = true
        autoBackfillLocalToNotion()
      }
    }, 800)
    return () => clearTimeout(t)
  }, [tab])

  // Sync entries
  useEffect(() => {
    saveKbNotes(
      entries.map((e) => ({
        id: e.id,
        title: e.name,
        content: e.content,
        createdAt: e.createdAt
      }))
    )
  }, [entries])

  // Close export menu
  useEffect(() => {
    if (!showExportMenu) return
    const h = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node))
        setShowExportMenu(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showExportMenu])

  // ---- Drag: document-level ----
  const dc = useRef(0)
  useEffect(() => {
    const onE = (e: DragEvent) => {
      e.preventDefault()
      dc.current++
      if (dc.current === 1) setDragOver(true)
    }
    const onO = (e: DragEvent) => {
      e.preventDefault()
    }
    const onL = () => {
      dc.current--
      if (dc.current <= 0) {
        dc.current = 0
        setDragOver(false)
      }
    }
    const onD = (e: DragEvent) => {
      e.preventDefault()
      dc.current = 0
      setDragOver(false)
      const f = e.dataTransfer?.files?.[0]
      if (!f) return
      const r = new FileReader()
      r.onload = () => {
        setMdContent((p) => (p ? p + '\n\n' : '') + String(r.result || ''))
        setTab('edit')
      }
      r.readAsText(f)
    }
    document.addEventListener('dragenter', onE)
    document.addEventListener('dragover', onO)
    document.addEventListener('dragleave', onL)
    document.addEventListener('drop', onD)
    return () => {
      document.removeEventListener('dragenter', onE)
      document.removeEventListener('dragover', onO)
      document.removeEventListener('dragleave', onL)
      document.removeEventListener('drop', onD)
    }
  }, [])

  // ---- Entry CRUD ----
  // 新建条目：内容非空时创建（「存为知识」按钮已由自动保存取代）
  const createEntryFromContent = (content: string, parentId?: string): KbEntry => {
    const trimmed = content.trim()
    const parent = parentId ? entries.find((e) => e.id === parentId) : undefined
    const e: KbEntry = {
      id: 'e_' + Date.now(),
      name: deriveEntryTitle(trimmed), // 无独立标题框：H1 优先，否则首行前 30 字
      content: trimmed,
      createdAt: Date.now(),
      // 子页面：继承父的层级（父已同步 → notionParentId 关联 Notion；否则 parentId 本地关联）
      ...(parent?.notionId
        ? {
            notionParentId: parent.notionId,
            notionParentName: parent.name,
            notionRootId: parent.notionRootId || parent.notionId,
            notionRootName: parent.notionRootName || parent.name
          }
        : parent
          ? { parentId: parent.id }
          : {})
    }
    setEntries((prev) => {
      const nx = [e, ...prev]
      persist(nx)
      saveKbNotes(
        nx.map((x) => ({
          id: x.id,
          title: x.name,
          content: x.content,
          createdAt: x.createdAt
        }))
      )
      return nx
    })
    onKbChanged?.()
    // 配置 Notion 时入队后台同步到云端（防抖合并 + 串行化，不阻塞编辑）
    queueKbSync(e)
    return e
  }
  // 新条目自动保存：内容非空且尚未创建时，防抖 1.2s 自动创建为知识条目
  useEffect(() => {
    if (activeEntry || !mdContent.trim()) return
    const t = setTimeout(() => {
      // 内容与已有条目完全一致时（如刷新后恢复草稿），只打开不重复创建
      const trimmed = mdContent.trim()
      const existing = entries.find((e) => e.content === trimmed)
      if (existing) {
        setActiveEntry(existing)
        return
      }
      const e = createEntryFromContent(mdContent, draftParentId || undefined)
      setActiveEntry(e)
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mdContent, activeEntry])
  // ---- 页面树条目 ----
  /** 已连接 Notion：树只显示 Notion 页面；未连接：显示本机页面（本地也是页面树） */
  const treeEntries = (hasNotionCfg() ? entries.filter((e) => e.notionId) : entries).filter(
    (entry) =>
      !entrySearch.trim() ||
      entry.name.toLowerCase().includes(entrySearch.toLowerCase()) ||
      entry.content.toLowerCase().includes(entrySearch.toLowerCase())
  )
  /** 本机未同步条数（已连接时顶部提示 + 迁移入口） */
  const localUnsyncedCount = entries.filter((e) => !e.notionId).length
  /** 撤销：恢复最近一次写操作前的快照 */
  const handleUndo = () => {
    const restored = restoreKbSnapshot()
    if (!restored) {
      toast('没有可撤销的记录')
      return
    }
    setEntries(restored)
    onKbChanged?.()
    toast('已恢复最近版本')
  }
  /** 一键迁移：本机未同步条目 → Notion「知识库」根页面（页面根目录下） */
  const [migrating, setMigrating] = useState(false)
  const handleMigrateToRoot = async () => {
    if (migrating) return
    setMigrating(true)
    const res = await migrateLocalKbToRoot()
    setMigrating(false)
    setEntries(loadEntries())
    if (res.errors.length) {
      toast(
        res.created > 0
          ? `已迁移 ${res.created} 条，${res.errors.length} 条失败`
          : `迁移失败：${res.errors[0]}`
      )
    } else if (res.created > 0) {
      toast(`已迁移 ${res.created} 条到「知识库」根页面`)
    } else {
      toast(res.total === 0 ? '没有需要迁移的条目' : '条目均已同步到知识库')
    }
  }
  const updateEntry = (content: string) => {
    if (!activeEntry) return
    // 标题：手动重命名（titleLocked）后不再随正文推导；否则 H1 变化 → 标题变化 → 同步 Notion
    const name = activeEntry.titleLocked
      ? activeEntry.name
      : deriveEntryTitle(content, activeEntry.name)
    const u = { ...activeEntry, content, name }
    setActiveEntry(u)
    setEntries((prev) => {
      const nx = prev.map((e) => (e.id === activeEntry.id ? u : e))
      persist(nx)
      saveKbNotes(
        nx.map((x) => ({
          id: x.id,
          title: x.name,
          content: x.content,
          createdAt: x.createdAt
        }))
      )
      return nx
    })
    onKbChanged?.()
    // 配置 Notion 时入队后台同步更新云端（镜像覆盖，不阻塞编辑）
    queueKbSync(u)
  }
  // ---- 页面树：打开 / 重命名 / 删除 / 重排 / 移动 ----
  /** 点击树行 → 打开该页编辑 */
  const openEntryFromTree = (entry: KbEntry) => {
    setActiveEntry(entry)
    setMdContent('')
    setTab('edit')
  }
  /** 重命名：锁定标题（titleLocked）并同步 Notion 页面标题 */
  const handleRename = (id: string, name: string) => {
    const t = name.trim()
    if (!t) return
    const nx = entries.map((e) => (e.id === id ? { ...e, name: t, titleLocked: true } : e))
    setEntries(nx)
    persist(nx)
    saveKbNotes(
      nx.map((x) => ({
        id: x.id,
        title: x.name,
        content: x.content,
        createdAt: x.createdAt
      }))
    )
    onKbChanged?.()
    const u = nx.find((e) => e.id === id)
    if (u) queueKbSync(u)
  }
  /** 恢复自动标题：清除 titleLocked，标题回落到正文推导 */
  const handleRestoreAutoTitle = (id: string) => {
    const nx = entries.map((e) => {
      if (e.id !== id) return e
      return {
        ...e,
        name: deriveEntryTitle(e.content, e.name),
        titleLocked: false
      }
    })
    setEntries(nx)
    persist(nx)
    saveKbNotes(
      nx.map((x) => ({
        id: x.id,
        title: x.name,
        content: x.content,
        createdAt: x.createdAt
      }))
    )
    onKbChanged?.()
    const u = nx.find((e) => e.id === id)
    if (u) queueKbSync(u)
  }
  /** 删除单个页面（本机 + Notion 双向） */
  const handleDeleteEntry = (entry: KbEntry) => {
    const willDeleteNotion = !!entry.notionId && resolveKbStore() === 'notion'
    setConfirm({
      title: `删除「${entry.name}」？`,
      message: willDeleteNotion
        ? '该页面已同步到 Notion，将同时删除 Notion 页面（Notion 侧不可恢复）。'
        : '删除后可在「撤销」中恢复（本机保留最近快照）。',
      danger: true,
      confirmText: '删除',
      onConfirm: () => {
        setConfirm(null)
        void (async () => {
          await deleteKbEntrySmart({ id: entry.id })
          setEntries(loadEntries())
          if (activeEntry?.id === entry.id) {
            setActiveEntry(null)
            setMdContent('')
            setTab('kb')
          }
          onKbChanged?.()
          toast('已删除 1 条')
        })()
      }
    })
  }
  /** 同级重排（本地 order，不推 Notion——API 无法设置顺序） */
  const handleReorder = (parentKey: string, orderedIds: string[]) => {
    const nx = reorderKbEntries(entries, parentKey, orderedIds)
    setEntries(nx)
    persist(nx)
    saveKbNotes(
      nx.map((x) => ({
        id: x.id,
        title: x.name,
        content: x.content,
        createdAt: x.createdAt
      }))
    )
    onKbChanged?.()
  }
  /** 改父移动：本地重排 + 已同步页面在 Notion「重建+删旧」 */
  const handleMove = async (id: string, parentId?: string) => {
    if (movingId) return
    setMovingId(id)
    const res = await moveKbEntry({ id, newParentId: parentId })
    setMovingId(null)
    setEntries(loadEntries())
    if (res.error) toast(res.error)
    else toast(res.recreated ? '已移动（Notion 侧已重建页面）' : '已移动')
    onKbChanged?.()
  }
  // ---- 编辑器：清空 / 返回 ----
  const clearEditor = () => {
    const hasContent = (mdContent || '').trim() || (activeEntry?.content || '').trim()
    if (!hasContent) return
    setConfirm({
      title: '清空当前编辑内容？',
      message: '清空后可在「撤销」中恢复（本机保留最近快照）。',
      danger: true,
      confirmText: '清空',
      onConfirm: () => {
        setConfirm(null)
        if (activeEntry) updateEntry('')
        else setMdContent('')
      }
    })
  }
  /** 返回知识库列表：尚未落库的新内容先自动保存为新条目 */
  const goBackToKb = () => {
    if (!activeEntry && mdContent.trim()) {
      const e = createEntryFromContent(mdContent, draftParentId || undefined)
      setActiveEntry(e)
    }
    setActiveEntry(null)
    setMdContent('')
    setDraftParentId('')
    setTab('kb')
  }
  /** 从某卡片「＋子页」打开新建子页编辑器（预选父条目） */
  const startNewChild = (parent: KbEntry) => {
    setDraftParentId(parent.id)
    setActiveEntry(null)
    setMdContent('')
    setTab('edit')
  }

  // ---- Export/Import ----
  /** 导出全部条目（页面树无多选） */
  const exportTarget = () => entries
  const exportJSON = () => {
    const list = exportTarget()
    downloadText(
      'kb-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify({ app: 'kimo-kb', version: 1, entries: list }, null, 2)
    )
    setShowExportMenu(false)
    toast(`已导出 ${list.length} 条（JSON）`)
  }
  const exportMD = () => {
    const list = exportTarget()
    downloadText(
      'kb-' + new Date().toISOString().slice(0, 10) + '.md',
      list.map((e) => '# ' + e.name + '\n\n' + e.content + '\n\n---').join('\n\n')
    )
    setShowExportMenu(false)
    toast(`已导出 ${list.length} 条（Markdown）`)
  }
  /** 导入 JSON（支持多文件选择） */
  const importJSON = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = ev.target.files ? Array.from(ev.target.files) : []
    if (!files.length) return
    const existing = new Set(entries.map((e) => e.id))
    const now = Date.now()
    const cleaned: KbEntry[] = []
    let pending = files.length
    files.forEach((f) => {
      const r = new FileReader()
      r.onload = () => {
        try {
          const d = JSON.parse(String(r.result || ''))
          const arr: KbEntry[] = Array.isArray(d.entries) ? d.entries : Array.isArray(d) ? d : []
          for (const raw of arr) {
            if (!raw || typeof raw !== 'object') continue
            const name = String(raw.name || '').trim()
            const content = String(raw.content || '').trim()
            if (!name && !content) continue
            const createdAt =
              typeof raw.createdAt === 'number'
                ? raw.createdAt
                : Date.parse(String(raw.createdAt || '')) || now
            let id = String(raw.id ?? '').trim()
            if (!id || existing.has(id)) {
              id = `imp_${now}_${cleaned.length}_${Math.random().toString(36).slice(2, 7)}`
            }
            existing.add(id)
            cleaned.push({ id, name: name || '未命名', content, createdAt })
          }
        } catch {
          /* 单文件解析失败则跳过 */
        }
      }
      r.onloadend = () => {
        pending--
        if (pending > 0) return
        ev.target.value = ''
        if (!cleaned.length) {
          toast('未找到有效条目')
          return
        }
        const nx = [...cleaned, ...entries]
        setEntries(nx)
        persist(nx)
        saveKbNotes(
          nx.map((x) => ({
            id: x.id,
            title: x.name,
            content: x.content,
            createdAt: x.createdAt
          }))
        )
        onKbChanged?.()
        toast(`已导入 ${cleaned.length} 条（JSON）`)
      }
      r.readAsText(f)
    })
  }
  /** 导入 Markdown（单文件：标题由正文推导——H1 优先，否则首行；空则用文件名） */
  const importMarkdown = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      ev.target.value = ''
      const content = String(r.result || '').trim()
      if (!content) {
        toast('文件为空')
        return
      }
      const base = (f.name.replace(/\.(md|markdown|txt)$/i, '') || '未命名').trim()
      const entry: KbEntry = {
        id: 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: deriveEntryTitle(content, base || '未命名'),
        content,
        createdAt: Date.now()
      }
      const nx = [entry, ...entries]
      setEntries(nx)
      persist(nx)
      saveKbNotes(
        nx.map((x) => ({
          id: x.id,
          title: x.name,
          content: x.content,
          createdAt: x.createdAt
        }))
      )
      onKbChanged?.()
      toast('已导入 Markdown')
    }
    r.readAsText(f)
  }

  // ---- Browse（带历史缓存 + 增量展示：先出搜索结果，AI 文章就绪后原地补上）----
  // force=true 时强制刷新（绕过缓存重新搜索 + 生成，保证数据实时更新）
  const browse = async (q?: string, force = false) => {
    const u = (q ?? webUrl).trim()
    if (!u) return
    activeBrowseRef.current = u
    setWebContent('')
    setWebError('')
    setWebLoading(true)
    setArticleMd('')
    setArticleLoading(false)
    // 关键词搜索（复用缓存；生成中时轮询等待，保证「加载页不提前消失」）
    const runKeyword = async (kw: string, firstForce = false) => {
      setWebUrl(kw)
      // 按搜索速度/深度调整来源数与正文长度：Fast 精简、deep 加量
      const speed = loadSearchSpeed()
      const depth = loadSearchDepth()
      const maxSources = speed === 'fast' ? 3 : depth === 'deep' ? 6 : 4
      const perSourceChars = speed === 'fast' ? 1400 : depth === 'deep' ? 2600 : 2200
      const opts = { maxSources, perSourceChars }
      // 首次调用：firstForce 时绕过缓存强制生成；后续轮询读缓存（loading 标记防并发重复生成）
      let r = await searchWithCache(kw, { ...opts, force: firstForce })
      // 阶段1：等待拿到搜索结果内容（最多约 55s；期间保持加载页）
      if (r.loading && !r.content) {
        const deadline = Date.now() + 55_000
        while (Date.now() < deadline && r.loading && !r.content) {
          await new Promise((res) => setTimeout(res, 700))
          if (activeBrowseRef.current !== kw) return
          r = await searchWithCache(kw, opts)
        }
      }
      if (activeBrowseRef.current !== kw) return
      // 阶段1 结束：能展示就立刻展示（含生成中的文章骨架），不再卡在加载页
      setFromCache(!!r.cached)
      if (r.content) {
        setWebContent(r.content)
        setArticleMd(r.article || '')
        setArticleLoading(r.loading || false)
      } else if (r.loading) {
        // 仍无内容但还在生成：视为超时，给重试而非误导性的空态
        setWebError('搜索较慢，请稍后点击重试')
        setArticleLoading(false)
      } else {
        // 搜索完成但无结果：给出明确提示（区别于从未搜索过的空态）
        setWebContent('')
        setWebError('未找到相关结果，请换一个关键词试试')
        setArticleLoading(false)
      }
      // 阶段2：内容已展示、文章仍在生成 → 继续等文章，就绪后原地补上（不闪退加载态）
      if (r.content && r.loading) {
        const deadline = Date.now() + 90_000
        let nr = r
        while (Date.now() < deadline && nr.loading) {
          await new Promise((res) => setTimeout(res, 800))
          if (activeBrowseRef.current !== kw) return
          nr = await searchWithCache(kw, opts)
        }
        if (activeBrowseRef.current !== kw) return
        setArticleMd(nr.article || '')
        setArticleLoading(false)
        setWebError(nr.loading ? '文章生成较慢，可稍后重试' : '')
      }
    }
    try {
      if (/^https?:\/\//i.test(u)) {
        // 搜索引擎 URL（如 google/bing/duckduckgo）→ 提取 q 参数转关键词搜索
        const lower = u.toLowerCase()
        if (
          lower.includes('google.') ||
          lower.includes('bing.com') ||
          lower.includes('duckduckgo') ||
          lower.includes('baidu.com')
        ) {
          try {
            const qp = new URL(u).searchParams.get('q')
            if (qp) {
              await runKeyword(qp, force)
              return
            }
          } catch {}
        }
        setWebUrl(u)
        const text = await fetchWebpage(u)
        if (activeBrowseRef.current !== u) return
        if (text) {
          setWebContent(text)
        } else {
          // URL 抓取失败（如搜索引擎 CORS 拦截）时回退为关键词搜索
          let q2 = u
          try {
            const url = new URL(u)
            const qp = url.searchParams.get('q')
            if (qp) q2 = qp
            else q2 = url.hostname.replace(/^www\./i, '')
          } catch {
            q2 = u
              .replace(/^https?:\/\//i, '')
              .replace(/^www\./i, '')
              .replace(/\/.*$/, '')
          }
          await runKeyword(q2, force)
        }
      } else if (/^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+\.?$/.test(u)) {
        // 纯域名（不含空格）才按网址抓取，否则按关键词搜索
        const full = 'https://' + u
        setWebUrl(full)
        const text = await fetchWebpage(full)
        if (activeBrowseRef.current !== full) return
        setWebContent(text || '')
        if (!text) setWebError('无法获取内容，请点击重试')
      } else {
        // 关键词搜索：抓取多个结果正文 + AI 综合文章，带历史缓存
        await runKeyword(u, force)
      }
    } catch {
      if (activeBrowseRef.current !== u) return
      setWebContent('')
      setWebError('搜索失败，请稍后重试')
    } finally {
      if (activeBrowseRef.current === u) setWebLoading(false)
    }
  }

  // AI 触发搜索/浏览时自动执行（[SEARCH:] / [BROWSE:] / 卡片点击）
  useEffect(() => {
    if (initUrl) {
      setTab('web')
      setWebUrl(initUrl)
      setWebContent('')
      browse(initUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initUrl, searchNonce])

  /** 保存 AI 文章到知识库（标题由正文推导，缺省用搜索词）；配置 Notion 时双写到云端 */
  const saveArticle = () => {
    if (!articleMd) return
    const title = deriveEntryTitle(articleMd, webUrl || '浏览文章')
    void saveKbEntrySmart({
      title,
      content: articleMd,
      mode: loadKbStoreMode()
    }).then((res) => {
      if (res.error) toast(res.error)
    })
    // 刷新本地条目列表，让保存的条目立刻出现在知识库
    setEntries(loadEntries())
    toast('已保存到知识库')
  }

  return (
    // 学习 Live2D 角色卡片的卡片样式：小外边距 + 大圆角 + 边框，让 Agent 面板整体浮起
    <div className="relative m-2 flex h-[calc(100%-1rem)] min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200/70 bg-white dark:border-gray-700/70 dark:bg-gray-900">
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-900/50 backdrop-blur-sm pointer-events-none">
          <div className="rounded-2xl bg-white p-6 text-center shadow-2xl dark:bg-gray-800">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">释放文件到编辑器</p>
            <p className="mt-1 text-xs text-gray-400">.md / .txt</p>
          </div>
        </div>
      )}

      {/* Header：知识库 / 浏览（主 tab，手机仅图标）；设置缩为小图标靠右 */}
      {/* Header：统一分段 tab（知识库/View/Live2D/设置），紧凑 + 选中 pop 动画；关闭走顶栏 Agent 按钮 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-2 py-2 dark:border-gray-800">
        <div className="flex min-w-0 flex-1 gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
          <button
            onClick={() => setTab('kb')}
            title="知识库"
            className={
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs font-medium transition sm:px-2 ' +
              (tab === 'kb'
                ? 'bg-white text-gray-900 shadow-sm animate-[kpop_0.18s_ease-out] dark:bg-gray-700 dark:text-gray-100'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')
            }
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
              />
            </svg>
            <span className="hidden sm:inline">知识库</span>
          </button>
          <button
            onClick={() => setTab('web')}
            title="View"
            className={
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs font-medium transition sm:px-2 ' +
              (tab === 'web'
                ? 'bg-white text-gray-900 shadow-sm animate-[kpop_0.18s_ease-out] dark:bg-gray-700 dark:text-gray-100'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')
            }
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10M12 22a15.3 15.3 0 01-4-10 15.3 15.3 0 014-10" />
            </svg>
            <span className="hidden sm:inline">View</span>
          </button>
          {/* Live2D tab 常显（不因开关隐藏）；未开启时由 Live2DStage 显示空态提示 */}
          <button
            onClick={() => setTab('live2d')}
            title="Live2D"
            className={
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs font-medium transition sm:px-2 ' +
              (tab === 'live2d'
                ? 'bg-white text-gray-900 shadow-sm animate-[kpop_0.18s_ease-out] dark:bg-gray-700 dark:text-gray-100'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')
            }
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9 9 0 100-18 9 9 0 000 18z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 10h.01M15 10h.01M9 14.5c.9.8 2.2 1.3 3 1.3s2.1-.5 3-1.3"
              />
            </svg>
            <span className="hidden sm:inline">Live2D</span>
          </button>
          {/* 设置 tab：并入统一分段，风格一致 */}
          <button
            onClick={() => setTab('settings')}
            title="设置"
            className={
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs font-medium transition sm:px-2 ' +
              (tab === 'settings'
                ? 'bg-white text-gray-900 shadow-sm animate-[kpop_0.18s_ease-out] dark:bg-gray-700 dark:text-gray-100'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')
            }
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span className="hidden sm:inline">设置</span>
          </button>
        </div>
      </div>

      {/* tab 内容切换动画：key 变化触发淡入（不遮盖其它关闭路径） */}
      <div key={tab} className="flex min-h-0 flex-1 flex-col animate-[kfade_0.22s_ease-out]">
        {/* TAB 1: Browse（美化版：搜索栏 + 结果卡片 + 来源折叠 + AI 文章） */}
        {tab === 'web' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 内容滚动区 */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* 加载中：站点默认加载页（Think Different 打字机） */}
              {webLoading && (
                <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
                  <TypeWriter
                    text="Think Different"
                    className="text-lg font-medium tracking-[0.2em] text-gray-500 dark:text-gray-400"
                  />
                  <p className="font-mono text-xs text-gray-300 dark:text-gray-600">
                    $ loading ...
                  </p>
                </div>
              )}
              {/* 空态：极简（无 logo/标题） */}
              {!webLoading && !webContent && !webError && (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <p className="text-xs text-gray-300 dark:text-gray-600">
                    在对话中搜索后，结果将显示在这里
                  </p>
                </div>
              )}
              {/* 失败/超时态：给出重试，而非误导性的空态 */}
              {!webLoading && !webContent && webError && (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{webError}</p>
                  <button
                    onClick={() => browse(webUrl, true)}
                    className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
                  >
                    重新搜索
                  </button>
                </div>
              )}
              {/* 结果态：AI 文章为主 */}
              {webContent && !webLoading && (
                <div className="space-y-2.5 p-2.5">
                  {/* AI 综合文章（主角） */}
                  {(articleMd || articleLoading) && (
                    <article className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
                      <div className="flex items-center justify-end gap-2 border-b border-gray-100 px-3.5 py-2 dark:border-gray-800">
                        {articleMd && (
                          <button
                            onClick={saveArticle}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-500 transition hover:border-gray-300 hover:text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-500 dark:hover:text-gray-200"
                          >
                            <svg
                              className="h-3 w-3"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"
                              />
                            </svg>
                            保存到知识库
                          </button>
                        )}
                      </div>
                      <div className="px-4 py-4">
                        {articleLoading ? (
                          <div className="space-y-3">
                            <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                            <div className="h-3 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                            <div className="h-3 w-11/12 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                            <div className="h-3 w-4/5 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                          </div>
                        ) : (
                          <PanelMarkdown content={articleMd} />
                        )}
                      </div>
                    </article>
                  )}
                  {/* 文章生成失败兜底：重试 */}
                  {!articleMd && !articleLoading && (
                    <button
                      onClick={() => browse(webUrl, true)}
                      className="w-full rounded-2xl border border-dashed border-gray-200 bg-white/50 px-3.5 py-2.5 text-center text-[11px] text-gray-400 transition hover:border-gray-300 hover:text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-500 dark:hover:border-gray-500 dark:hover:text-gray-300"
                    >
                      AI 文章生成失败，点击重新生成
                    </button>
                  )}
                  {/* 对话续优化提示 */}
                  {articleMd && !articleLoading && (
                    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-3 py-2.5 text-center dark:border-gray-800 dark:bg-gray-800/40">
                      <p className="text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">
                        在对话中继续提问，可让我优化这篇文章 （精简 / 改风格 / 补充细节）
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Knowledge Base（紧凑头部 + 分类 tab + 条目网格） */}
        {tab === 'kb' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 头部：Notion 连接状态 + 来源分类筛选（全部/本机/Notion） */}
            <div className="flex flex-none items-center gap-2 px-3 pt-2.5">
              {hasNotionCfg() && (
                <span
                  className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                  title={
                    syncStatus.error ||
                    '知识库与 Notion 自动双向同步（Notion 页面以卡片显示在下方）'
                  }
                >
                  <NotionIcon className="h-3 w-3 text-gray-500 dark:text-gray-400" />
                  {syncStatus.state === 'syncing'
                    ? '同步中…'
                    : syncStatus.error
                      ? '同步失败'
                      : `Notion 已连接 · ${entries.filter((e) => e.notionId).length} 条已同步`}
                </span>
              )}
              {hasNotionCfg() && entries.some((e) => !e.notionId) && (
                <button
                  onClick={handleMigrateToRoot}
                  disabled={migrating}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500 transition hover:border-gray-300 hover:text-gray-700 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:border-gray-500 dark:hover:text-gray-200"
                  title="把本机未同步条目一次性迁移到 Notion「知识库」根页面（页面根目录下）"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"
                    />
                  </svg>
                  {migrating ? '迁移中…' : '迁移到知识库'}
                </button>
              )}
              <button
                onClick={() => {
                  setActiveEntry(null)
                  setMdContent('')
                  setDraftParentId('')
                  setTab('edit')
                }}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-900 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-gray-700 active:scale-[0.98] dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                title="新建知识页面"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                </svg>
                新建页面
              </button>
            </div>
            {/* 本地未同步提示（已连接 Notion 时页面树只显示 Notion 页面） */}
            {hasNotionCfg() && localUnsyncedCount > 0 && (
              <p className="flex-none px-3 pt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                页面树仅显示 Notion 页面 · 本机 {localUnsyncedCount}{' '}
                条未同步（点上方「迁移到知识库」合并）
              </p>
            )}
            {/* Notion 式页面树 */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5 pb-16">
                <KbPageTree
                  entries={treeEntries}
                  activeId={activeEntry?.id}
                  collapsed={collapsedPages}
                  onToggleCollapse={toggleCollapsePage}
                  onOpen={openEntryFromTree}
                  onNewChild={startNewChild}
                  onRename={handleRename}
                  onRestoreAutoTitle={handleRestoreAutoTitle}
                  onDelete={handleDeleteEntry}
                  onReorder={handleReorder}
                  onMove={handleMove}
                  movingId={movingId}
                  empty={
                    hasNotionCfg()
                      ? '知识库还没有页面，点击「＋ 新建页面」开始'
                      : '暂无条目，点击「＋ 新建页面」开始'
                  }
                />
              </div>
              {/* 底部操作胶囊（类似 Live2D 切换角色）：单个胶囊 + 点击弹出操作面板 */}
              <div className="absolute inset-x-0 bottom-4 z-20 flex flex-col items-center px-3">
                {kbPanelOpen && (
                  <div className="mb-2 w-full max-w-xs animate-[kpop_0.25s_ease-out] rounded-2xl border border-gray-200 bg-white/95 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-800/95">
                    <div className="p-2">
                      {multiSearchOpen ? (
                        <>
                          {/* 搜索模式：仅显示搜索输入框 + 关闭（隐藏其他功能） */}
                          <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900">
                            <svg
                              className="h-4 w-4 shrink-0 text-gray-400"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="11" cy="11" r="8" />
                              <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                            </svg>
                            <input
                              value={entrySearch}
                              onChange={(e) => setEntrySearch(e.target.value)}
                              placeholder="搜索条目…"
                              className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200 dark:placeholder:text-gray-500"
                              autoFocus
                            />
                            <button
                              onClick={() => {
                                setEntrySearch('')
                                setMultiSearchOpen(false)
                              }}
                              title="关闭搜索"
                              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
                            >
                              <svg
                                className="h-3.5 w-3.5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <>
                            {/* 新建 + 搜索 */}
                            <button
                              onClick={() => {
                                setActiveEntry(null)
                                setMdContent('')
                                setDraftParentId('')
                                setTab('edit')
                              }}
                              title="新建知识条目"
                              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 active:scale-[0.98] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                            >
                              <svg
                                className="h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                              </svg>
                              新建知识
                            </button>
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <button
                                onClick={() => setMultiSearchOpen((v) => !v)}
                                title={multiSearchOpen ? '收起搜索' : '搜索条目'}
                                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 active:scale-[0.98] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <circle cx="11" cy="11" r="8" />
                                  <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                                </svg>
                                搜索
                              </button>
                            </div>
                          </>
                        </>
                      )}
                    </div>
                    {/* 底部：导入/导出（低调右对齐；菜单向上弹出避免手机溢出） */}
                    {!multiSearchOpen && (
                      <div className="px-2 pb-2">
                        <div className="flex items-center justify-end border-t border-gray-100 pt-1.5 dark:border-gray-800">
                          {hasKbSnapshot() && (
                            <button
                              onClick={handleUndo}
                              title="撤销（恢复最近版本快照）"
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                            >
                              <svg
                                className="h-3.5 w-3.5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"
                                />
                              </svg>
                              撤销
                            </button>
                          )}
                          <div className="relative ml-auto" ref={exportRef}>
                            <button
                              onClick={() => setShowExportMenu(!showExportMenu)}
                              title="导入 / 导出"
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                            >
                              <svg
                                className="h-3.5 w-3.5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                                />
                              </svg>
                              导入 / 导出
                            </button>
                            {showExportMenu && (
                              <div className="absolute bottom-full right-0 z-30 mb-1 max-h-[50vh] w-40 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900">
                                <button
                                  onClick={exportJSON}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                                >
                                  JSON
                                </button>
                                <button
                                  onClick={exportMD}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                                >
                                  Markdown
                                </button>
                                <div className="border-t border-gray-100 dark:border-gray-800" />
                                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800">
                                  导入 JSON
                                  <input
                                    type="file"
                                    accept=".json"
                                    multiple
                                    onChange={importJSON}
                                    className="hidden"
                                  />
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800">
                                  导入 Markdown
                                  <input
                                    type="file"
                                    accept=".md,.markdown,.txt"
                                    onChange={importMarkdown}
                                    className="hidden"
                                  />
                                </label>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* 单个胶囊按钮（无文字；点开时加号变上方向键） */}
                <button
                  onClick={() => {
                    setKbPanelOpen((v) => {
                      const nv = !v
                      if (!nv) {
                        setMultiSearchOpen(false)
                        setShowExportMenu(false)
                      }
                      return nv
                    })
                  }}
                  title="知识库操作"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-gray-200/80 bg-white/95 text-gray-500 shadow-sm backdrop-blur transition hover:border-gray-300 hover:text-gray-700 hover:shadow active:scale-95 dark:border-gray-700 dark:bg-gray-800/95 dark:text-gray-300"
                >
                  <svg
                    className={
                      'h-5 w-5 transition-transform duration-200 ' +
                      (kbPanelOpen ? 'rotate-180' : '')
                    }
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    {kbPanelOpen ? (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 15.75l7.5-7.5 7.5 7.5"
                      />
                    ) : (
                      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    )}
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: Editor（自动保存 + 返回知识库；已删除草稿/存为知识按钮） */}
        {tab === 'edit' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-2 border-b border-gray-50 px-2 py-1.5 dark:border-gray-800">
              <button
                onClick={goBackToKb}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                title="返回知识库"
                aria-label="返回知识库"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" d="M19 12H5m7-7l-7 7 7 7" />
                </svg>
              </button>
              <span className="min-w-0 truncate text-xs font-medium text-gray-600 dark:text-gray-300">
                {activeEntry ? activeEntry.name : '新建条目'}
              </span>
              {!activeEntry && mdContent.trim() && (
                <span className="ml-auto shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400 dark:bg-gray-800 dark:text-gray-500">
                  自动保存
                </span>
              )}
            </div>
            {/* 新建条目：可选父页面（子页面；仅已同步 Notion 的页面可作为父） */}
            {!activeEntry && (
              <div className="flex flex-none items-center gap-1.5 border-b border-gray-50 px-2 py-1 dark:border-gray-800">
                <span className="shrink-0 text-[10px] text-gray-400">子页</span>
                <select
                  value={draftParentId}
                  onChange={(e) => setDraftParentId(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[11px] text-gray-600 outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                >
                  <option value="">无（顶层页面）</option>
                  {entries.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <KbEditorBoundary
              fallbackValue={activeEntry ? activeEntry.content : mdContent}
              onFallbackChange={activeEntry ? updateEntry : setMdContent}
            >
              <Suspense
                fallback={
                  <div className="grid flex-1 place-items-center text-[11px] text-gray-400">
                    编辑器加载中…
                  </div>
                }
              >
                {activeEntry ? (
                  <KbBlockEditor
                    key={activeEntry.id}
                    value={activeEntry.content}
                    onChange={updateEntry}
                    placeholder="在此输入内容…（首个 H1 或首行将作为标题）"
                  />
                ) : (
                  <KbBlockEditor
                    key="new"
                    value={mdContent}
                    onChange={setMdContent}
                    placeholder="在此输入内容…（首个 H1 或首行将作为标题）"
                  />
                )}
              </Suspense>
            </KbEditorBoundary>
            <div className="flex flex-none items-center justify-between gap-2 border-t border-gray-100 px-3 py-1.5 dark:border-gray-800">
              <span className="min-w-0 truncate">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200/80 bg-white px-2.5 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  {mdContent ? `${draftWordCount} 字` : 'Markdown'}
                  {draftSaved ? (
                    <span className="flex items-center gap-0.5 font-medium text-green-600 dark:text-green-400">
                      <svg
                        className="h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      已保存
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 font-medium text-amber-500 dark:text-amber-400">
                      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                        />
                      </svg>
                      保存中
                    </span>
                  )}
                </span>
              </span>
              <div className="flex items-center gap-0.5">
                {/* 清空 */}
                <button
                  onClick={clearEditor}
                  className="grid h-7 w-7 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  title="清空"
                  aria-label="清空"
                >
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB: Live2D（AI 化身；未开启时显示空态提示） */}
        {tab === 'live2d' && <Live2DStage enabled={live2dOn} />}

        {/* TAB 4: Settings（用户设置迁入 Agent 面板） */}
        {tab === 'settings' &&
          (settings ? (
            <SettingsTab {...settings} />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-xs text-gray-400">
              设置暂不可用
            </div>
          ))}
      </div>

      {/* 数据操作保护：友好确认弹窗 */}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title || ''}
        message={confirm?.message}
        danger={confirm?.danger}
        confirmText={confirm?.confirmText}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm?.onConfirm()}
      />
    </div>
  )
}
