import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { articleApi } from '../lib/api'
import { useToast } from '../lib/toast'

interface ArticleComposerModalProps {
  open: boolean
  onClose: () => void
}

const inputCls =
  'w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800'

export function ArticleComposerModal({ open, onClose }: ArticleComposerModalProps) {
  const { success, error } = useToast()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) return null

  const submit = async () => {
    if (!title.trim() || !content.trim()) {
      error('请填写标题与正文')
      return
    }
    setSaving(true)
    try {
      const created = await articleApi.create({ title: title.trim(), content: content.trim() })
      success('文章已创建')
      onClose()
      setTitle(''); setContent('')
      if (created?.id) navigate(`/dashboard/articles/${created.id}/edit`)
    } catch (e) {
      error(e instanceof Error ? e.message : '创建失败，请检查后端 API 与权限')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">写文章</h3>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800" aria-label="关闭">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs leading-relaxed text-gray-400">
            在 AI 对话中直接撰写文章（Markdown 语法），保存后通过后端 API 发布。此功能需在后台「站点设置」中开启，并需登录具备权限的账号。
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="文章标题" className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">正文（Markdown）</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder="# 开始写作…" className={`${inputCls} resize-none`} />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">
            取消
          </button>
          <button onClick={submit} disabled={saving}
            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300">
            {saving ? '发布中…' : '发布文章'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
