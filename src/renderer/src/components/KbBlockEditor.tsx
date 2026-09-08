/**
 * Notion 式块编辑器（基于 BlockNote / TipTap / ProseMirror）。
 * - 内置斜杠命令（/）、块拖拽/手柄、Tab 嵌套、格式菜单
 * - 无独立标题框：标题由正文首个 H1 / 首行推导（见 deriveEntryTitle）
 * - 内容以 Markdown 与外部存储（知识库条目 / Notion）互转
 *   - 载入：tryParseMarkdownToBlocks（仅首次种子化，避免空闪）
 *   - 输出：blocksToMarkdownLossy → onChange(markdown)
 * - 图片粘贴/拖拽上传复用项目 uploadApi.image
 * - 语言：BlockNote 内置 zh 中文 locale
 */
import { useLayoutEffect, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { type BlockNoteEditor } from "@blocknote/core";
import { zh } from "@blocknote/core/locales";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { resolveAsset, uploadApi } from "../lib/api";
import { useTheme } from "../lib/theme";

export interface KbBlockEditorProps {
  /** Markdown 初值（仅首次种子化；之后由编辑器自身驱动，不回灌） */
  value: string;
  /** 内容变更回调（输出 Markdown） */
  onChange: (markdown: string) => void;
  /** 空态占位提示（覆盖 BlockNote 默认中文占位） */
  placeholder?: string;
}

export function KbBlockEditor({
  value,
  onChange,
  placeholder,
}: KbBlockEditorProps) {
  const { theme } = useTheme();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useCreateBlockNote({
    // 不传 initialContent（BlockNote 0.53 拒绝空数组 `[]`，会抛 "Error creating
    // document from blocks passed as initialContent"）；默认空文档在首帧用 value 种子化
    dictionary: placeholder
      ? {
          ...zh,
          placeholders: {
            ...zh.placeholders,
            default: placeholder,
          },
        }
      : zh,
    uploadFile: async (file: File) => {
      try {
        const res = await uploadApi.image(file);
        return resolveAsset(res.url);
      } catch {
        return "";
      }
    },
  });

  // 首帧绘制前用 value 种子化，避免空白闪现；之后仅由 onChange 驱动，不重复 seed。
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const md = (value || "").trim();
    if (md) {
      const blocks = editor.tryParseMarkdownToBlocks(md);
      editor.replaceBlocks(editor.document, blocks);
    }
    // 仅依赖 editor 实例（创建后 seed 一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const handleChange = (ed: BlockNoteEditor) => {
    onChangeRef.current(ed.blocksToMarkdownLossy(ed.document));
  };

  return (
    <BlockNoteView
      editor={editor}
      theme={theme}
      onChange={handleChange}
      className="kimo-block-editor"
      style={{ height: "100%", overflowY: "auto" }}
    />
  );
}
