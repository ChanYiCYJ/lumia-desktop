/**
 * AI 工具指令文本过滤
 * 从 AI 回复的显示文本中隐藏工具指令（[SEARCH:] / [BROWSE:] / [EDIT:] / [KB-*] 等），
 * 它们由对话中的 toolCalls 小卡片承载展示，避免在消息里露出原始标记。
 */

/** 本机工具指令：[TOOL:{"name":"shell","args":{"cmd":"ls -la"}}] */
const TOOL_RE = /\[TOOL:\s*(\{[\s\S]*?\})\]/g

export interface ToolCommand {
  name: string
  args: Record<string, unknown>
  raw: string
}

/** 从 AI 回复中提取本机工具调用（JSON 形式，需要完整合法 JSON，容错单条失败） */
export function extractToolCommands(content: string): ToolCommand[] {
  const out: ToolCommand[] = []
  TOOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOOL_RE.exec(content)) !== null) {
    try {
      const j = JSON.parse(m[1]) as { name?: unknown; args?: unknown }
      if (j && typeof j.name === 'string' && j.name) {
        out.push({
          name: j.name,
          args: (j.args && typeof j.args === 'object' ? j.args : {}) as Record<string, unknown>,
          raw: m[0]
        })
      }
    } catch {
      /* 非法 JSON 跳过（不阻塞其它工具指令） */
    }
  }
  return out
}

/** 工具参数的人类可读摘要（用于工具卡展示） */
export function toolArgsPreview(t: ToolCommand): string {
  if (t.name === 'shell') return String(t.args.cmd || '')
  if (t.name === 'read_file' || t.name === 'write_file' || t.name === 'list_dir')
    return String(t.args.path || '')
  if (t.name === 'clipboard_write') return String(t.args.text || '').slice(0, 40)
  if (t.name === 'clipboard_read') return '读取剪贴板'
  return ''
}

export function stripToolCmds(content: string): string {
  return (
    content
      // 0) 本机工具指令 [TOOL:{...}]
      .replace(/\[TOOL:\s*\{[\s\S]*?\}\]/gi, '')
      // 1) 成对块：KB-SAVE / KB-EDIT
      .replace(/\[KB-SAVE:\s*[^\]]*\]\s*[\s\S]*?\[\/KB-SAVE\]/gi, '')
      .replace(/\[KB-EDIT:\s*[^\]]*\]\s*[\s\S]*?\[\/KB-EDIT\]/gi, '')
      // 2) 闭合单行指令（[SEARCH: x] 等，含 [KB-DELETE:标题]）
      .replace(/\[(?:SEARCH|BROWSE|VIEW|KB|OPEN_KB|KB-DELETE|知识库|EDIT):\s*[^\]]*\]/gi, '')
      // 2.5) 表情标签 [表情:开心] / 【表情:别扭】 / [EMOTION:开心]（由 Live2D 看板娘承载展示）
      .replace(/[\[【]\s*(?:表情|EMOTION)\s*[:：]\s*[^\]】]*?[\]】]/gi, '')
      // 2.6) Live2D 动作指令 [PARAM:ParamX:0.8] / [MOTION:smile01] / [EXPRESSION:xxx]
      //      （由 live2dCore 的 applyActionCommands 执行，消息里不展示原始标记）
      .replace(
        /[\[【]\s*(?:PARAM|参数|MOTION|动作|EXPRESSION|表情预设)\s*[:：]\s*[^\]】\n]{1,60}?[\]】]/gi,
        ''
      )
      // 3) 未闭合指令（到行尾，兼容 AI 漏写 ]）
      .replace(/\[(?:SEARCH|BROWSE|VIEW|KB|OPEN_KB|KB-DELETE|知识库|EDIT):[^\n]*$/gi, '')
      // 3.5) 悬空的半截标记（AI 回复被截断在 '[' 处）：清理结尾残留的 [ / 【
      .replace(/[\[【]\s*$/, '')
      // 4) 清理孤立标记（残留 [SEARCH] / [/SEARCH] 等）
      .replace(/\[\/?(?:SEARCH|BROWSE|VIEW|KB|OPEN_KB|KB-DELETE|知识库|EDIT)\]/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
