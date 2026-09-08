/** 格式化日期为友好展示 */
export function formatDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const day = 24 * 60 * 60 * 1000
  if (diff >= 0 && diff < day) {
    const h = Math.floor(diff / (60 * 60 * 1000))
    if (h < 1) {
      const m = Math.max(1, Math.floor(diff / (60 * 1000)))
      return `${m} 分钟前`
    }
    return `${h} 小时前`
  }
  if (diff >= 0 && diff < 7 * day) {
    return `${Math.floor(diff / day)} 天前`
  }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dayNum = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dayNum}`
}

/** 估算阅读时间（按每分钟 300 字） */
export function readingTime(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*`\-[\]()!]/g, '')
    .trim()
  const chars = text.length
  return Math.max(1, Math.ceil(chars / 300))
}

/** 把标题文本转成稳定 id（供目录锚点跳转，需与 Markdown 渲染保持一致） */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
