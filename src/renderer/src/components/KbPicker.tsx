import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { NotionIcon } from "./ui";

interface KbNote {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  /** 已同步 Notion 页面 id（有则显示 Notion 图标） */
  notionId?: string;
  /** 父页面 id（子页面有值；用于层级缩进展示） */
  notionParentId?: string;
}

/** 展开列表默认渲染上限（超出用「展开全部」按需扩量，避免 100+ 条时全量渲染卡顿） */
const MAX_VISIBLE = 50;

/**
 * 知识库条目行（memo：selected/过滤变化时未变行不重渲染）。
 * 命中状态用 Set 判定（O(1)），避免每次渲染对 selected 数组线性扫描。
 */
const KbRow = memo(function KbRow({
  note,
  checked,
  onPick,
  depth = 0,
}: {
  note: KbNote;
  checked: boolean;
  onPick: (n: KbNote) => void;
  /** 子页面缩进层级（0=顶层） */
  depth?: number;
}) {
  return (
    <button
      onClick={() => onPick(note)}
      style={{ paddingLeft: 8 + depth * 14 }}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-50 active:scale-[0.99] dark:hover:bg-gray-800"
    >
      <span
        className={
          "grid h-4 w-4 shrink-0 place-items-center rounded border transition " +
          (checked
            ? "border-gray-900 bg-gray-900 dark:border-gray-200 dark:bg-gray-200"
            : "border-gray-300 dark:border-gray-600")
        }
      >
        {checked && (
          <svg
            className="h-3 w-3 text-white dark:text-gray-900"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        )}
      </span>
      {note.notionId && (
        <NotionIcon className="h-3 w-3 shrink-0 text-gray-300 dark:text-gray-600" />
      )}
      <span
        className={
          "min-w-0 flex-1 truncate text-sm " +
          (checked
            ? "font-medium text-gray-900 dark:text-gray-100"
            : "text-gray-600 dark:text-gray-300")
        }
      >
        {note.title}
      </span>
    </button>
  );
});

/**
 * 「/」小窗弹窗。
 * 内容：网络模式（Auto/Search/View，说明文字已精简）+ Live2D 开关 + 知识库条目（可折叠）。
 */
export function KbPicker({
  selected,
  onToggle,
  onInsert,
  mode,
  onModeChange,
  anchorRef,
  live2dOn,
  onToggleLive2d,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  onInsert: (notes: KbNote[]) => void;
  /** 搜索模式（与设置页「搜索模式」卡片共用同一单选，Fast/Auto/Deep 保持同步） */
  mode: "fast" | "auto" | "deep";
  onModeChange: (mode: "fast" | "auto" | "deep") => void;
  /** 「/」按钮 ref：弹窗锚定在按钮上方，避免遮盖聊天框 */
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
  /** Live2D 看板娘开关（默认开启，随对话换表情） */
  live2dOn: boolean;
  onToggleLive2d: () => void;
}) {
  const [notes] = useState<KbNote[]>(() => {
    // 优先用知识条目（含 Notion 层级/同步标记）；兼容旧 kimo_kb_notes
    try {
      const entries = JSON.parse(
        localStorage.getItem("kimo_kb_entries") || "[]",
      );
      if (Array.isArray(entries)) {
        return entries.map((e: Record<string, unknown>) => ({
          id: String(e.id || ""),
          title: String(e.name || ""),
          content: String(e.content || ""),
          createdAt: Number(e.createdAt || 0),
          notionId: typeof e.notionId === "string" ? e.notionId : undefined,
          notionParentId:
            typeof e.notionParentId === "string" ? e.notionParentId : undefined,
        }));
      }
    } catch {
      /* 忽略，回退旧 notes */
    }
    try {
      return JSON.parse(localStorage.getItem("kimo_kb_notes") || "[]");
    } catch {
      return [];
    }
  });
  const [listOpen, setListOpen] = useState(false);
  /** 展开列表内的条目搜索关键词（本地过滤 title/content） */
  const [query, setQuery] = useState("");
  /** 超出 MAX_VISIBLE 时是否展示全部条目 */
  const [showAll, setShowAll] = useState(false);
  /** 命中集合：用 Set 判定选中态，O(1) 查询，替代对 selected 数组的线性扫描 */
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  /** 搜索结果（标题+内容模糊匹配，大小写不敏感）；100+ 条也只需一次 O(n) 过滤 */
  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q),
    );
  }, [notes, query]);
  /** 层级展示行：顶层条目 + 子页面缩进嵌套（父 = notionParentId 命中条目） */
  const hierarchyRows = useMemo(() => {
    const ids = new Set(notes.map((n) => n.id));
    const byParent = new Map<string, KbNote[]>();
    const top: KbNote[] = [];
    for (const n of notes) {
      const pid = n.notionParentId || "";
      if (pid && ids.has(pid)) {
        const arr = byParent.get(pid) || [];
        arr.push(n);
        byParent.set(pid, arr);
      } else {
        top.push(n);
      }
    }
    const out: { note: KbNote; depth: number }[] = [];
    const walk = (items: KbNote[], depth: number) => {
      for (const n of items) {
        out.push({ note: n, depth });
        const kids = byParent.get(n.id);
        if (kids && kids.length) walk(kids, depth + 1);
      }
    };
    walk(top, 0);
    return out;
  }, [notes]);
  /** 展示行：有搜索词时平铺匹配结果，否则按层级 */
  const displayRows: { note: KbNote; depth: number }[] = query.trim()
    ? filteredNotes.map((n) => ({ note: n, depth: 0 }))
    : hierarchyRows;
  /** 弹窗固定定位（相对「/」按钮） */
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // 锚定到「/」按钮：弹窗底部紧贴按钮上方 10px，左对齐（超出右缘时收窄）
  useEffect(() => {
    const el = anchorRef?.current;
    if (!el) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = el.getBoundingClientRect();
      // 缩小弹窗宽度（用户反馈偏大）
      const W = Math.min(
        340,
        Math.max(260, Math.round(window.innerWidth * 0.56)),
      );
      let left = r.left;
      if (left + W > window.innerWidth - 12)
        left = Math.max(12, window.innerWidth - W - 12);
      setPos({
        left,
        bottom: Math.max(8, window.innerHeight - r.top + 10),
        width: W,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  // 点条目 = 直接选中并插入（不再需要「插入选中」按钮）
  // useCallback 稳定引用，配合 memo 行组件避免点选时全量重渲染
  const handlePick = useCallback(
    (n: KbNote) => {
      onToggle(n.id);
      onInsert([n]);
    },
    [onToggle, onInsert],
  );

  // 搜索模式（与设置页「搜索模式」卡片同一组选项：Fast/Auto/Deep，desc 为按钮 tooltip）
  const modes: {
    value: "fast" | "auto" | "deep";
    label: string;
    desc: string;
  }[] = [
    { value: "fast", label: "Fast", desc: "本地快速：不联网、不生成文章" },
    { value: "auto", label: "Auto", desc: "适当联网搜索快速回答，不生成文章" },
    { value: "deep", label: "Deep", desc: "联网并生成完整文章（仅此模式）" },
  ];

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-[100] animate-[kslideUp_0.25s_ease-out] overflow-hidden rounded-2xl border border-gray-200 bg-white/90 shadow-2xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/90"
      style={
        pos
          ? {
              left: pos.left,
              bottom: pos.bottom,
              width: pos.width,
              maxHeight: "calc(100vh - 130px)",
            }
          : { display: "none" }
      }
    >
      <div className="max-h-[calc(100vh-180px)] overflow-y-auto px-3 pt-3 pb-5">
        {/* 搜索模式：Fast / Auto / Deep 三段互斥切换（与设置页搜索模式卡片同步） */}
        <div className="flex items-center gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {modes.map((m) => (
            <button
              key={m.value}
              onClick={() => onModeChange(m.value)}
              title={m.desc}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition " +
                (mode === m.value
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200")
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        {/* Live2D 开关（AI 化身）：图标随开关变化 + 动画 */}
        <div className="group mt-1.5 flex items-center justify-between rounded-xl px-2 py-1.5 transition hover:bg-gray-100 active:scale-[0.99] dark:hover:bg-gray-800">
          <span className="flex items-center gap-2.5 text-sm font-medium text-gray-600 dark:text-gray-300">
            <span className="relative grid h-7 w-7 place-items-center rounded-lg bg-gray-100 transition-colors duration-200 group-hover:scale-110 group-active:scale-95 dark:bg-gray-800">
              {live2dOn ? (
                /* 开启：深色加粗笑脸（去绿点，Kimo 中性黑） */
                <svg
                  key="l2d-on"
                  className="h-4 w-4 animate-[kpop_0.25s_ease-out] text-gray-900 dark:text-gray-100"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 21a9 9 0 100-18 9 9 0 000 18z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 10h.01M15 10h.01M9 14.5c.9.8 2.2 1.3 3 1.3s2.1-.5 3-1.3"
                  />
                </svg>
              ) : (
                /* 关闭：灰色笑脸 */
                <svg
                  key="l2d-off"
                  className="h-4 w-4 animate-[kfade_0.2s_ease-out] text-gray-400 dark:text-gray-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 21a9 9 0 100-18 9 9 0 000 18z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 10h.01M15 10h.01M9 14.5c.9.8 2.2 1.3 3 1.3s2.1-.5 3-1.3"
                  />
                </svg>
              )}
            </span>
            Live2D
          </span>
          <button
            role="switch"
            aria-checked={live2dOn}
            onClick={onToggleLive2d}
            title={live2dOn ? "关闭" : "开启"}
            className={
              "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 active:scale-90 " +
              (live2dOn
                ? "bg-gray-900 dark:bg-gray-200"
                : "bg-gray-200 dark:bg-gray-700")
            }
          >
            <span
              className={
                "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 " +
                (live2dOn ? "left-[18px]" : "left-0.5")
              }
            />
          </button>
        </div>
        {/* 知识库条目：点击即选中插入；标题可折叠（平滑动画） */}
        <button
          onClick={() => setListOpen(!listOpen)}
          className="mt-1.5 flex w-full items-center justify-between rounded-xl px-2 py-1.5 transition hover:bg-gray-100 active:scale-[0.99] dark:hover:bg-gray-800"
        >
          <span className="flex items-center gap-2.5 text-sm font-medium text-gray-600 dark:text-gray-300">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gray-100 text-gray-400 transition-transform duration-200 group-hover:scale-110 dark:bg-gray-800 dark:text-gray-500">
              {listOpen ? (
                /* 展开：打开的书本图标 */
                <svg
                  key="kb-open"
                  className="h-4 w-4 animate-[kpop_0.25s_ease-out]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"
                  />
                </svg>
              ) : (
                /* 收起：合上的书本图标 */
                <svg
                  key="kb-closed"
                  className="h-4 w-4 animate-[kfade_0.2s_ease-out]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13zM4 19.5A2.5 2.5 0 006.5 17H20"
                  />
                </svg>
              )}
            </span>
            知识库条目
            <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {notes.length}
            </span>
          </span>
          <svg
            className={
              "h-4 w-4 text-gray-400 transition-transform duration-200 " +
              (listOpen ? "rotate-180" : "")
            }
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {/* 平滑折叠：grid-rows 0fr↔1fr + opacity 过渡（无需测量高度，比瞬间开关更顺滑） */}
        <div
          className={
            "grid transition-all duration-300 ease-out " +
            (listOpen
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0")
          }
        >
          <div className="overflow-hidden">
            {notes.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">
                暂无条目，请在 Agent 编辑器中创建
              </p>
            ) : (
              <>
                {/* 搜索框：本地过滤标题/内容，输入即时筛（100+ 条也不卡） */}
                <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 transition focus-within:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:focus-within:border-gray-600">
                  <svg
                    className="h-3.5 w-3.5 shrink-0 text-gray-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
                  </svg>
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setShowAll(false);
                    }}
                    placeholder="搜索条目…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      aria-label="清除搜索"
                      className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
                    >
                      <svg
                        className="h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="mt-1.5 max-h-52 space-y-0.5 overflow-y-auto">
                  {displayRows.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400">
                      未找到匹配条目
                    </p>
                  ) : (
                    (showAll
                      ? displayRows
                      : displayRows.slice(0, MAX_VISIBLE)
                    ).map(({ note, depth }) => (
                      <KbRow
                        key={note.id}
                        note={note}
                        depth={depth}
                        checked={selectedSet.has(note.id)}
                        onPick={handlePick}
                      />
                    ))
                  )}
                </div>
                {displayRows.length > MAX_VISIBLE && !showAll && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] text-gray-400 transition hover:bg-gray-50 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                  >
                    展开全部条目（{displayRows.length} 条）
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
