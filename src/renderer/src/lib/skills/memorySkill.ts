import { clamp, type SkillContext, type SkillSection } from "./util";

/** 对话记忆（用户偏好，可压缩段 2000）；角色扮演 pureRole 时跳过 */
export function memorySection(ctx: SkillContext): SkillSection {
  const cap = clamp(ctx.memory || "", 2000);
  return {
    id: "memory",
    text:
      !ctx.pureRole && cap
        ? `\n\n以下是过往对话中学习到的用户偏好与经验，请据此优化你的回答：\n${cap}`
        : "",
  };
}

/** auto-knowledge 人格笔记（可压缩段 2000）；pureRole 时跳过 */
export function personaNotesSection(ctx: SkillContext): SkillSection {
  const cap = clamp(ctx.personaKnowledge || "", 2000);
  return {
    id: "personaNotes",
    text:
      !ctx.pureRole && cap
        ? `\n\n【auto-knowledge 人格笔记】以下是你越聊越懂用户、越贴合人设的自动学习笔记（每条为一段对话后提炼）。请自然地融入你的性格与回答，不要提及这些笔记本身：\n${cap}`
        : "",
  };
}

/** 对话上下文摘要（可压缩段 1500） */
export function summarySection(ctx: SkillContext): SkillSection {
  const cap = clamp(ctx.summary || "", 1500);
  return {
    id: "summary",
    text: cap ? `\n\n对话上下文摘要：\n${cap}` : "",
  };
}
