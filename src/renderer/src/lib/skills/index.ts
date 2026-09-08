/**
 * AI Chat skill 模块化提示词库。
 * 每个功能一个独立 skill 段（搜索 / 知识库 / View / 人格 / 记忆 / Live2D），
 * 由 assembleSystem 按轮次上下文与开关「just-in-time」组装成 system 提示词。
 */
export { assembleSystem } from "./registry";
export type { SkillContext, SkillSection } from "./util";
export { clamp } from "./util";
