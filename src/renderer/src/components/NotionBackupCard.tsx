import { useEffect, useMemo, useState } from "react";
import {
  BACKUP_CATEGORIES,
  forceBackupAll,
  getBackupStatus,
  loadBackupState,
  loadNotionBackupRoot,
  resolveBackupRoots,
  saveNotionBackupRoot,
  serializeBackup,
  subscribeBackupSync,
  type BackupSyncStatus,
} from "../lib/backupSync";
import { hasNotionCfg, loadNotionCfg, notionPageUrl } from "../lib/notion";
import { useToast } from "../lib/toast";
import { formatDate } from "../lib/format";
import { NotionIcon } from "./ui";

/**
 * 设置页「Notion MCP」卡内的同步区：简洁为「同步状态 + 同步位置」。
 * 多端数据自动合并（默认），无需手动处理；配置 Notion 后界面即时热更新。
 */
export function NotionBackupCard() {
  const { toast } = useToast();
  const [syncStatus, setSyncStatus] = useState<BackupSyncStatus>(() =>
    getBackupStatus(),
  );
  const [manualSyncing, setManualSyncing] = useState(false);
  const [stateTick, setStateTick] = useState(0);
  const [configTick, setConfigTick] = useState(0);
  const [roots, setRoots] = useState<{ id: string; title: string }[]>([]);
  const [rootId, setRootId] = useState(() => loadNotionBackupRoot());

  // 订阅同步状态；每次同步结束后重读同步状态（更新时间）
  useEffect(() => {
    return subscribeBackupSync((s) => {
      setSyncStatus(s);
      if (s.state === "idle") setStateTick((t) => t + 1);
    });
  }, []);
  // 配置 Notion 后界面热更新（连接/清除即时生效，无需刷新）
  useEffect(() => {
    const onCfg = () => setConfigTick((t) => t + 1);
    window.addEventListener("kimo:notion:configured", onCfg);
    window.addEventListener("kimo:notion:cleared", onCfg);
    return () => {
      window.removeEventListener("kimo:notion:configured", onCfg);
      window.removeEventListener("kimo:notion:cleared", onCfg);
    };
  }, []);
  const backupState = useMemo(
    () => loadBackupState(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stateTick, configTick],
  );

  // 各分类本机数据量 + 上次同步时间（同步结束/配置变化后重算）
  const catStats = useMemo(
    () =>
      BACKUP_CATEGORIES.map((def) => {
        const p = serializeBackup(def.id);
        return {
          def,
          keyCount: Object.keys(p.data).length,
          bytes: p.bytes,
          updatedAt: backupState[def.id]?.updatedAt || 0,
          oversize: !!(def.maxBytes && p.bytes > def.maxBytes),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stateTick, configTick],
  );

  // 列出候选同步位置（Content access 根）；配置变化时刷新
  useEffect(() => {
    if (!hasNotionCfg()) {
      setRoots([]);
      return;
    }
    let alive = true;
    resolveBackupRoots(loadNotionCfg().token).then((rs) => {
      if (alive) setRoots(rs);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configTick]);
  // 只有一个同步位置时，默认必须为它（显示为选中）
  useEffect(() => {
    if (roots.length === 1 && !rootId) setRootId(roots[0].id);
  }, [roots, rootId]);

  const lastSyncAt = Math.max(
    0,
    ...BACKUP_CATEGORIES.map((d) => backupState[d.id]?.updatedAt || 0),
  );
  const rootTitle = roots.find((r) => r.id === rootId)?.title || "AI Setting";

  if (!hasNotionCfg()) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
          在上方连接 Notion 后，AI 记忆、人格笔记、设置与对话历史将自动同步到
          Notion（密钥不上传），多端数据自动合并，换设备/清浏览器后可随时恢复。
        </p>
      </div>
    );
  }

  const selectRoot = (id: string) => {
    setRootId(id);
    saveNotionBackupRoot(id); // 切换位置：清掉旧分类页，重同步到新根
    void forceBackupAll().then((rs) => {
      const ok = rs.filter((r) => r.ok).length;
      const oversize = rs.filter((r) => r.oversize).length;
      if (oversize) toast(`已同步 ${ok} 类；部分分类数据过大未同步`);
      else if (ok) toast(`已切换到新位置并同步 ${ok} 类数据`);
      else toast("同步失败，请重试");
    });
  };

  // 手动「立即同步」：逐类入队并 flush，展示结果
  const doSyncNow = async () => {
    setManualSyncing(true);
    try {
      const rs = await forceBackupAll();
      const ok = rs.filter((r) => r.ok).length;
      const over = rs.filter((r) => r.oversize).length;
      if (over) toast(`已同步 ${ok} 类；${over} 类数据过大未同步`);
      else if (ok) toast(`已同步 ${ok} 类数据`);
      else toast("同步失败，请重试");
    } finally {
      setManualSyncing(false);
    }
  };

  return (
    <div className="space-y-2">
      {/* 状态行：上次同步 + 同步中/失败 + 立即同步 */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400 dark:text-gray-500">
        <span>
          {lastSyncAt
            ? `上次同步 ${formatDate(new Date(lastSyncAt))}`
            : "尚未同步（数据变更后自动同步）"}
        </span>
        <span className="flex items-center gap-1.5">
          {syncStatus.state === "syncing" ? (
            <span className="flex items-center gap-1 text-amber-500">
              <svg
                className="h-3 w-3 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              同步中
            </span>
          ) : syncStatus.error ? (
            <span className="text-red-500">同步失败：{syncStatus.error}</span>
          ) : null}
          <button
            type="button"
            onClick={doSyncNow}
            disabled={manualSyncing || syncStatus.state === "syncing"}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-gray-100"
          >
            {manualSyncing || syncStatus.state === "syncing"
              ? "同步中…"
              : "立即同步"}
          </button>
        </span>
      </div>

      {/* 同步位置 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-600 dark:text-gray-300">
          同步位置
        </span>
        <select
          value={rootId}
          onChange={(e) => selectRoot(e.target.value)}
          className="max-w-[55%] rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
        >
          <option value="">自动（默认）</option>
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </div>
      {rootId && (
        <a
          href={notionPageUrl(rootId)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-gray-500 transition hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <NotionIcon className="h-3 w-3" />在 Notion 中打开同步页「{rootTitle}
          」
        </a>
      )}

      {/* 各分类同步状态 */}
      <div className="space-y-1 border-t border-gray-100 pt-2 dark:border-gray-800">
        {catStats.map(({ def, keyCount, bytes, updatedAt, oversize }) => {
          const syncingThis =
            syncStatus.state === "syncing" && syncStatus.cat === def.id;
          return (
            <div
              key={def.id}
              className="flex items-center justify-between gap-2 text-[11px]"
            >
              <span className="text-gray-500 dark:text-gray-400">
                {def.label}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-gray-400 dark:text-gray-500">
                  {keyCount === 0
                    ? "无数据"
                    : bytes >= 1024 * 1024
                      ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
                      : `${Math.max(1, Math.round(bytes / 1024))}KB`}
                </span>
                {syncingThis ? (
                  <span className="flex items-center gap-1 text-amber-500">
                    <svg
                      className="h-2.5 w-2.5 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    同步中
                  </span>
                ) : oversize ? (
                  <span className="text-amber-500">数据过大</span>
                ) : updatedAt ? (
                  <span className="text-green-500">
                    已同步 {formatDate(new Date(updatedAt))}
                  </span>
                ) : keyCount > 0 ? (
                  <span className="text-gray-400">待同步</span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
