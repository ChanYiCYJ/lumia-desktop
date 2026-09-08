/**
 * 知识融合 Markdown 渲染组件：支持 AI 输出的 <details> 折叠块 + emoji callout 引用块。
 * - <details> 由 markdownExt.extractDetails 安全提取（不引入 rehype-raw 的 XSS 面），body 内嵌 markdown；
 * - 引用块首行含 💡/⚠️ 等标记 → blockquote.callout（Notion 风格彩色左边条）；
 * - urlTransform 放行 notion://（供未来 Notion 接入）。
 * 独立成文件便于用 react-dom/server renderToStaticMarkup 单测渲染管线。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { extractDetails, splitDetails, safeUrlTransform } from "./markdownExt";

/** 提取 React 子节点纯文本（用于 callout 标记检测） */
function mdExtractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(mdExtractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return mdExtractText(
      (node as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

/** callout：引用块首行含 emoji/警示标记 或 Notion 来源前缀 → 加彩色左边条（Notion 风格 callout） */
const CALLOUT_MARK_RE = /^\s*(?:💡|📌|⚠️|✅|🔍|🛠️|🧠|🌐|Notion)/;

export const CalloutBlockquote = ({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"blockquote"> & { node?: unknown }) => {
  const text = mdExtractText(children);
  const cls = CALLOUT_MARK_RE.test(text) ? "callout" : "";
  return (
    <blockquote {...props} className={cls}>
      {children}
    </blockquote>
  );
};

/** 链接：http(s) 新标签打开；notion:// 等自定义协议照常渲染（urlTransform 已放行） */
export const FusionLink = ({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
  if (!href) return <a {...props}>{children}</a>;
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      {...props}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {children}
    </a>
  );
};

/** 模块级稳定引用（配合 memo，避免每次渲染新建对象击穿缓存） */
export const FUSION_COMPONENTS = {
  blockquote: CalloutBlockquote,
  a: FusionLink,
};

/** 支持 <details> 折叠块 + callout 的 Markdown 渲染（详情块 body 内嵌 markdown） */
export function FusionMarkdown({ content }: { content: string }) {
  const { open, blocks } = useMemo(() => extractDetails(content), [content]);
  const mdProps = {
    remarkPlugins: [remarkGfm],
    urlTransform: safeUrlTransform,
    components: FUSION_COMPONENTS,
  };
  if (blocks.length === 0) {
    return <ReactMarkdown {...mdProps}>{content}</ReactMarkdown>;
  }
  return (
    <>
      {splitDetails(open, blocks).map((part, i) =>
        part.type === "details" ? (
          <details key={i} className="chat-details">
            <summary>{part.block.title || "检索证据"}</summary>
            <div className="chat-details-body">
              <ReactMarkdown {...mdProps}>{part.block.body}</ReactMarkdown>
            </div>
          </details>
        ) : (
          <ReactMarkdown key={i} {...mdProps}>
            {part.text}
          </ReactMarkdown>
        ),
      )}
    </>
  );
}
