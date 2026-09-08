import { clamp, type SkillContext, type SkillSection } from "./util";

/** 当前浏览文章 · 摘要（记忆，可压缩段 500） */
export function viewIntroSection(ctx: SkillContext): SkillSection {
  const cap = clamp(ctx.viewIntro || "", 500);
  return {
    id: "viewIntro",
    text: cap
      ? `\n\n【当前浏览文章 · 摘要】你在 View 面板生成过一篇关于它的综合文章，以下为其简介（记忆，供你引用；完整文章在需要时会另行提供）：\n${cap}`
      : "",
  };
}

/** 当前浏览文章全文（可压缩段 4000）；browseMode 时附加 [VIEW:] 更新指令 */
export function viewSection(ctx: SkillContext): SkillSection {
  const cap = clamp(ctx.viewArticle || "", 4000);
  return {
    id: "view",
    text: cap
      ? `\n\n【当前浏览文章】以下是 View 面板中当前生成的综合文章，用户可能会基于它继续提问、总结或要求优化。请以它为事实基础作答；${
          ctx.browseMode
            ? "**当用户要求修改/优化这篇文章时，直接输出修改后的完整文章并用 [VIEW:内容] 括起（不要用 [EDIT:]），我会更新 View 面板中的文章**。"
            : ""
        }\n${cap}`
      : "",
  };
}
