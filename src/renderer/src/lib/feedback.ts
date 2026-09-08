/**
 * 用户满意度反馈模块
 *
 * 存储：localStorage kimo_feedback_{pageId}（按消息内容哈希索引的反馈记录）
 * 整合：👍/👎 反馈 → 偏好学习 → 搜索定式优化
 */

// ====== 类型 ======

export interface FeedbackEntry {
  /** 消息内容前 100 字的简单哈希（用于去重索引） */
  msgHash: string;
  /** 1=满意，-1=不满意 */
  rating: 1 | -1;
  /** 触发该回答的用户查询 */
  query: string;
  /** 使用的模型 */
  model: string;
  /** 时间戳 */
  ts: number;
  /** 该回答对应的搜索结果数（如有） */
  searchResults?: number;
}

export interface FeedbackStats {
  total: number;
  positive: number;
  negative: number;
  /** 好评率 0-1 */
  ratio: number;
  /** 好评查询类型分布 */
  positiveTopics: string[];
  /** 差评查询类型分布 */
  negativeTopics: string[];
}

// ====== 存储键 ======

function feedbackKey(pageId: string | number): string {
  return `kimo_feedback_${pageId}`;
}

/** 消息内容 → 简单哈希（前 100 字 + 长度） */
export function hashMessage(content: string): string {
  const s = (content || "").trim().slice(0, 100);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `${s.length}:${h.toString(36)}`;
}

// ====== 读写 ======

export function loadFeedback(pageId: string | number): FeedbackEntry[] {
  try {
    const raw = localStorage.getItem(feedbackKey(pageId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveFeedback(pageId: string | number, entries: FeedbackEntry[]): void {
  try {
    localStorage.setItem(feedbackKey(pageId), JSON.stringify(entries));
  } catch {
    /* quota exceeded */
  }
}

export function saveFeedbackEntry(
  pageId: string | number,
  entry: FeedbackEntry,
): void {
  const list = loadFeedback(pageId);
  const idx = list.findIndex((e) => e.msgHash === entry.msgHash);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  // 最多保留 200 条
  saveFeedback(pageId, list.slice(-200));
}

export function getFeedbackForHash(
  pageId: string | number,
  msgHash: string,
): FeedbackEntry | undefined {
  return loadFeedback(pageId).find((e) => e.msgHash === msgHash);
}

/** 获取单条消息的评价（1=👍, -1=👎, 0=未评价） */
export function getRating(
  pageId: string | number,
  msgHash: string,
): 0 | 1 | -1 {
  const e = getFeedbackForHash(pageId, msgHash);
  return e ? e.rating : 0;
}

export function clearFeedback(pageId: string | number): void {
  try {
    localStorage.removeItem(feedbackKey(pageId));
  } catch {
    /* ignore */
  }
}

// ====== 分析 ======

/** 统计反馈分布 */
export function analyzeFeedback(entries: FeedbackEntry[]): FeedbackStats {
  const list = Array.isArray(entries) ? entries : [];
  const positive = list.filter((e) => e.rating === 1);
  const negative = list.filter((e) => e.rating === -1);

  const topics = (es: FeedbackEntry[]) =>
    es
      .map((e) => e.query)
      .filter(Boolean)
      .slice(0, 10);

  return {
    total: list.length,
    positive: positive.length,
    negative: negative.length,
    ratio: list.length > 0 ? positive.length / list.length : 0,
    positiveTopics: topics(positive),
    negativeTopics: topics(negative),
  };
}

// ====== 偏好学习辅助 ======

/**
 * 从好评回答中提取偏好关键词（用于注入 personaKnowledge）。
 * 参数 query 是原始用户提问，reply 是 AI 回答。
 */
export function extractPositivePattern(reply: string, query: string): string {
  const r = (reply || "").trim();
  const q = (query || "").trim();
  if (!r || !q) return "";

  const len = r.length;
  const patterns: string[] = [];

  // 检测回答风格偏好
  if (len > 800) patterns.push("偏好详细回答");
  else if (len > 200) patterns.push("偏好适中长度的回答");
  else patterns.push("偏好简洁回答");

  // 检测结构化偏好
  if (r.includes("```") || r.includes("**") || /^#+\s/.test(r))
    patterns.push("偏好结构化/Markdown 格式");
  if (/\d+\.\s/.test(r)) patterns.push("偏好条列式回答");
  if (r.includes("|") && r.includes("---")) patterns.push("偏好表格数据");

  // 检测来源偏好
  if (/来源|参考|根据|source|参考链接/.test(r)) patterns.push("偏好多来源引用");

  // 结合查询主题
  const topic = q.slice(0, 20).replace(/\s+/g, "");
  if (topic) patterns.push(`对「${topic}」类问题偏好高质量回答`);

  return patterns.join("；");
}

/**
 * 从差评回答中提取避坑模式（用于注入 memory）。
 */
export function extractNegativePattern(reply: string, query: string): string {
  const r = (reply || "").trim();
  const q = (query || "").trim();
  if (!r) return "";

  const patterns: string[] = [];

  if (r.length < 60) patterns.push("回答过短、信息不足");
  if (r.length > 2000) patterns.push("回答过长、冗余");
  if (/抱歉|对不起|无法|不能|没有.*信息/i.test(r))
    patterns.push("回答回避/无法提供有效信息");
  if (!q) patterns.push("回答与问题不相关");

  return patterns.join("；");
}
