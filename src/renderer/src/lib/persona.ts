// ===== auto-knowledge 人格笔记：Mem0 风格（单趟 ADD-only + 实体链接去重）=====
// 借鉴 Mem0 新算法：记忆只增不改（ADD-only）；抽取规范实体（entity），
// 同一实体的多条笔记合并为最新一条，避免同一话题重复堆积 → 减少注入 token + 提高相关性。
// 纯函数、可单测。

/** 归一化实体键：去标点/空白/大小写，截断上限，用于去重比较 */
export function normalizePersonaEntity(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[，,。；;！!？?、\s"'“”‘’《》【】（）()·\-–—:：/\\]+/g, "")
    .slice(0, 12);
}

/**
 * 从一条人格笔记中抽取规范实体（话题标签）。
 * - 「资料：xxx（已自动补充）」→ 实体 = xxx；
 * - 「用户喜欢柚子社」→ 剥主语/动词前缀后取话题「柚子社」；
 * - 其余取首个话题片段（≤12 字），保底用整条。
 */
export function extractPersonaEntity(note: string): string {
  const s = (note || "").trim().replace(/^[-*·\s]+/, "");
  if (!s) return "";

  // 资料补充条目：实体 = 关键词本身
  const info = s.match(/^资料[:：]\s*([^（(]+)/);
  if (info) {
    return normalizePersonaEntity(
      info[1].replace(/（已自动补充）.*$/, "").trim(),
    );
  }

  // 剥常见主语/副词 → 动词 → 结尾语气词，再取主题片段（分多次 replace，因 replace 只剥首个匹配）
  const cleaned = s
    .replace(
      /^(用户|我|ta|他|她|你|这位|这个|平时|一般|总是|非常|特别|其实|好像|觉得|认为|提到|聊到|想要|更|最|太|超|好|真|确实|还是|反而|居然|竟然)+/,
      "",
    )
    .replace(
      /^(喜欢|偏爱|偏好|爱|讨厌|对|关于|擅长|常|习惯|在|玩|看|听|吃)+/,
      "",
    )
    .trim();
  const m = cleaned.match(/^([^，,。；;！？!?、]{2,})/);
  const topic = (m ? m[1] : cleaned)
    .slice(0, 12)
    .replace(/[的了呀啊呢吧]+$/, "");
  return normalizePersonaEntity(topic || s.slice(0, 12));
}

export interface PersonaNote {
  entity: string;
  text: string;
}

/** 把人格笔记文本（每行一条）解析为带实体的数组 */
export function parsePersonaNotes(text: string): PersonaNote[] {
  return (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ text: l, entity: extractPersonaEntity(l) }));
}

/** 单趟 ADD-only + 按实体去重（同实体保留最后一条），上限 max 条 */
export function dedupePersonaNotes(text: string, max = 12): string {
  const seen = new Map<string, string>();
  for (const n of parsePersonaNotes(text)) {
    if (!n.entity) continue;
    seen.set(n.entity, n.text); // 同实体：覆盖为最新
  }
  return [...seen.values()].slice(-max).join("\n");
}

/** 合并新笔记进已有笔记：实体去重 + 上限，返回合并后文本 */
export function mergePersonaNote(
  existing: string,
  note: string,
  max = 12,
): string {
  return dedupePersonaNotes(
    (existing ? existing + "\n" : "") + "- " + note,
    max,
  );
}
