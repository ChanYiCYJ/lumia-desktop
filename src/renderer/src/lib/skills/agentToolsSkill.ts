/**
 * 本机工具 Skill：教会 AI 用 [TOOL:...] 指令操作电脑（终端/文件/剪贴板），
 * 并注入最近一次工具执行结果（toolResult），要求基于结果继续回答。
 */
import type { SkillContext, SkillSection } from './util'

const TOOL_HELP = [
  'shell —— 运行终端命令（Linux/macOS 用 bash，Windows 用 cmd/powershell）。',
  'read_file —— 读取文本文件（args: path）。',
  'write_file —— 写入/覆盖文本文件（args: path, content）。',
  'list_dir —— 列出目录（args: path，默认用户主目录）。',
  'clipboard_read / clipboard_write —— 读取 / 写入剪贴板（args: text）。'
].join('\n')

const INSTRUCTIONS =
  '【本机工具（可操作电脑）】当前是桌面版，你可以通过指令调用本机工具帮用户操作电脑（如查看文件、运行命令、读写剪贴板）。\n' +
  '规则：\n' +
  '1. 先输出 1 句中文说明你要做什么，再输出工具指令，格式：\n' +
  '   [TOOL:{"name":"shell","args":{"cmd":"命令"}}]\n' +
  '   [TOOL:{"name":"read_file","args":{"path":"/路径/文件"}}]\n' +
  '   [TOOL:{"name":"list_dir","args":{"path":"/目录"}}]\n' +
  '   [TOOL:{"name":"clipboard_write","args":{"text":"内容"}}]\n' +
  '   JSON 必须合法（双引号），命令/路径请转义。\n' +
  '2. 只有用户明确要求「操作电脑/运行命令/查看文件/帮我改文件/终端/剪贴板」等才用工具；纯聊天、搜索类问题不要用。\n' +
  '3. 一次最多输出 2 个工具指令；shell 与 write_file 会在界面请用户确认后执行。\n' +
  '4. 工具执行后，结果会自动注入给你，请基于结果继续把任务做完（如「已运行命令，输出了…，我据此…」）。' +
  '\n可用工具：\n' +
  TOOL_HELP

/** 指令段（localTools 或 MCP 工具存在时注入） */
export function agentToolsSection(ctx: SkillContext): SkillSection | null {
  if (!ctx.localTools && !ctx.mcpTools) return null
  let text = INSTRUCTIONS
  if (ctx.mcpTools) {
    text +=
      '\n【MCP 扩展工具】以下 MCP 服务器已连接，可调用其工具（名称已加 mcp_ 前缀）：\n' +
      ctx.mcpTools +
      '\n调用示例：[TOOL:{"name":"mcp_xxx_tool名","args":{...}}]（参数参考该工具 schema）'
  }
  return { id: 'agentTools', text: '\n\n' + text }
}

/** 工具结果段（有执行结果时注入，要求基于结果继续回答） */
export function toolResultSection(ctx: SkillContext): SkillSection | null {
  const r = ctx.toolResult
  if (!r) return null
  return {
    id: 'toolResult',
    text:
      '\n\n【本机工具执行结果】' +
      (r.ok ? '（成功）' : '（失败）') +
      '\n' +
      r.output +
      (r.error ? '\n错误：' + r.error : '') +
      '\n请基于该结果继续完成用户刚才的要求；若失败请说明原因并给出替代方案，不要编造结果。'
  }
}
