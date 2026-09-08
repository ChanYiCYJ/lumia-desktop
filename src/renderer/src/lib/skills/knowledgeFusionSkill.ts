import type { SkillContext, SkillSection } from "./util";

/**
 * 知识融合指令段（核心指令段，保留）：多源知识交叉验证与来源标注。
 * 仅当用户请求「综合多源资料」（本地知识库 🧠 + Notion + 网络结果 🌐 等）时，
 * 由 AIChat 置位 ctx.knowledgeFusion 按需注入（省 token，仿 siteDoc 先例）。
 * 与 answerQualitySection（区分事实/推测、标注权威）叠加：本段聚焦「多源融合」方法论。
 */
export function knowledgeFusionSection(ctx: SkillContext): SkillSection {
  const hasSource = !!(
    ctx.knowledge ||
    ctx.memory ||
    ctx.personaKnowledge ||
    ctx.web ||
    ctx.notion
  );
  if (!ctx.knowledgeFusion || !hasSource) {
    return { id: "knowledgeFusion", text: "" };
  }
  return {
    id: "knowledgeFusion",
    text: `\n\n【知识融合】当前可综合「本地知识库🧠」「Notion 工作区」与「网络搜索结果🌐」等多源资料作答，请遵守：
- **交叉验证**：把多源资料互为证据、综合后作答，不偏信单一来源；来源间矛盾时以更权威/更新者为准（Notion 页面按 last_edited_time、网络按发布日期/权威性）并明示「以 X 为准」；仍难判定则并列说明并标注置信度（高/中/低）。
- **来源标注**：引用关键信息时用前缀标明来源——\`🧠 本地\`（知识库/记忆）、\`Notion\`（工作区页面/数据库）或 \`🌐 网络\`（搜索结果）；严禁把网络信息说成 Notion 或本地知识、混淆来源。
- **去重**：多源重复内容保留最高优先级来源，其余以「另见」附录。
- **输出格式**：开头用引用块 \`> 💡 **核心结论**\` 给出 1-2 句直接答案；详细分析附「引用溯源」列表（每条标注来源）；可用 \`<details>\` 折叠块展示检索证据链；末尾可附一行来源统计（如 \`🧠 本地 3 条 · Notion 2 页 · 🌐 网络 2 条\`）。`,
  };
}
