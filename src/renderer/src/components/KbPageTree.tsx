/**
 * Notion 式页面树（知识库）。
 * - 缩进嵌套 + 折叠 / 展开（chevron）
 * - 悬停工具栏：＋ 新建子页 / ⋯ 菜单（重命名 / 恢复自动标题 / 删除）
 * - 拖拽（抓柄 ⠿）：
 *   - 同父行上 1/3 / 下 1/3 → before / after 精确重排（本地 order）
 *   - 行中间 或 跨级行上 → 变为该页的子页（改父，Notion 侧「重建+删旧」）
 *   - 拖到树顶部条 → 移到顶层
 * - 纯展示 + 回调；数据与同步由 AgentPanel / kbStore 负责
 */
import { useMemo, useState, useEffect, useRef } from "react";
import { type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { kbParentKey, type KbEntryRecord } from "../lib/kb";

export interface KbPageTreeRow {
  entry: KbEntryRecord;
  depth: number;
  hasChildren: boolean;
}

type DropPos =
  | { type: "row"; id: string; pos: "before" | "after" | "child" }
  | { type: "root" };

export interface KbPageTreeProps {
  entries: KbEntryRecord[];
  activeId?: string;
  collapsed?: Set<string>;
  onToggleCollapse?: (id: string) => void;
  /** 点击页面名 → 打开编辑 */
  onOpen: (entry: KbEntryRecord) => void;
  /** 悬停 ＋ → 新建子页 */
  onNewChild: (entry: KbEntryRecord) => void;
  /** 重命名（提交后由上层锁定标题并同步 Notion） */
  onRename: (id: string, name: string) => void;
  /** 恢复自动标题（清除 titleLocked） */
  onRestoreAutoTitle?: (id: string) => void;
  /** 删除页面 */
  onDelete: (entry: KbEntryRecord) => void;
  /** 同级重排（parentKey：子页 = 父 notionId；顶层 = ""） */
  onReorder: (parentKey: string, orderedIds: string[]) => void;
  /** 改父移动；parentId 缺省 = 移到顶层 */
  onMove: (id: string, parentId?: string) => void;
  /** 正在移动的条目 id（显示 loading 状态） */
  movingId?: string | null;
  /** 自定义空态（可选，默认内置） */
  empty?: ReactNode;
}

export function KbPageTree({
  entries,
  activeId,
  collapsed,
  onToggleCollapse,
  onOpen,
  onNewChild,
  onRename,
  onRestoreAutoTitle,
  onDelete,
  onReorder,
  onMove,
  movingId,
  empty,
}: KbPageTreeProps) {
  // 排序：order 优先，回退 createdAt
  const sortFn = (a: KbEntryRecord, b: KbEntryRecord) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) -
      (b.order ?? Number.MAX_SAFE_INTEGER) ||
    a.createdAt - b.createdAt ||
    a.name.localeCompare(b.name, "zh-CN");

  // 构建扁平行（depth + 折叠）
  const rows = useMemo<KbPageTreeRow[]>(() => {
    const childrenByParent = new Map<string, KbEntryRecord[]>();
    const top: KbEntryRecord[] = [];
    for (const e of entries) {
      const pk = kbParentKey(e, entries);
      if (pk) {
        const arr = childrenByParent.get(pk) || [];
        arr.push(e);
        childrenByParent.set(pk, arr);
      } else {
        top.push(e);
      }
    }
    top.sort(sortFn);
    for (const arr of childrenByParent.values()) arr.sort(sortFn);
    const out: KbPageTreeRow[] = [];
    const walk = (items: KbEntryRecord[], depth: number) => {
      for (const e of items) {
        const kids = childrenByParent.get(e.notionId || e.id || "") || [];
        out.push({ entry: e, depth, hasChildren: kids.length > 0 });
        if (kids.length && !collapsed?.has(e.id)) walk(kids, depth + 1);
      }
    };
    walk(top, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, collapsed]);

  /** 某父组下全部条目 id（按当前顺序） */
  const groupOrderedIds = (parentKey: string): string[] =>
    entries
      .filter((e) => kbParentKey(e, entries) === parentKey)
      .sort(sortFn)
      .map((e) => e.id);

  // ---- 拖拽状态 ----
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropPos | null>(null);
  const dragParentKeyRef = useRef("");
  // ---- 重命名 / 菜单状态 ----
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);

  // 点击外部关闭 ⋯ 菜单
  useEffect(() => {
    if (!menuId) return;
    const h = (e: globalThis.MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.closest(".kimo-kb-tree-menu")) setMenuId(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuId]);

  // ---- 拖拽处理 ----
  const handleDragStart = (e: DragEvent, entry: KbEntryRecord) => {
    setDragId(entry.id);
    dragParentKeyRef.current = kbParentKey(entry, entries);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", entry.id);
    } catch {
      /* 忽略 */
    }
  };
  const handleDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const handleRowDragOver = (e: DragEvent, row: KbPageTreeRow) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 1;
    if (kbParentKey(row.entry, entries) === dragParentKeyRef.current) {
      const pos = y < h * 0.3 ? "before" : y > h * 0.7 ? "after" : "child";
      setDropTarget({ type: "row", id: row.entry.id, pos });
    } else {
      // 跨级：统一按「变为子页」
      setDropTarget({ type: "row", id: row.entry.id, pos: "child" });
    }
  };
  const handleRowDragLeave = (e: DragEvent) => {
    const cur = e.currentTarget as HTMLElement;
    const rel = e.relatedTarget as Node | null;
    if (rel && cur.contains(rel)) return;
    setDropTarget((d) => (d && d.type === "row" ? null : d));
  };
  const handleRowDrop = (e: DragEvent, row: KbPageTreeRow) => {
    if (!dragId) return;
    e.preventDefault();
    // 注意：不 stopPropagation，让文档级 drop（AgentPanel）重置文件拖放浮层
    const target = dropTarget;
    const id = dragId;
    setDropTarget(null);
    setDragId(null);
    if (!target || target.type !== "row") return;
    if (id === row.entry.id) return;
    const dragEntry = entries.find((x) => x.id === id);
    if (!dragEntry) return;
    const dragKey = kbParentKey(dragEntry, entries);
    if (target.pos === "child") {
      const rowKey = row.entry.notionId || row.entry.id || "";
      if (dragKey === rowKey) {
        // 已是其直接子页：移到该组末尾（重排）
        const ids = groupOrderedIds(rowKey);
        onReorder(rowKey, [...ids.filter((x) => x !== id), id]);
      } else {
        onMove(id, row.entry.id);
      }
      return;
    }
    // before / after：仅同父重排；跨级 → 保守语义变为子页
    const targetParent = kbParentKey(row.entry, entries);
    if (dragKey !== targetParent) {
      onMove(id, row.entry.id);
      return;
    }
    const ids = groupOrderedIds(targetParent);
    const without = ids.filter((x) => x !== id);
    const at = without.indexOf(row.entry.id);
    const insertAt = target.pos === "before" ? at : at + 1;
    without.splice(insertAt, 0, id);
    onReorder(targetParent, without);
  };

  // 拖到树顶部条 → 移到顶层（或根组末尾重排）
  const handleRootDrop = (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    // 不 stopPropagation，让文档级 drop 重置文件拖放浮层
    const id = dragId;
    setDropTarget(null);
    setDragId(null);
    const dragEntry = entries.find((x) => x.id === id);
    if (!dragEntry) return;
    if (kbParentKey(dragEntry, entries) === "") {
      const ids = groupOrderedIds("");
      onReorder("", [...ids.filter((x) => x !== id), id]);
    } else {
      onMove(id);
    }
  };

  // ---- 重命名 ----
  const startRename = (entry: KbEntryRecord) => {
    setRenamingId(entry.id);
    setRenameDraft(entry.name);
    setMenuId(null);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const t = renameDraft.trim();
    if (t) onRename(renamingId, t);
    setRenamingId(null);
  };
  const onRenameKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") setRenamingId(null);
  };

  const isDrop = (row: KbPageTreeRow): boolean =>
    !!dropTarget && dropTarget.type === "row" && dropTarget.id === row.entry.id;

  return (
    <div
      className="kimo-kb-tree"
      onDragOver={(e) => {
        if (dragId) e.preventDefault();
      }}
    >
      {/* 顶部拖放条：拖到此处 = 移到顶层 */}
      <div
        className={
          "kimo-kb-tree-top" +
          (dropTarget?.type === "root" ? " active" : "") +
          (dragId ? " dragging" : "")
        }
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.stopPropagation();
          setDropTarget({ type: "root" });
        }}
        onDrop={handleRootDrop}
      >
        {dragId ? "拖到此处 → 移到顶层" : ""}
      </div>

      {rows.length === 0 ? (
        <div className="kimo-kb-tree-empty">
          {empty ||
            (entries.length === 0
              ? "暂无页面，点击「＋ 新建页面」开始"
              : "没有可显示的页面")}
        </div>
      ) : (
        rows.map((row) => {
          const drop = isDrop(row);
          const dropPos =
            drop && dropTarget!.type === "row" ? dropTarget!.pos : null;
          const isMoving = movingId === row.entry.id;
          return (
            <div
              key={row.entry.id}
              className={
                "kimo-kb-tree-row" +
                (activeId === row.entry.id ? " active" : "") +
                (drop ? " drop-" + dropPos : "") +
                (isMoving ? " moving" : "")
              }
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onDragOver={(e) => handleRowDragOver(e, row)}
              onDragLeave={handleRowDragLeave}
              onDrop={(e) => handleRowDrop(e, row)}
            >
              {/* 拖拽抓柄（仅此可拖，避免点击误拖） */}
              <span
                className="kimo-kb-tree-grip"
                draggable
                onDragStart={(e) => handleDragStart(e, row.entry)}
                onDragEnd={handleDragEnd}
                title="拖拽移动"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <circle cx="9" cy="6" r="1.5" />
                  <circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" />
                  <circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" />
                  <circle cx="15" cy="18" r="1.5" />
                </svg>
              </span>

              {/* 折叠箭头 */}
              {row.hasChildren ? (
                <button
                  className="kimo-kb-tree-chev"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCollapse?.(row.entry.id);
                  }}
                  title={
                    collapsed?.has(row.entry.id) ? "展开子页面" : "收起子页面"
                  }
                >
                  <svg
                    className={
                      "h-3 w-3 transition-transform " +
                      (collapsed?.has(row.entry.id) ? "" : "rotate-90")
                    }
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              ) : (
                <span className="kimo-kb-tree-chev" />
              )}

              {renamingId === row.entry.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={onRenameKey}
                  onBlur={commitRename}
                  className="kimo-kb-tree-rename"
                />
              ) : (
                <span
                  className="kimo-kb-tree-name"
                  onClick={() => onOpen(row.entry)}
                  title={
                    row.entry.titleLocked
                      ? `${row.entry.name}（手动重命名）`
                      : row.entry.name
                  }
                >
                  <svg
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                    />
                  </svg>
                  <span className="min-w-0 truncate">{row.entry.name}</span>
                  {isMoving && (
                    <span className="kimo-kb-tree-moving">移动中…</span>
                  )}
                </span>
              )}

              {/* 悬停工具栏 */}
              <span className="kimo-kb-tree-actions">
                <button
                  className="kimo-kb-tree-act"
                  title="新建子页面"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewChild(row.entry);
                  }}
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button
                  className="kimo-kb-tree-act"
                  title="更多操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === row.entry.id ? null : row.entry.id);
                  }}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
              </span>

              {/* ⋯ 菜单 */}
              {menuId === row.entry.id && (
                <div className="kimo-kb-tree-menu">
                  <button onClick={() => startRename(row.entry)}>重命名</button>
                  {row.entry.titleLocked && (
                    <button
                      onClick={() => {
                        onRestoreAutoTitle?.(row.entry.id);
                        setMenuId(null);
                      }}
                    >
                      恢复自动标题
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => {
                      setMenuId(null);
                      onDelete(row.entry);
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
