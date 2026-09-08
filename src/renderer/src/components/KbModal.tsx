import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getKbNotes, saveKbSelections, getKbSelections,
  loadKbOptions, addKbNote, updateKbNote, removeKbNote,
  assembleKnowledge, downloadText, type KbNote, type KbSelections,
} from '../lib/kb'

interface KbModalProps {
  open: boolean
  onClose: () => void
  pageId: number
  kbOn: boolean
  onToggleKb: (on: boolean) => void
  onApplied: () => void

}

const iconBtn = 'grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800'

export function KbModal({ open, onClose, pageId, kbOn, onToggleKb, onApplied }: KbModalProps) {
  const [tab, setTab] = useState<'site' | 'notes'>('site')
  const [sel, setSel] = useState<KbSelections>(() => getKbSelections(pageId))
  const [notes, setNotes] = useState<KbNote[]>(() => getKbNotes())
  const [allArticles, setAllArticles] = useState<{ id: number; title: string; category_name?: string | null }[]>([])
  const [allCategories, setAllCategories] = useState<{ id: number; name: string; slug: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const importMarkdown = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const title = file.name.replace(/\.(md|markdown|txt)$/i, '').trim() || '导入的 Markdown'
      setNotes(addKbNote(title, text))
    }
    reader.readAsText(file)
    if (importRef.current) importRef.current.value = ''
  }

  useEffect(() => {
    if (!open) return
    setLoading(true)
    loadKbOptions()
      .then((o) => {
        setAllArticles(o.articles.map((a) => ({ id: a.id, title: a.title, category_name: a.category_name })))
        setAllCategories(o.categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  // 同步到 localStorage
  const persist = (next: KbSelections) => {
    setSel(next)
    saveKbSelections(pageId, next)
  }

  const toggleArticle = (id: number) =>
    persist({ ...sel, articleIds: sel.articleIds.includes(id) ? sel.articleIds.filter((x) => x !== id) : [...sel.articleIds, id] })

  const toggleCategory = (id: number) =>
    persist({ ...sel, categoryIds: sel.categoryIds.includes(id) ? sel.categoryIds.filter((x) => x !== id) : [...sel.categoryIds, id] })

  const selectAll = () => persist({ ...sel, articleIds: allArticles.map((a) => a.id) })
  const clearAll = () => persist({ ...sel, articleIds: [], categoryIds: [] })

  const submitNote = () => {
    if (!noteTitle.trim() && !noteContent.trim()) return
    setNotes(editingId ? updateKbNote(editingId, noteTitle, noteContent) : addKbNote(noteTitle, noteContent))
    setNoteTitle(''); setNoteContent(''); setEditingId(null)
  }

  const startEdit = (n: KbNote) => { setEditingId(n.id); setNoteTitle(n.title); setNoteContent(n.content) }

  const exportKb = async () => {
    const kb = await assembleKnowledge(sel, notes)
    const text = [
      '# Coser 角色扮演设定',
      '',
      `> 导出时间：${new Date().toLocaleString()}`,
      '',
      '## 一、角色提示词',
      '（提示词统一由 Agent 管理）',
      '',
      '## 二、启用状态',
      kbOn ? '已启用角色资料' : '未启用（角色资料未生效）',
      '',
      '## 三、附加资料（站点内容 + 自定义设定）',
      kb || '（未选择任何内容）',
      '',
    ].join('\n')
    downloadText(`kimo-coser-${new Date().toISOString().slice(0, 10)}.md`, text)
  }

  const preview = useMemo(() => {
    const s = `文章 ${sel.articleIds.length} 篇 · 分类 ${sel.categoryIds.length} 个 · 自定义笔记 ${sel.includeNotes ? notes.filter((n) => n.title || n.content).length + ' 条' : '关'}`
    return s
  }, [sel, notes])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        {/* 头部 */}
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Coser · 角色扮演设定</h3>
          <button onClick={onClose} className={iconBtn} aria-label="关闭">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* 启用开关 */}
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">启用角色资料</p>
            <p className="text-xs text-gray-400">{preview}</p>
          </div>
          <button
            onClick={() => onToggleKb(!kbOn)}
            className={`relative h-6 w-11 rounded-full transition ${kbOn ? 'bg-gray-900 dark:bg-gray-200' : 'bg-gray-300 dark:bg-gray-700'}`}
            aria-label="启用知识库"
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${kbOn ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>

        {/* 标签页 */}
        <div className="flex shrink-0 gap-1 border-b border-gray-100 px-4 py-2 dark:border-gray-700">
          {(['site', 'notes'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${tab === t ? 'bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}
            >
              {t === 'site' ? '站点内容' : '自定义设定'}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'site' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">选择要喂给 AI 的文章 / 分类</p>
                <div className="flex gap-2 text-xs">
                  <button onClick={selectAll} className="rounded-lg border border-gray-200 px-2.5 py-1 text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">全选</button>
                  <button onClick={clearAll} className="rounded-lg border border-gray-200 px-2.5 py-1 text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">清空</button>
                </div>
              </div>

              {loading && <p className="py-6 text-center text-sm text-gray-400">加载中...</p>}

              {allCategories.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-400">分类</p>
                  <div className="flex flex-wrap gap-2">
                    {allCategories.map((c) => (
                      <label key={c.id} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${sel.categoryIds.includes(c.id) ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-200 dark:bg-gray-200 dark:text-gray-900' : 'border-gray-200 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300'}`}>
                        <input type="checkbox" className="hidden" checked={sel.categoryIds.includes(c.id)} onChange={() => toggleCategory(c.id)} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {allArticles.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-400">文章</p>
                  <div className="space-y-1 rounded-xl border border-gray-100 p-1 dark:border-gray-800">
                    {allArticles.map((a) => (
                      <label key={a.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800">
                        <input
                          type="checkbox"
                          checked={sel.articleIds.includes(a.id)}
                          onChange={() => toggleArticle(a.id)}
                          className="h-4 w-4 shrink-0 accent-gray-900"
                        />
                        <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">{a.title}</span>
                        {a.category_name && <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{a.category_name}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!loading && allArticles.length === 0 && allCategories.length === 0 && (
                <p className="py-6 text-center text-sm text-gray-400">站点暂无文章或分类</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
                <p className="mb-2 text-xs font-medium text-gray-400">新增设定（保存在本机浏览器，仅自己可见）</p>
                <input
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="标题（如：我的产品说明）"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800"
                />
                <textarea
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="内容，AI 将基于它回答相关问题..."
                  rows={3}
                  className="mt-2 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800"
                />
                <div className="mt-2 flex items-center justify-between">
                  <button
                    onClick={() => importRef.current?.click()}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                    导入 Markdown
                  </button>
                  <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown" onChange={importMarkdown} className="hidden" />
                  {editingId ? (
                    <span className="text-xs text-gray-400">正在编辑，保存后更新</span>
                  ) : <span />}
                  <button
                    onClick={submitNote}
                    disabled={!noteTitle.trim() && !noteContent.trim()}
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
                  >
                    {editingId ? '保存修改' : '添加设定'}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {notes.filter((n) => n.title || n.content).map((n) => (
                  <div key={n.id} className="group flex items-start gap-2 rounded-xl border border-gray-100 p-3 dark:border-gray-800">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{n.title || '无标题'}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-gray-500 dark:text-gray-400">{n.content}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => startEdit(n)} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800" aria-label="编辑">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
                      </button>
                      <button onClick={() => setNotes(removeKbNote(n.id))} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-red-500 dark:hover:bg-gray-800" aria-label="删除">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                      </button>
                    </div>
                  </div>
                ))}
                {notes.filter((n) => n.title || n.content).length === 0 && (
                  <p className="py-6 text-center text-sm text-gray-400">还没有笔记，添加一条试试</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <button onClick={exportKb} className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            导出设定
          </button>
          <button
            onClick={() => { onApplied(); onClose() }}
            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
