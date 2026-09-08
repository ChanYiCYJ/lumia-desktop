import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  rootCtx,
  serializerCtx
} from '@milkdown/core'
import {
  commonmark,
  createCodeBlockCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/preset-commonmark'
import { gfm, insertTableCommand, toggleStrikethroughCommand } from '@milkdown/preset-gfm'
import { history, redoCommand, undoCommand } from '@milkdown/plugin-history'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { clipboard } from '@milkdown/plugin-clipboard'
import { prism, prismConfig } from '@milkdown/plugin-prism'
import { upload, uploadConfig } from '@milkdown/plugin-upload'
import { callCommand } from '@milkdown/utils'
import { Slice } from '@milkdown/prose/model'
import { redoDepth, undoDepth } from '@milkdown/prose/history'
import type { CmdKey } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
// prism 语言（refractor v5 的 exports 映射为 ./lang/*.js，导入要用 refractor/<lang>）
import javascript from 'refractor/javascript'
import typescript from 'refractor/typescript'
import jsx from 'refractor/jsx'
import tsx from 'refractor/tsx'
import css from 'refractor/css'
import markup from 'refractor/markup'
import markdown from 'refractor/markdown'
import json from 'refractor/json'
import python from 'refractor/python'
import bash from 'refractor/bash'
import sql from 'refractor/sql'
import yaml from 'refractor/yaml'
import java from 'refractor/java'
import go from 'refractor/go'
import rust from 'refractor/rust'
import {
  Bold,
  Check,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Pilcrow,
  Quote,
  Redo2,
  Sparkles,
  SquareCode,
  Strikethrough,
  Table2,
  Undo2,
  X
} from 'lucide-react'
import { resolveAsset, uploadApi } from '../lib/api'
import { polishMarkdown } from '../lib/ai'
import { readingTime } from '../lib/format'

interface MdEditorProps {
  value: string
  onChange: (value: string) => void
  /** 高度：数字为固定像素；"fill" 表示填满父容器（作为 flex 子项） */
  height?: number | 'fill'
  placeholder?: string
  /** 是否显示「AI 润色」按钮（默认开启） */
  aiPolish?: boolean
  /** AI 指令生成回调（提供时在工具栏显示内联输入框） */
  aiCommand?: (prompt: string) => Promise<void>
  /** 是否显示底部状态栏（默认 true） */
  showStatusBar?: boolean
  /** 是否圆角（默认 true） */
  rounded?: boolean
}

/** 编辑器崩溃时的兜底：降级为纯文本 textarea，避免整页空白 */
class EditorBoundary extends Component<
  {
    children: ReactNode
    onFallback: (v: string) => void
    fallbackValue: string
  },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) {
      return (
        <textarea
          defaultValue={this.props.fallbackValue}
          onChange={(e) => this.props.onFallback(e.target.value)}
          className="h-full w-full resize-none p-4 font-mono text-sm outline-none"
          placeholder="编辑器加载失败，可在此直接输入 Markdown"
        />
      )
    }
    return this.props.children as ReactNode
  }
}

/** 工具栏激活态快照（由 selection / doc 变化时从 prose state 计算） */
interface ToolbarState {
  canUndo: boolean
  canRedo: boolean
  isBold: boolean
  isItalic: boolean
  isStrikethrough: boolean
  isCode: boolean
  isLink: boolean
  isBlockquote: boolean
  isBulletList: boolean
  isOrderedList: boolean
  isTaskList: boolean
  isCodeblock: boolean
  heading: 0 | 1 | 2 | 3
}

const EMPTY_TOOLBAR: ToolbarState = {
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isStrikethrough: false,
  isCode: false,
  isLink: false,
  isBlockquote: false,
  isBulletList: false,
  isOrderedList: false,
  isTaskList: false,
  isCodeblock: false,
  heading: 0
}

/** 从当前 prose state 计算工具栏激活态（mark / 块级 / 历史深度） */
function computeToolbar(ctx: Ctx): ToolbarState {
  const view = ctx.get(editorViewCtx)
  const { state } = view
  const { $from } = state.selection
  const marks = state.storedMarks || $from.marks()
  const hasMark = (name: string) => marks.some((m) => m.type.name === name)

  const node = $from.node()
  const nodeName = node.type.name
  const level = nodeName === 'heading' ? Number(node.attrs.level) || 0 : 0
  const heading = (level > 3 ? 0 : level) as 0 | 1 | 2 | 3

  let isBlockquote = nodeName === 'blockquote'
  let isBulletList = false
  let isOrderedList = false
  let isTaskList = false
  let isCodeblock = nodeName === 'code_block'
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    const name = n.type.name
    if (name === 'blockquote') isBlockquote = true
    if (name === 'bullet_list') isBulletList = true
    if (name === 'ordered_list') isOrderedList = true
    if (name === 'list_item' && n.attrs.checked != null) isTaskList = true
    if (name === 'code_block') isCodeblock = true
  }

  return {
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    isBold: hasMark('strong'),
    isItalic: hasMark('emphasis'),
    isStrikethrough: hasMark('strike_through'),
    isCode: hasMark('inlineCode'),
    isLink: hasMark('link'),
    isBlockquote,
    isBulletList,
    isOrderedList,
    isTaskList,
    isCodeblock,
    heading
  }
}

function shallowEqual(a: ToolbarState, b: ToolbarState): boolean {
  return (Object.keys(a) as (keyof ToolbarState)[]).every((k) => a[k] === b[k])
}

/** 命令式读取编辑器当前 markdown */
function getEditorMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const serializer = ctx.get(serializerCtx)
    return serializer(view.state.doc)
  })
}

/** 命令式把 markdown 写入编辑器（恢复草稿 / 清空 / AI 填入 / 切换条目等外部赋值） */
function setEditorMarkdown(editor: Editor, markdown: string) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const parser = ctx.get(parserCtx)
    const doc = parser(markdown)
    if (!doc) return
    const state = view.state
    view.dispatch(state.tr.replace(0, state.doc.content.size, new Slice(doc.content, 0, 0)))
  })
}

/** 任务列表：不在列表则先包成无序列表并标记；在列表则在任务/普通列表间切换 */
function toggleTaskList(editor: Editor) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const { state, dispatch } = view
    const { tr, selection } = state
    const { $from, $to } = selection
    const range = $from.blockRange($to)
    if (!range) return false

    let depth = -1
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === 'list_item') {
        depth = d
        break
      }
    }

    if (depth >= 0) {
      // 已在列表内：若含非任务项 → 全部标记为任务；否则 → 去掉勾选（还原普通列表）
      let hasNonTask = false
      tr.doc.nodesBetween(range.start, range.end, (n) => {
        if (n.type.name === 'list_item' && n.attrs.checked == null) hasNonTask = true
      })
      const newChecked = hasNonTask ? false : null
      let next = tr
      tr.doc.nodesBetween(range.start, range.end, (n, pos) => {
        if (n.type.name === 'list_item' && n.attrs.checked !== newChecked) {
          next = next.setNodeMarkup(pos, undefined, {
            ...n.attrs,
            checked: newChecked
          })
        }
      })
      dispatch?.(next)
      return true
    }

    // 不在列表：先包成无序列表
    ctx.get(commandsCtx).call(wrapInBulletListCommand.key)
    // 再对包好的列表项打勾
    const view2 = ctx.get(editorViewCtx)
    const s2 = view2.state
    const r2 = s2.selection.$from.blockRange(s2.selection.$to)
    if (r2) {
      let t2 = s2.tr
      s2.doc.nodesBetween(r2.start, r2.end, (n, pos) => {
        if (n.type.name === 'list_item') {
          t2 = t2.setNodeMarkup(pos, undefined, {
            ...n.attrs,
            checked: false
          })
        }
      })
      view2.dispatch(t2)
    }
    return true
  })
}

function MilkdownEditorInner({
  value,
  onChange,
  placeholder = '在这里输入 Markdown 内容...',
  aiPolish = true,
  aiCommand,
  showStatusBar = true
}: Omit<MdEditorProps, 'height' | 'rounded'>) {
  // useInstance 返回元组 [loading, get]，不是对象
  const [loading, get] = useInstance()
  const [toolbar, setToolbar] = useState<ToolbarState>(EMPTY_TOOLBAR)
  const [empty, setEmpty] = useState(() => !value.trim())
  const [cmdInput, setCmdInput] = useState('')
  const [cmdLoading, setCmdLoading] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // 记录编辑器最后输出内容（去重 + 判断外部赋值）；初始值即挂载时 content
  const lastMdRef = useRef<string>(value)
  const valueRef = useRef(value)
  valueRef.current = value
  const imageInputRef = useRef<HTMLInputElement>(null)

  // AI 润色状态
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [aiMsg, setAiMsg] = useState('')
  const aiTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 编辑器创建（仅一次）：注册插件 + 监听 markdown/selection 变化
  useEditor((root) => {
    const md = Editor.make()
    md.config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, valueRef.current.trim() ? valueRef.current : '')
      // 统一挂上 .milkdown 类（index.css 定义排版与暗色）
      ctx.update(editorViewOptionsCtx, (prev) => {
        const prevAttr = prev.attributes
        return {
          ...prev,
          attributes: (state) => {
            const attrs = typeof prevAttr === 'function' ? prevAttr(state) : prevAttr
            return { ...attrs, class: 'milkdown' }
          }
        }
      })
      // prism 语言注册（必须在创建时生效）
      ctx.set(prismConfig.key, {
        configureRefractor: (refractor) => {
          refractor.register(javascript)
          refractor.register(typescript)
          refractor.register(jsx)
          refractor.register(tsx)
          refractor.register(css)
          refractor.register(markup)
          refractor.register(markdown)
          refractor.register(json)
          refractor.register(python)
          refractor.register(bash)
          refractor.register(sql)
          refractor.register(yaml)
          refractor.register(java)
          refractor.register(go)
          refractor.register(rust)
        }
      })
      // 图片上传（粘贴/拖拽）
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        uploader: async (files, schema) => {
          const nodes: any[] = []
          for (let i = 0; i < files.length; i++) {
            const file = files.item(i)
            if (!file || !file.type.includes('image')) continue
            const res = await uploadApi.image(file)
            const src = resolveAsset(res.url)
            const node = schema.nodes.image?.createAndFill({
              src,
              alt: file.name,
              title: file.name
            })
            if (node) nodes.push(node)
          }
          return nodes
        }
      }))
      const listenerAPI = ctx.get(listenerCtx)
      listenerAPI.markdownUpdated((_, markdown) => {
        setEmpty(!markdown.trim())
        if (markdown !== lastMdRef.current) {
          lastMdRef.current = markdown
          onChangeRef.current(markdown)
        }
      })
      const refresh = (c: Ctx) =>
        setToolbar((prev) => {
          const next = computeToolbar(c)
          return shallowEqual(prev, next) ? prev : next
        })
      listenerAPI.selectionUpdated(refresh)
      // 文档变化也刷新（撤销/重做可用性等随 doc 变化）
      listenerAPI.updated((c) => refresh(c))
    })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener)
      .use(prism)
      .use(upload)

    return md
  }, [])

  // 同步外部 value 变化（恢复草稿 / 清空 / AI 填入 / 切换条目等）
  useEffect(() => {
    const ed = get()
    if (!ed || ed.status !== 'Created') return
    try {
      const md = getEditorMarkdown(ed)
      // 外部 value 是权威：无论内容是否一致都同步 empty。
      // 修复：empty 原先只靠 markdownUpdated（用户输入/文档变化）更新，
      // 外部赋值（AI 保存文章 / 切换条目 / 恢复草稿）时 markdownUpdated 可能不触发，
      // 导致「内容已显示但占位符（在此编辑内容…）仍盖在上面」，看起来像空编辑器。
      setEmpty(!value.trim())
      if (value.trim() === (md || '').trim()) return
      setEditorMarkdown(ed, value)
      // 以编辑器实际输出为准，避免 markdown 规范化差异导致误判循环
      try {
        lastMdRef.current = getEditorMarkdown(ed) || value
      } catch {
        lastMdRef.current = value
      }
    } catch {
      // 编辑器尚未就绪，忽略（下次 value 变化时重试）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, loading])

  useEffect(() => {
    return () => {
      if (aiTimer.current) clearTimeout(aiTimer.current)
    }
  }, [])

  const runPolish = async () => {
    if (!value.trim()) {
      setAiState('error')
      setAiMsg('正文为空，先写点内容再润色吧')
      flashReset()
      return
    }
    setAiState('loading')
    setAiMsg('AI 润色中…')
    try {
      const polished = await polishMarkdown(value)
      onChangeRef.current(polished)
      lastMdRef.current = polished
      setAiState('ok')
      setAiMsg('润色完成，已替换正文')
    } catch (err) {
      setAiState('error')
      setAiMsg(err instanceof Error ? err.message : 'AI 润色失败')
    }
    flashReset()
  }

  // 状态提示 6 秒后自动消失
  const flashReset = () => {
    if (aiTimer.current) clearTimeout(aiTimer.current)
    aiTimer.current = setTimeout(() => {
      setAiState('idle')
      setAiMsg('')
    }, 6000)
  }

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      try {
        const res = await uploadApi.image(file)
        const src = resolveAsset(res.url)
        const ed = get()
        if (!ed) return
        ed.action(callCommand(insertImageCommand.key, { src, alt: file.name }))
        ed.action((ctx) => ctx.get(editorViewCtx).focus())
      } catch {
        setAiState('error')
        setAiMsg('图片上传失败')
        flashReset()
      }
    }
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  const runLink = () => {
    const ed = get()
    if (!ed) return
    const url = window.prompt('输入链接地址', 'https://')
    if (url === null) return
    const href = url.trim()
    ed.action(callCommand(toggleLinkCommand.key, { href, title: href }))
    ed.action((ctx) => ctx.get(editorViewCtx).focus())
  }

  /** 执行一个命令并重新聚焦编辑器 */
  const runCmd = useCallback(
    (key: string | CmdKey<any>, payload?: unknown) => {
      const ed = get()
      if (!ed) return
      try {
        ed.action(callCommand(key as never, payload as never))
        ed.action((ctx) => ctx.get(editorViewCtx).focus())
      } catch {
        /* 命令未就绪时忽略 */
      }
    },
    [get]
  )

  const runHeading = (level: 1 | 2 | 3) => {
    if (toolbar.heading === level) runCmd(turnIntoTextCommand.key)
    else runCmd(wrapInHeadingCommand.key, level)
  }

  const btnBase =
    'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'
  // 激活态与 agent 页面选中按钮一致：浅灰底（kimo 风格，不用纯黑）
  const btnActive = 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'

  const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-gray-200 dark:bg-gray-700" />

  const blockBtn = (tag: 0 | 1 | 2 | 3) => {
    const icons: Record<0 | 1 | 2 | 3, ReactNode> = {
      0: <Pilcrow className="h-4 w-4" />,
      1: <Heading1 className="h-4 w-4" />,
      2: <Heading2 className="h-4 w-4" />,
      3: <Heading3 className="h-4 w-4" />
    }
    const labels: Record<0 | 1 | 2 | 3, string> = {
      0: '正文',
      1: '一级标题',
      2: '二级标题',
      3: '三级标题'
    }
    const active =
      tag === 0
        ? toolbar.heading === 0 &&
          !toolbar.isBlockquote &&
          !toolbar.isBulletList &&
          !toolbar.isOrderedList &&
          !toolbar.isCodeblock
        : toolbar.heading === tag
    return (
      <button
        key={tag}
        onClick={() => (tag === 0 ? runCmd(turnIntoTextCommand.key) : runHeading(tag as 1 | 2 | 3))}
        title={labels[tag]}
        className={`${btnBase} ${active ? btnActive : ''}`}
      >
        {icons[tag]}
      </button>
    )
  }

  return (
    <>
      {/* 工具栏：手机也全部展开（换行显示），风格对齐知识库/Live2D 圆角按钮布局 */}
      <div className="flex flex-none flex-wrap items-center gap-0.5 border-b border-gray-100 bg-gray-50/60 px-2 py-1.5 dark:border-gray-800 dark:bg-gray-800/60">
        <button
          onClick={() => runCmd(undoCommand.key)}
          disabled={!toolbar.canUndo}
          title="撤销 (Ctrl+Z)"
          className={btnBase}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(redoCommand.key)}
          disabled={!toolbar.canRedo}
          title="重做 (Ctrl+Y)"
          className={btnBase}
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <Divider />

        {/* 行内格式 */}
        <button
          onClick={() => runCmd(toggleStrongCommand.key)}
          title="加粗 (Ctrl+B)"
          className={`${btnBase} ${toolbar.isBold ? btnActive : ''}`}
        >
          <Bold className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(toggleEmphasisCommand.key)}
          title="斜体 (Ctrl+I)"
          className={`${btnBase} ${toolbar.isItalic ? btnActive : ''}`}
        >
          <Italic className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(toggleStrikethroughCommand.key)}
          title="删除线"
          className={`${btnBase} ${toolbar.isStrikethrough ? btnActive : ''}`}
        >
          <Strikethrough className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(toggleInlineCodeCommand.key)}
          title="行内代码"
          className={`${btnBase} ${toolbar.isCode ? btnActive : ''}`}
        >
          <Code className="h-4 w-4" />
        </button>
        <Divider />

        {/* 块级 */}
        {([0, 1, 2, 3] as (0 | 1 | 2 | 3)[]).map(blockBtn)}
        <Divider />
        <button
          onClick={() => runCmd(wrapInBlockquoteCommand.key)}
          title="引用"
          className={`${btnBase} ${toolbar.isBlockquote ? btnActive : ''}`}
        >
          <Quote className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(wrapInBulletListCommand.key)}
          title="无序列表"
          className={`${btnBase} ${toolbar.isBulletList ? btnActive : ''}`}
        >
          <List className="h-4 w-4" />
        </button>
        <button
          onClick={() => runCmd(wrapInOrderedListCommand.key)}
          title="有序列表"
          className={`${btnBase} ${toolbar.isOrderedList ? btnActive : ''}`}
        >
          <ListOrdered className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            const ed = get()
            if (ed) toggleTaskList(ed)
          }}
          title="任务列表"
          className={`${btnBase} ${toolbar.isTaskList ? btnActive : ''}`}
        >
          <ListChecks className="h-4 w-4" />
        </button>
        <Divider />

        <button
          onClick={() =>
            toolbar.isCodeblock
              ? runCmd(turnIntoTextCommand.key)
              : runCmd(createCodeBlockCommand.key)
          }
          title="代码块"
          className={`${btnBase} ${toolbar.isCodeblock ? btnActive : ''}`}
        >
          <SquareCode className="h-4 w-4" />
        </button>
        <button onClick={runLink} title="插入链接" className={btnBase}>
          <Link2 className="h-4 w-4" />
        </button>
        <button onClick={() => runCmd(insertTableCommand.key)} title="插入表格" className={btnBase}>
          <Table2 className="h-4 w-4" />
        </button>
        <button onClick={() => imageInputRef.current?.click()} title="插入图片" className={btnBase}>
          <ImageIcon className="h-4 w-4" />
        </button>

        {/* AI 润色（右对齐，低调灰字，与工具栏图标风格协调，不突兀） */}
        {aiPolish && (
          <>
            <Divider />
            <button
              onClick={runPolish}
              disabled={aiState === 'loading'}
              title="使用 AI 润色正文"
              className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-gray-700 transition hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:text-gray-100"
            >
              {aiState === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">AI 润色</span>
            </button>
          </>
        )}

        {/* AI 指令生成 — 内联在工具栏，像浏览器地址栏 */}
        {aiCommand && (
          <div className="ml-auto flex items-center gap-1.5">
            <input
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cmdInput.trim()) {
                  const p = cmdInput.trim()
                  setCmdLoading(true)
                  setCmdInput('')
                  aiCommand(p).finally(() => setCmdLoading(false))
                }
              }}
              placeholder="AI 指令…"
              disabled={cmdLoading}
              className="h-7 w-28 shrink-0 rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none transition-all focus:w-40 focus:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            />
            <button
              onClick={() => {
                const p = cmdInput.trim()
                if (!p) return
                setCmdLoading(true)
                setCmdInput('')
                aiCommand(p).finally(() => setCmdLoading(false))
              }}
              disabled={!cmdInput.trim() || cmdLoading}
              className="grid h-7 w-7 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"
              title="生成"
            >
              {cmdLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickImage}
        />
      </div>

      {/* 编辑器主体 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <EditorBoundary fallbackValue={value} onFallback={onChange}>
          <Milkdown />
        </EditorBoundary>
        {empty && !loading && (
          <div className="pointer-events-none absolute left-4 top-4 text-sm text-gray-400">
            {placeholder}
          </div>
        )}
      </div>

      {/* 底部状态栏：胶囊按钮风格（对齐知识库/Live2D 布局） */}
      {showStatusBar && (
        <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-gray-800 dark:bg-gray-800/60">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200/80 bg-white px-2.5 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
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
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
            支持 Markdown · 图片可直接粘贴
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {aiState !== 'idle' && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  aiState === 'ok'
                    ? 'border-green-200 bg-green-50 text-green-600 dark:border-green-900 dark:bg-green-950/40 dark:text-green-400'
                    : aiState === 'error'
                      ? 'border-red-200 bg-red-50 text-red-500 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'
                      : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
                }`}
              >
                {aiState === 'loading' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : aiState === 'ok' ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <X className="h-3 w-3" />
                )}
                {aiMsg}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200/80 bg-white px-2.5 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              正文 {value.length} 字 · 约 {readingTime(value)} 分钟
            </span>
          </span>
        </div>
      )}
    </>
  )
}

export function MdEditor({
  value,
  onChange,
  height = 520,
  placeholder,
  aiPolish = true,
  aiCommand,
  showStatusBar = true,
  rounded = true
}: MdEditorProps) {
  return (
    <div
      className={
        'flex flex-col overflow-hidden border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900' +
        (rounded ? ' rounded-2xl' : '') +
        (height === 'fill' ? ' min-h-0 flex-1' : '')
      }
      style={typeof height === 'number' ? { height } : undefined}
    >
      <MilkdownProvider>
        <MilkdownEditorInner
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          aiPolish={aiPolish}
          aiCommand={aiCommand}
          showStatusBar={showStatusBar}
        />
      </MilkdownProvider>
    </div>
  )
}
