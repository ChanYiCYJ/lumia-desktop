/**
 * skill 模块化共用类型与工具。
 * 思路（参考 Anthropic《Effective context engineering for AI agents》+ LLMLingua 结构化压缩）：
 * - 上下文段（knowledge/memory/personaNotes/summary/web/viewIntro/view）=「可压缩段」，各自 clamp 上限；
 * - 核心指令段（persona/mode/toolUsage/kb/live2d）=「保留段」，不 clamp、按开关注入。
 */

/** 截断长文本到上限（末尾省略号），避免知识库/浏览文章/网络结果等上下文过度消耗 token */
export function clamp(text: string, max: number): string {
  if (!text || text.length <= max) return text
  return text.slice(0, max) + '…'
}

/** 一段 skill 提示词（text 已含与前段之间的分隔符；id 便于测试/调试定位） */
export interface SkillSection {
  id: string
  text: string
}

/** 组装 system 所需的上下文（原始值，各 skill 内部自行 clamp） */
export interface SkillContext {
  /** 知识库内容 */
  knowledge?: string
  /** 对话记忆（用户偏好） */
  memory?: string
  /** auto-knowledge 人格笔记 */
  personaKnowledge?: string
  /** 老消息摘要 */
  summary?: string
  /** 网络搜索结果 */
  web?: string
  /** 当前 View 文章全文 */
  viewArticle?: string
  /** 当前 View 文章简介（记忆） */
  viewIntro?: string
  /** 本站操作文档（用户询问本站操作/使用/功能时注入） */
  siteDoc?: string
  /** Notion 工作区实时内容（notion.ts buildNotionContext 输出） */
  notion?: string
  /** 用户询问涉及 Notion 但未配置/无结果（注入诚实降级说明） */
  notionIntent?: boolean
  /** 知识融合：用户要求综合多源资料（本地知识库 + 网络结果等）时注入 */
  knowledgeFusion?: boolean
  /** Live2D 角色档案人格（role 模式） */
  lorePrompt?: string
  /** 机器人系统提示词（非 role 模式的人格主体） */
  systemPrompt?: string
  /** 角色扮演模式：跳过记忆/人格笔记，避免提示词打架 */
  pureRole?: boolean
  /** 是否注入 SEARCH/BROWSE 工具说明 */
  webTools?: boolean
  /** 联网搜索模式（浏览面板负责生成文章，AI 只简短引导） */
  browseMode?: boolean
  /** 智能模式 Auto */
  autoMode?: boolean
  /** 纯本地快速模式 Fast */
  fastMode?: boolean
  /** Live2D 开启：注入表情标签 + 动作指令 */
  l2dEnabled?: boolean
  /** 音频 TTS 模式：注入「回复简短口语化」提示（更适合语音朗读） */
  ttsMode?: boolean
  /** 本机工具开启（桌面版）：注入 [TOOL:...] 指令说明 */
  localTools?: boolean
  /** 最近一次本机工具执行结果（要求 AI 基于结果继续回答） */
  toolResult?: { ok: boolean; output: string; error?: string }
  /** MCP 工具清单文本（mcp_<id>_<tool>，含服务器名说明） */
  mcpTools?: string
}
