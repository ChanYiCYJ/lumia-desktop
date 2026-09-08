import { clamp, type SkillSection } from "./util";

/** 本站操作文档：仅当用户询问本站操作/使用/功能时注入（可压缩段，上限 2500） */
export function siteDocSection(siteDoc: string): SkillSection {
  const cap = clamp(siteDoc, 2500);
  return {
    id: "siteDoc",
    text: cap
      ? `【本站操作文档】以下为本站功能与操作说明。用户问"这个站怎么用/怎么操作/有哪些功能"时，请据此准确、分点回答（结合用户具体问的功能）；若用户问的是与本站无关的通用知识，则正常回答、无需引用本节。\n${cap}\n\n---\n\n`
      : "",
  };
}
