import { clamp, type SkillContext, type SkillSection } from "./util";
import { todayStr } from "../searchApi";

/**
 * Notion 融合源段：注入 Notion Workspace 实时内容 + 使用规则。
 * - ctx.notion = 已检索到的 Notion 内容（notion.ts buildNotionContext 输出，可压缩段 clamp 4000）
 * - ctx.notionIntent = 用户询问涉及 Notion 但未配置/无结果时，注入诚实降级说明（不编造）
 */
export function notionSection(ctx: SkillContext): SkillSection {
  if (ctx.notion) {
    const cap = clamp(ctx.notion, 4000);
    return {
      id: "notion",
      text: `\n\n今天是 ${todayStr()}。以下是当前 Notion Workspace 中检索到的实时内容，请基于它们回答并注明来源（页面/数据库标题、更新日期；若信息可能过时请如实说明）：\n${cap}\n\n其中可能包含 Notion 数据库条目（含任务/状态/清单/属性）。用户询问数据库里的任务、状态、进展时，请直接按属性/状态汇总回答，不要编造数据库中不存在的字段或条目。`,
    };
  }
  if (ctx.notionIntent) {
    return {
      id: "notion",
      text: `\n\n【Notion 提示】用户询问涉及 Notion Workspace，但当前未连接 Notion 或检索无结果。请如实告知「你还没有配置 Notion 连接」，并简短指引：在「Agent 工具箱 → 设置 → Notion」填入 Integration Token（需先在 Notion 后台创建 Integration 并共享页面/数据库到它）。不要编造 Notion 页面/数据库内容；可基于其他可用资料（本地知识库/网络搜索）尽力回答。`,
    };
  }
  return { id: "notion", text: "" };
}
