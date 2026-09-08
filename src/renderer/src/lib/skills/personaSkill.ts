import type { SkillContext, SkillSection } from "./util";

/**
 * 人格主体（核心指令段，不 clamp）：
 * role 模式用 Live2D 角色设定档案（人物世界观·人格），否则用系统提示词。
 */
export function personaSection(ctx: SkillContext): SkillSection {
  return {
    id: "persona",
    text: ctx.lorePrompt || ctx.systemPrompt || "",
  };
}
