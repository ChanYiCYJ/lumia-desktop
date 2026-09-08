import { articleApi, categoryApi } from "./api";
import type { ArticleListItem, Category } from "./types";

/**
 * 知识库（KB）：可选文章/分类 + 本机浏览器自定义笔记
 * - 站点内容选择按机器人（pageId）分开保存
 * - 自定义笔记保存在本机浏览器（localStorage），任何人都可添加，不依赖账号
 */

export interface KbNote {
  id: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface KbSelections {
  articleIds: number[];
  categoryIds: number[];
  includeNotes: boolean;
}

export interface KbOptions {
  articles: ArticleListItem[];
  categories: Category[];
}

const NOTES_KEY = "kimo_kb_notes";
const SEL_PREFIX = "kimo_kb_sel_";

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- 本机自定义笔记（浏览器级，所有机器人共享） ----
export function getKbNotes(): KbNote[] {
  try {
    const r = JSON.parse(localStorage.getItem(NOTES_KEY) || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

export function saveKbNotes(notes: KbNote[]): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {
    /* 忽略 */
  }
}

export function addKbNote(title: string, content: string): KbNote[] {
  const notes = getKbNotes();
  const note: KbNote = {
    id: uid(),
    title: title.trim(),
    content: content.trim(),
    createdAt: Date.now(),
  };
  notes.unshift(note);
  saveKbNotes(notes);
  return notes;
}

export function updateKbNote(
  id: string,
  title: string,
  content: string,
): KbNote[] {
  const notes = getKbNotes().map((n) =>
    n.id === id ? { ...n, title: title.trim(), content: content.trim() } : n,
  );
  saveKbNotes(notes);
  return notes;
}

export function removeKbNote(id: string): KbNote[] {
  const notes = getKbNotes().filter((n) => n.id !== id);
  saveKbNotes(notes);
  return notes;
}

// ---- 每个机器人的选择 ----
export function getKbSelections(pageId: number): KbSelections {
  try {
    const r = JSON.parse(localStorage.getItem(SEL_PREFIX + pageId) || "");
    if (r && Array.isArray(r.articleIds) && Array.isArray(r.categoryIds)) {
      return {
        articleIds: r.articleIds,
        categoryIds: r.categoryIds,
        includeNotes: r.includeNotes !== false,
      };
    }
  } catch {
    /* 忽略 */
  }
  return { articleIds: [], categoryIds: [], includeNotes: true };
}

export function saveKbSelections(pageId: number, sel: KbSelections): void {
  try {
    localStorage.setItem(SEL_PREFIX + pageId, JSON.stringify(sel));
  } catch {
    /* 忽略 */
  }
}

// ---- 加载站点内容（翻页取全部文章） ----
export async function loadKbOptions(): Promise<KbOptions> {
  const [articles, categories] = await Promise.all([
    loadAllArticles(),
    categoryApi.list().catch(() => [] as Category[]),
  ]);
  return { articles, categories };
}

async function loadAllArticles(): Promise<ArticleListItem[]> {
  const all: ArticleListItem[] = [];
  try {
    let page = 1;
    for (let i = 0; i < 20; i++) {
      const r = await articleApi.list(page);
      all.push(...r.items);
      if (r.items.length === 0 || all.length >= r.total || page >= r.total_page)
        break;
      page++;
    }
  } catch {
    /* 忽略 */
  }
  return all;
}

// ---- 组装知识库文本（发送时调用，已缓存到 AIChat） ----
export async function assembleKnowledge(
  sel: KbSelections,
  notes: KbNote[],
): Promise<string> {
  const parts: string[] = [];
  const { articles, categories } = await loadKbOptions();

  const selectedArticles = articles.filter((a) =>
    sel.articleIds.includes(a.id),
  );
  if (selectedArticles.length) {
    parts.push(
      "【文章】\n" +
        selectedArticles
          .map(
            (a) =>
              `- 《${a.title}》[${a.category_name || "未分类"}]：${a.description || ""}`,
          )
          .join("\n"),
    );
  }

  const selectedCategories = categories.filter((c) =>
    sel.categoryIds.includes(c.id),
  );
  if (selectedCategories.length) {
    parts.push(
      "【分类】\n" +
        selectedCategories.map((c) => `- ${c.name}(/${c.slug})`).join("\n"),
    );
  }

  if (sel.includeNotes) {
    const valid = notes.filter((n) => n.title || n.content);
    if (valid.length) {
      parts.push(
        "【自定义笔记】\n" +
          valid.map((n) => `- ${n.title}：${n.content}`).join("\n"),
      );
    }
  }

  return parts.join("\n\n");
}

// ---- 导出知识库为 Markdown ----
export function downloadText(filename: string, text: string): void {
  const blob = new Blob(["\uFEFF" + text], {
    type: "text/markdown;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ================= AI 工具调用解析：创建/编辑/删除知识库 =================
// AI 回复格式：
//   [KB-SAVE:标题]内容[/KB-SAVE]   —— 新建或按标题更新一条知识库
//   [KB-EDIT:标题]新内容[/KB-EDIT] —— 修改已有知识库条目（按标题匹配）
//   [KB-DELETE:标题]              —— 删除已有知识库条目（含同步删除 Notion 页面）
export interface KbToolCmd {
  mode: "save" | "edit" | "delete";
  title: string;
  content: string;
}

export function parseKbTool(reply: string): KbToolCmd | null {
  // 快速失败：不含标记直接返回（避免大文本正则回溯）
  if (
    !reply.includes("KB-SAVE") &&
    !reply.includes("KB-EDIT") &&
    !reply.includes("KB-DELETE")
  )
    return null;

  // 解析 [KB-SAVE:标题]内容[/KB-SAVE]（兼容漏写 [/KB-SAVE] 闭合：取到下一个工具标记或结尾）
  const saveOpen = "[KB-SAVE:";
  const saveIdx = reply.indexOf(saveOpen);
  if (saveIdx >= 0) {
    const titleEnd = reply.indexOf("]", saveIdx + saveOpen.length);
    if (titleEnd > saveIdx) {
      const title = reply.slice(saveIdx + saveOpen.length, titleEnd).trim();
      const closeTag = "[/KB-SAVE]";
      const closeIdx = reply.indexOf(closeTag, titleEnd + 1);
      let content = "";
      if (closeIdx >= 0) {
        content = reply.slice(titleEnd + 1, closeIdx).trim();
      } else {
        // 未闭合：取到下一个工具指令标记或结尾（避免把后续指令吞进内容）
        const rest = reply.slice(titleEnd + 1);
        const nextTool = rest.search(
          /\[(?:SEARCH|BROWSE|VIEW|EDIT|KB-SAVE|KB-EDIT|KB-DELETE|KB|OPEN_KB|知识库):/i,
        );
        content = (nextTool >= 0 ? rest.slice(0, nextTool) : rest).trim();
      }
      if (title) return { mode: "save", title, content };
    }
  }

  // 解析 [KB-EDIT:标题]新内容[/KB-EDIT]（同样兼容未闭合）
  const editOpen = "[KB-EDIT:";
  const editIdx = reply.indexOf(editOpen);
  if (editIdx >= 0) {
    const titleEnd = reply.indexOf("]", editIdx + editOpen.length);
    if (titleEnd > editIdx) {
      const title = reply.slice(editIdx + editOpen.length, titleEnd).trim();
      const closeTag = "[/KB-EDIT]";
      const closeIdx = reply.indexOf(closeTag, titleEnd + 1);
      let content = "";
      if (closeIdx >= 0) {
        content = reply.slice(titleEnd + 1, closeIdx).trim();
      } else {
        const rest = reply.slice(titleEnd + 1);
        const nextTool = rest.search(
          /\[(?:SEARCH|BROWSE|VIEW|EDIT|KB-SAVE|KB-EDIT|KB-DELETE|KB|OPEN_KB|知识库):/i,
        );
        content = (nextTool >= 0 ? rest.slice(0, nextTool) : rest).trim();
      }
      if (title) return { mode: "edit", title, content };
    }
  }

  // 解析 [KB-DELETE:标题]（按标题删除，含同步删除 Notion 页面）
  const delOpen = "[KB-DELETE:";
  const delIdx = reply.indexOf(delOpen);
  if (delIdx >= 0) {
    const titleEnd = reply.indexOf("]", delIdx + delOpen.length);
    if (titleEnd > delIdx) {
      const title = reply.slice(delIdx + delOpen.length, titleEnd).trim();
      if (title) return { mode: "delete", title, content: "" };
    }
  }

  return null;
}

/** 按标题（忽略大小写/首尾空格）在笔记列表中找到条目 */
export function findKbNoteByTitle(
  notes: KbNote[],
  title: string,
): KbNote | undefined {
  const t = title.trim().toLowerCase();
  return notes.find((n) => n.title.trim().toLowerCase() === t);
}

/**
 * 知识库保存意图检测：用户消息含明确「帮我记/保存到知识库/收藏」等表达时，提取要保存的内容。
 * 用于 AI 漏发 [KB-SAVE:] 时的前端兜底，保证知识库操作可靠。只用明确意图词，降低误触发。
 */
export function detectKbSaveIntent(
  raw: string,
): { title: string; content: string } | null {
  const t = raw.trim();
  // 明确意图词（按长度降序，优先匹配更具体的表达）
  const intents = [
    "保存到知识库",
    "存入知识库",
    "存到知识库",
    "放进知识库",
    "加入知识库",
    "添加到知识库",
    "写进知识库",
    "记入知识库",
    "保存到笔记",
    "存入笔记",
    "帮我记一下",
    "帮我记下",
    "帮我记录一下",
    "帮我保存",
    "帮我存一下",
    "帮我记",
    "记一下",
    "记录一下",
    "记笔记",
    "收藏一下",
    "收藏",
    "保存一下",
    "记下来",
    "记下",
  ];
  for (const kw of intents) {
    const idx = t.indexOf(kw);
    if (idx < 0) continue;
    let content = t
      .slice(idx + kw.length)
      .replace(/^[\s:：,，。.、!！?？"'“”]+/, "")
      .replace(/^(一下|好|了|吧)\s*[:：,，。\s]*/, "")
      .trim();
    if (!content || content.length < 2) continue;
    // 标题：无独立标题框，由正文推导（H1 优先，否则首行前 30 字）
    const title = deriveEntryTitle(content, "我的笔记");
    return { title, content };
  }
  return null;
}

// ---- 知识条目存储（与 AgentPanel 同构：kimo_kb_entries 为准 + 同步 kimo_kb_notes）----
export interface KbEntryRecord {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  /** 已同步到的 Notion 页面 id（双写/删除时使用）；未同步时缺省 */
  notionId?: string;
  /** 最近一次成功同步到 Notion 的时间戳（拉取时判断是否被 Notion 侧更新覆盖） */
  notionSyncedAt?: number;
  /** Content access 根页面 id（该条目所属根；1 根=整个知识库，≥2 根=按根分类） */
  notionRootId?: string;
  /** Content access 根页面标题（分类组名） */
  notionRootName?: string;
  /** 父页面 id（子页面有值；用于知识库内子页面树嵌套） */
  notionParentId?: string;
  /** 父页面标题 */
  notionParentName?: string;
  /** 本地父条目 id（未同步页面的父子关系；已同步页面用 notionParentId 关联 Notion 父页） */
  parentId?: string;
  /** 本地排序序号（同父兄弟重排用；Notion API 无法设置子页面顺序，仅本地持久化） */
  order?: number;
  /** 手动重命名后锁定标题（正文 H1/首行变化不再覆盖 name；可在 UI「恢复自动标题」解锁） */
  titleLocked?: boolean;
}

const ENTRIES_KEY = "kimo_kb_entries";

export function loadKbEntries(): KbEntryRecord[] {
  try {
    const r = JSON.parse(localStorage.getItem(ENTRIES_KEY) || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** 标题推导的最大字符数（无独立标题框，取首行/H1 文本前 30 字） */
const KB_TITLE_MAX = 30;

/** 去除行内 Markdown 标记，获得可读纯文本（用于推导标题） */
function stripInlineMd(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从 Markdown 正文推导页面标题（Notion 式「首行即标题」，无独立标题框）：
 * 1) 优先取首个 `# ` 一级标题（H1）文本；
 * 2) 无 H1 → 取首行去除 markdown 标记后的前 KB_TITLE_MAX 字；
 * 3) 空内容/无可读文本 → 回退 fallback。
 */
export function deriveEntryTitle(
  content: string,
  fallback = "我的笔记",
): string {
  const c = (content || "").trim();
  if (!c) return fallback;
  // 仅匹配同行的一级标题（`# ` + 同行文本），避免 \s 跨换行误判
  const h1 = c.match(/^#[ \t]+([^\r\n]+)$/m);
  const h1Text = stripInlineMd(h1 ? h1[1] : "");
  if (h1Text) return h1Text.slice(0, KB_TITLE_MAX);
  const firstLine = c.split(/\r?\n/, 1)[0] || "";
  const plain = stripInlineMd(firstLine.trim());
  return plain ? plain.slice(0, KB_TITLE_MAX) : fallback;
}

// ---- 页面树排序 / 移动（本地纯函数；Notion 侧顺序 / 父级变更见 kbStore.moveKbEntry） ----

/**
 * 有效父键：子页 → 父条目的分组键；顶层 → ""。
 * - 已同步页面：用 notionParentId（父页面的 notionId）分组；
 * - 未同步页面：用 parentId（父条目的本地 id）分组；
 * - 父不在条目集 / 容器页 → ""（顶层）。
 */
export function kbParentKey(
  e: KbEntryRecord,
  entries: KbEntryRecord[],
): string {
  if (e.notionId) {
    const pid = e.notionParentId || "";
    return pid && entries.some((x) => x.notionId === pid) ? pid : "";
  }
  const pid = e.parentId || "";
  return pid && entries.some((x) => x.id === pid) ? pid : "";
}

/** 判断 id 是否为 targetId 的后代（防把父页拖到自身子页下形成环） */
export function isKbDescendant(
  entries: KbEntryRecord[],
  targetId: string,
  id: string,
): boolean {
  if (id === targetId) return true;
  const byId = new Map(entries.map((e) => [e.id, e]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.id === targetId) return true;
    const pid = kbParentKey(cur, entries);
    let parent: KbEntryRecord | undefined;
    if (pid) {
      parent = cur.notionId
        ? entries.find((x) => x.notionId === pid)
        : byId.get(pid);
    }
    cur = parent;
  }
  return false;
}

/**
 * 同级重排：把 parentKey 组（子页 = 父 notionId 或父本地 id；顶层 = ""）的条目按 orderedIds 重编号 order。
 * 仅本地持久化（Notion API 无法设置子页面顺序）。
 */
export function reorderKbEntries(
  entries: KbEntryRecord[],
  parentKey: string,
  orderedIds: string[],
): KbEntryRecord[] {
  const orderById = new Map(orderedIds.map((id, i) => [id, i]));
  return entries.map((e) => {
    if (kbParentKey(e, entries) !== parentKey) return e;
    const idx = orderById.get(e.id);
    return idx === undefined ? e : { ...e, order: idx };
  });
}

/**
 * 改父（本地）：把条目移动到新父下（newParentId 为父条目的本地 id；"" = 移到顶层）。
 * - 旧兄弟重编号（移除后重排 order）
 * - 新兄弟末尾追加（order = 新兄弟数）
 * - 继承新父的 root/parent；顶层保留原 root（「知识库」容器）
 * - 已同步条目 → 用 notionParentId 关联（新父须已同步）；否则用 parentId 本地关联
 * 仅本地；Notion 侧的父级变更由 kbStore.moveKbEntry 处理（重建 + 删旧）。
 */
export function reparentKbEntry(
  entries: KbEntryRecord[],
  id: string,
  newParentId: string,
): KbEntryRecord[] {
  const target = entries.find((e) => e.id === id);
  if (!target) return entries;
  const oldKey = kbParentKey(target, entries);
  const newKey = newParentId || "";
  const newParent = newParentId
    ? entries.find((e) => e.id === newParentId)
    : undefined;
  const newParentNotionId = newParent?.notionId || "";
  const newRootId = newParentId
    ? newParent?.notionRootId || newParentNotionId
    : target.notionRootId;
  const newRootName = newParentId
    ? newParent?.notionRootName || newParent?.name || ""
    : target.notionRootName;
  // 已同步条目且新父已同步 → 用 notionParentId 关联；否则用 parentId（本地）
  const useNotionParent = !!target.notionId && !!newParentNotionId;
  const newSiblings = entries.filter(
    (e) => kbParentKey(e, entries) === newKey && e.id !== id,
  );
  const oldSiblings = entries.filter(
    (e) => kbParentKey(e, entries) === oldKey && e.id !== id,
  );
  const oldOrder = new Map(oldSiblings.map((e, i) => [e.id, i]));
  return entries.map((e) => {
    if (e.id === id) {
      return {
        ...e,
        notionParentId: useNotionParent ? newParentNotionId : undefined,
        notionParentName: useNotionParent ? newParent?.name || "" : undefined,
        parentId: useNotionParent ? undefined : newParentId || undefined,
        notionRootId: newRootId,
        notionRootName: newRootName,
        order: newSiblings.length,
      };
    }
    const oi = oldOrder.get(e.id);
    return oi === undefined ? e : { ...e, order: oi };
  });
}

/**
 * AI 创建/编辑知识库条目（按标题匹配，命中则更新，否则新建）。
 * 同步写 kimo_kb_entries 与 kimo_kb_notes，返回目标条目。
 */
export function saveKbEntry(title: string, content: string): KbEntryRecord {
  const entries = loadKbEntries();
  const t = title.trim();
  const existing = entries.find(
    (e) => e.name.trim().toLowerCase() === t.toLowerCase(),
  );
  let entry: KbEntryRecord;
  let next: KbEntryRecord[];
  if (existing) {
    entry = { ...existing, content };
    next = entries.map((e) => (e.id === existing.id ? entry : e));
  } else {
    entry = { id: uid(), name: t, content, createdAt: Date.now() };
    next = [entry, ...entries];
  }
  try {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  saveKbNotes(
    next.map((e) => ({
      id: e.id,
      title: e.name,
      content: e.content,
      createdAt: e.createdAt,
    })),
  );
  return entry;
}

// ================= 编辑器临时草稿（本机存储，非知识条目） =================
export interface KbDraft {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}

const DRAFTS_KEY = "kimo_editor_drafts";

export function loadEditorDrafts(): KbDraft[] {
  try {
    const r = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** 保存一份临时草稿（同一名字会覆盖），返回最新列表 */
export function addEditorDraft(content: string, name?: string): KbDraft[] {
  const draft: KbDraft = {
    id: uid(),
    name:
      (name && name.trim()) ||
      "草稿 " +
        new Date().toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
    content,
    createdAt: Date.now(),
  };
  const next = [draft, ...loadEditorDrafts()].slice(0, 20);
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  return next;
}

export function removeEditorDraft(id: string): KbDraft[] {
  const next = loadEditorDrafts().filter((d) => d.id !== id);
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  return next;
}
