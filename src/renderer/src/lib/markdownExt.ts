/**
 * Markdown 渲染扩展：安全处理 AI 输出的 `<details>` 折叠块 + 放行 notion:// 链接。
 *
 * 为什么不用 rehype-raw？react-markdown 默认丢弃原始 HTML；rehype-raw 会把任意
 * 原始 HTML（含 `<script>`/`<img onerror>` 等 XSS 面）解析进渲染树。这里先用正则
 * 提取 `<details>…</details>` 块替换为占位 token，主体仍走 ReactMarkdown，折叠块
 * 由组件层渲染（body 再套一层 ReactMarkdown），既支持折叠又无原始 HTML 注入面。
 */

/** 一个被提取的折叠块 */
export interface DetailsBlock {
  /** <summary> 标题（缺省为空字符串） */
  title: string;
  /** </summary> 之后、</details> 之前的内容（支持嵌套 markdown） */
  body: string;
}

export interface DetailsParseResult {
  /** 提取后的主体（details 块已被占位 token 替换） */
  open: string;
  /** 提取出的折叠块（按出现顺序） */
  blocks: DetailsBlock[];
}

/** <details>…</details>（允许 <details open> 等属性） */
const DETAILS_RE = /<details[^>]*>([\s\S]*?)<\/details>/gi;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/i;

/** 占位 token：唯一、不会被 markdown 解析 */
export const detailsPlaceholder = (i: number): string =>
  `\u0000kimoDetails${i}\u0000`;

const PLACEHOLDER_RE = /\u0000kimoDetails(\d+)\u0000/g;

/**
 * 从 markdown 中提取 <details>…</details> 折叠块。
 * - 未闭合的 <details>（无 </details>）整块不提取（保持原样，由 ReactMarkdown 丢弃）；
 * - 无 <summary> 的块 title 为空、body 为内部全文。
 */
export function extractDetails(md: string): DetailsParseResult {
  const blocks: DetailsBlock[] = [];
  const open = md.replace(DETAILS_RE, (whole, inner: string) => {
    const summaryMatch = whole.match(SUMMARY_RE);
    let title = "";
    let body = "";
    if (summaryMatch) {
      title = summaryMatch[1].trim();
      const afterSummary = whole.slice(
        summaryMatch.index! + summaryMatch[0].length,
      );
      body = afterSummary.slice(0, afterSummary.length - "</details>".length);
    } else {
      // 无 <summary>：body 取 <details>…</details> 内部内容
      body = inner;
    }
    blocks.push({ title, body: body.trim() });
    return detailsPlaceholder(blocks.length - 1);
  });
  return { open, blocks };
}

/**
 * 按占位 token 把「主体 + 折叠块」还原为有序片段。
 * 返回数组元素为 `{ type: "md"; text }` 或 `{ type: "details"; block }`。
 */
export function splitDetails(
  open: string,
  blocks: DetailsBlock[],
): Array<{ type: "md"; text: string } | { type: "details"; block: DetailsBlock }> {
  const parts: Array<
    { type: "md"; text: string } | { type: "details"; block: DetailsBlock }
  > = [];
  let last = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(open)) !== null) {
    const before = open.slice(last, m.index).trim();
    if (before) parts.push({ type: "md", text: before });
    const idx = Number(m[1]);
    const block = blocks[idx];
    if (block) parts.push({ type: "details", block });
    last = m.index + m[0].length;
  }
  const tail = open.slice(last).trim();
  if (tail) parts.push({ type: "md", text: tail });
  return parts;
}

/** react-markdown 默认 URL 安全策略，额外放行 notion://（Notion 页面链接协议） */
export function safeUrlTransform(value: string): string {
  // 同 react-markdown v10 defaultUrlTransform：http/https/irc/mailto/xmpp + 相对/锚点/带协议后斜杠
  if (/^notion:\/\//i.test(value)) return value;
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}
