import type { SkillContext, SkillSection } from './util'
import { knowledgeSection } from './knowledgeSkill'
import { personaSection } from './personaSkill'
import { memorySection, personaNotesSection, summarySection } from './memorySkill'
import { viewIntroSection, viewSection } from './viewSkill'
import { siteDocSection } from './siteDocSkill'
import { knowledgeFusionSection } from './knowledgeFusionSkill'
import { notionSection } from './notionSkill'
import { webSection, modeSection, toolUsageSection, answerQualitySection } from './searchSkill'
import { kbSections } from './kbSkill'
import { live2dSections } from './live2dSkill'
import { agentToolsSection, toolResultSection } from './agentToolsSkill'

/**
 * 按需组装 system 提示词：每个功能是一个独立 skill 段（模块化，避免把不相关的
 * 指令/上下文全塞给模型 → 减少混乱 + token）。仅注入「当轮相关」的段：
 * - 上下文段（knowledge/memory/personaNotes/summary/web/viewIntro/view）按内容存在与否注入并各自 clamp；
 * - 核心指令段（persona/mode/toolUsage/kb）按开关注入；Live2D 段仅 l2dEnabled 时注入。
 * 借鉴 Anthropic「just-in-time context」与 LLMLingua 结构化压缩思想：
 * 上下文段=可压缩段（clamp），指令段=保留段（不 clamp）。
 *
 * 段顺序（与旧实现保持一致）：knowledge → persona → memory → personaNotes → summary →
 * web → viewIntro → view → mode → toolUsage → kb(+toolPreface) → live2d(可选)。
 */
export function assembleSystem(ctx: SkillContext): string {
  const sections: SkillSection[] = [
    knowledgeSection(ctx.knowledge || ''),
    siteDocSection(ctx.siteDoc || ''),
    personaSection(ctx),
    memorySection(ctx),
    personaNotesSection(ctx),
    summarySection(ctx),
    webSection(ctx),
    notionSection(ctx),
    viewIntroSection(ctx),
    viewSection(ctx),
    modeSection(ctx),
    toolUsageSection(ctx),
    answerQualitySection(ctx),
    knowledgeFusionSection(ctx),
    ...kbSections()
  ]
  if (ctx.l2dEnabled) sections.push(...live2dSections())
  const toolsSection = agentToolsSection(ctx)
  if (toolsSection) sections.push(toolsSection)
  const tResultSection = toolResultSection(ctx)
  if (tResultSection) sections.push(tResultSection)
  // 音频 TTS 模式：AI 回复像真人说话一样自然口语化（便于语音朗读），禁止动作描写/旁白；仍可附 Live2D 指令
  if (ctx.ttsMode) {
    sections.push({
      id: 'ttsShort',
      text: '\n\n【语音朗读模式】当前开启了语音朗读（音频 TTS），请完全像真人一样说话：只说自然口语、简短（2~4 句即可）、别列长清单；禁止任何括号动作描写/表演提示/旁白（如（歪头打量）（忍不住笑起来）（语气放软）这类括号内容都不要出现），也不要输出旁白叙述；Live2D 表情/动作指令照常可附（如 [表情:开心]）。'
    })
  }
  return sections
    .map((s) => s.text)
    .filter(Boolean)
    .join('')
}

export type { SkillContext, SkillSection }
export { clamp } from './util'
