import { clamp, type SkillSection } from "./util";

/** 知识库：唯一带「权威来源」约束的内容段（可压缩段，上限 6000） */
export function knowledgeSection(knowledge: string): SkillSection {
  const cap = clamp(knowledge, 6000);
  return {
    id: "knowledge",
    text: cap
      ? `【重要】你必须优先基于以下用户知识库回答。如果知识库有相关信息，请以此为权威来源：\n${cap}\n\n---\n\n`
      : "",
  };
}
