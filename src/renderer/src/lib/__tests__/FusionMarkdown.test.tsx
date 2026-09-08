import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FusionMarkdown } from "../FusionMarkdown";

const FUSION_MD = `> 💡 **核心结论**
> React 是 Meta 维护的 UI 库。

### 🔍 详细分析

- 🧠 本地：知识库有 React 入门笔记
- 🌐 网络：官方文档显示 React 19 已发布

<details>
<summary>🔍 查看检索证据（2 条）</summary>

- 🧠 本地 [0.92] React 入门
- 🌐 网络 [0.85] react.dev

</details>

*🧠 本地 2条 · 🌐 网络 1条*`;

describe("FusionMarkdown 渲染（details/callout/notion）", () => {
  it("emoji 开头引用块渲染为 blockquote.callout", () => {
    const html = renderToStaticMarkup(<FusionMarkdown content={FUSION_MD} />);
    expect(html).toContain('blockquote class="callout"');
    expect(html).toContain("💡");
    expect(html).toContain("<strong>核心结论</strong>");
  });

  it("<details> 折叠块渲染为 details.chat-details + summary + body", () => {
    const html = renderToStaticMarkup(<FusionMarkdown content={FUSION_MD} />);
    expect(html).toContain('<details class="chat-details">');
    expect(html).toContain("<summary>🔍 查看检索证据（2 条）</summary>");
    expect(html).toContain('<div class="chat-details-body">');
    expect(html).toContain("🧠 本地 [0.92] React 入门");
    expect(html).toContain("🌐 网络 [0.85] react.dev");
  });

  it("普通 markdown（无 details）行为不变", () => {
    const html = renderToStaticMarkup(
      <FusionMarkdown content="**你好**世界" />,
    );
    expect(html).toContain("<strong>你好</strong>");
    expect(html).not.toContain("chat-details");
  });

  it("普通引用块（无 emoji 标记）不加 callout 类", () => {
    const html = renderToStaticMarkup(
      <FusionMarkdown content="> 这是普通引用" />,
    );
    expect(html).toContain("<blockquote");
    expect(html).not.toContain('blockquote class="callout"');
  });

  it("Notion 来源前缀引用块渲染为 blockquote.callout（替代 📓 emoji 标注）", () => {
    const html = renderToStaticMarkup(
      <FusionMarkdown content="> Notion 工作区页面：如何度过每天 24 小时" />,
    );
    expect(html).toContain('blockquote class="callout"');
    expect(html).toContain("Notion 工作区页面");
  });

  it("notion:// 链接不被剥离", () => {
    const html = renderToStaticMarkup(
      <FusionMarkdown content="[Notion 页面](notion://abc-123)" />,
    );
    expect(html).toContain('href="notion://abc-123"');
  });

  it("危险协议仍被 urlTransform 拦截", () => {
    const html = renderToStaticMarkup(
      <FusionMarkdown content="[x](javascript:alert(1))" />,
    );
    expect(html).not.toContain('href="javascript:');
  });
});
