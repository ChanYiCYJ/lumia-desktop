import { useState, useEffect } from "react";
import {
  loadNotionCfg,
  saveNotionCfg,
  clearNotionCfg,
  hasNotionCfg,
  testNotionConnection,
  fetchNotionDatabases,
  loadNotionDbId,
  saveNotionDbId,
  type NotionSearchResult,
} from "../lib/notion";
import { clearInitialSynced, syncOnRefresh } from "../lib/backupSync";
import { saveKbStoreMode } from "../lib/kbStore";
import { NotionIcon } from "./ui";

/**
 * Notion 配置表单（Notion 图标）：填 Integration Token → 测试并保存。
 * - Token 存 localStorage（kimo_notion_cfg），随请求放 x-notion-token 头经 Worker 代理转发（免 CORS）。
 * - 已连接后：可选「默认数据库」（kimo_notion_db，写入/查询目标）。
 * - 同步全自动：知识库增/删/改自动同步到 Notion，Notion 页面自动以卡片显示在知识库（无需手动导入）。
 */
const inputCls =
  "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800";
const btnGhost =
  "rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800";

export function NotionForm() {
  const [token, setToken] = useState(() => loadNotionCfg().token);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "loading" | "done">(
    "idle",
  );
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);
  const [dbList, setDbList] = useState<NotionSearchResult[]>([]);
  const [dbId, setDbId] = useState(() => loadNotionDbId());
  const [dbLoading, setDbLoading] = useState(false);

  const loadDbs = async (tk: string) => {
    if (!tk.trim()) return;
    setDbLoading(true);
    const list = await fetchNotionDatabases(tk, { limit: 20 });
    setDbList(list);
    setDbLoading(false);
  };

  // 已配置时初始拉取数据库列表
  useEffect(() => {
    const cfg = loadNotionCfg();
    if (cfg.token.trim()) loadDbs(cfg.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAndTest = async () => {
    saveNotionCfg({ token });
    // 每次保存都触发双向收敛同步（拉云端合并 + 推本机填充），并热更新界面
    if (token.trim()) {
      clearInitialSynced();
      void syncOnRefresh();
      // 配置 Notion 后知识库保存目标重置为 auto（清除可能残留的 local，知识库创建/编辑自动同步）
      saveKbStoreMode("auto");
    }
    try {
      window.dispatchEvent(new CustomEvent("kimo:notion:configured"));
    } catch {
      /* 非浏览器环境忽略 */
    }
    setTestState("loading");
    setResult(null);
    const r = await testNotionConnection(token);
    setResult(r);
    setTestState("done");
    if (r.ok) loadDbs(token.trim());
  };

  const clearAll = () => {
    clearNotionCfg();
    saveNotionDbId("");
    setToken("");
    setResult(null);
    setDbList([]);
    setDbId("");
    try {
      window.dispatchEvent(new CustomEvent("kimo:notion:cleared"));
    } catch {
      /* 非浏览器环境忽略 */
    }
  };

  return (
    <div className="space-y-2.5">
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-400">
        <NotionIcon className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
        <span>
          通过 Notion MCP 接入你的工作区：AI 可实时检索页面/数据库、创建/更新
          Notion 页面。知识库与 Notion 全自动双向同步（Notion
          为云端主存储）；Token 仅保存在当前浏览器，经本站代理转发（免 CORS）。
        </span>
      </p>
      <div className="relative">
        <input
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setResult(null);
          }}
          type={showKey ? "text" : "password"}
          placeholder="secret_..."
          className={inputCls}
        />
        <button
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          aria-label={showKey ? "隐藏密钥" : "显示密钥"}
          title={showKey ? "隐藏密钥" : "显示密钥"}
        >
          {showKey ? (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          )}
        </button>
      </div>

      {/* 已连接时：默认数据库（已配置 token 即显示，刷新后可直接选择；导入已全自动） */}
      {hasNotionCfg() && (
        <div className="space-y-2 rounded-xl border border-gray-100 bg-gray-50/60 p-2.5 dark:border-gray-800 dark:bg-gray-800/50">
          <div className="flex items-center gap-2">
            <label className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
              默认数据库
            </label>
            <select
              value={dbId}
              onChange={(e) => {
                const v = e.target.value;
                setDbId(v);
                saveNotionDbId(v);
              }}
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">未选择（自动使用主数据库）</option>
              {dbList.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || "(未命名数据库)"}
                </option>
              ))}
            </select>
          </div>
          {dbLoading && (
            <p className="text-[11px] text-gray-400">加载数据库列表…</p>
          )}
          <p className="text-[11px] leading-relaxed text-gray-400">
            同步全自动：本机未同步条目会自动同步到所选数据库，Notion
            页面也会自动显示在知识库。
          </p>
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={saveAndTest}
          disabled={testState === "loading" || !token.trim()}
          className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
            testState === "loading"
              ? "cursor-wait border border-gray-200 text-gray-400"
              : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          }`}
        >
          {testState === "loading" ? "测试中…" : "测试并保存"}
        </button>
        <button onClick={clearAll} className={btnGhost}>
          清除
        </button>
      </div>
      {result && (
        <p
          className={`text-xs ${result.ok ? "text-green-600 dark:text-green-500" : "text-red-500 dark:text-red-400"}`}
        >
          {result.ok ? "✓ " : "✗ "}
          {result.message}
          {result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ""}
        </p>
      )}
    </div>
  );
}
