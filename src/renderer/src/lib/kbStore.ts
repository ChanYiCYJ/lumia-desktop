/**
 * 知识库保存目标（Knowledge Store）：auto / local / notion
 * ------------------------------------------------------------------
 * - auto：已配置 Notion → 保存到 Notion（云端主存储）；否则本机 localStorage
 * - local：强制本机
 * - notion：强制 Notion（未配置时回退本机 + 提示）
 * - 双写策略：所有写入 = 本机 always（离线镜像/缓存）+ 按 mode 写 Notion。
 *   写 Notion 失败降级为仅本机（不阻塞用户操作，返回 error 提示）。
 * - 版本快照：删除/保存前自动拍（环形 5 份），支持「撤销/恢复」。
 * - 纯函数 + 可注入 fetch（notion 写入经注入可单测）。
 */
import {
  loadKbEntries,
  saveKbEntry,
  saveKbNotes,
  uid,
  reparentKbEntry,
  isKbDescendant,
  type KbEntryRecord,
} from "./kb";
import {
  hasNotionCfg,
  loadNotionCfg,
  resolveDbTitlePropertyCached,
  buildDbPageProperties,
  buildPageTitleProps,
  updateNotionPageProps,
  replaceNotionPageContent,
  findNotionPageByTitle,
  notionFetchPage,
  deleteNotionPage,
  fetchNotionPageText,
  resolveMainDatabaseId,
  listNotionPagesAll,
  resolveNotionRoots,
  createNotionSubPage,
  type NotionSearchResult,
} from "./notion";
import { resolveBackupRoots } from "./backupSync";

export type KnowledgeStoreMode = "auto" | "local" | "notion";

const MODE_KEY = "kimo_kb_store_mode";
const SNAP_KEY = "kimo_kb_snapshots";
const SNAP_MAX = 5;
// 无数据库时知识条目的容器页：直接挂在「页面根目录」（Content access 根）下，不进 AI Setting
const KB_CONTAINER_KEY = "kimo_kb_container";
const KB_CONTAINER_TITLE = "知识库";

// ---- 保存目标 mode ----
export function loadKbStoreMode(): KnowledgeStoreMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "local" || v === "notion" || v === "auto") return v;
  } catch {
    /* 忽略 */
  }
  return "auto";
}

export function saveKbStoreMode(m: KnowledgeStoreMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* 忽略 */
  }
}

/** 解析最终保存目标：auto → 已配置 Notion 则 notion 否则 local */
export function resolveKbStore(mode?: KnowledgeStoreMode): "local" | "notion" {
  const m = mode || loadKbStoreMode();
  if (m === "notion") return hasNotionCfg() ? "notion" : "local";
  if (m === "local") return "local";
  return hasNotionCfg() ? "notion" : "local";
}

/**
 * 本地知识库是否已全部并入 Notion（回填完成）。
 * 非空且每个条目都有 notionId = 已同步；用于配置 MCP 后隐藏「本机」tab 与纯本地条目。
 * 纯函数：由当前 entries 派生（删除/新增后自动重算）。
 */
export function isKbNotionImported(entries: KbEntryRecord[]): boolean {
  return entries.length > 0 && entries.every((e) => !!e.notionId);
}

// ---- entries 写回（同步 notes，与 kb.ts saveKbEntry 同构） ----
function writeEntries(entries: KbEntryRecord[]): void {
  try {
    localStorage.setItem("kimo_kb_entries", JSON.stringify(entries));
  } catch {
    /* 忽略 */
  }
  saveKbNotes(
    entries.map((e) => ({
      id: e.id,
      title: e.name,
      content: e.content,
      createdAt: e.createdAt,
    })),
  );
}

/** 通知 UI（AgentPanel 等）条目已变更（后台回填 notionId 后刷新网格） */
function notifyKbChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent("kimo:kb:entries-changed"));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** 回填 notionId + 同步时间（后台同步成功后调用）；meta 可附带根/父层级回填 */
function writeNotionMeta(
  id: string,
  notionId: string,
  meta?: Partial<KbEntryRecord>,
): KbEntryRecord | null {
  const entries = loadKbEntries();
  let target: KbEntryRecord | null = null;
  const nx = entries.map((e) => {
    if (e.id !== id) return e;
    target = { ...e, notionId, notionSyncedAt: Date.now(), ...(meta || {}) };
    return target;
  });
  writeEntries(nx);
  notifyKbChanged();
  return target;
}

/**
 * 解析写入目标数据库 id：优先默认库；未配置时自动用主数据库（第一个可访问数据库）。
 * 返回空串 = 未配置 Notion 或工作区无可用数据库。
 */
export async function resolveKbDbId(
  token: string,
  databaseId?: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (databaseId) return databaseId;
  return resolveMainDatabaseId(token, fetchImpl);
}

// ================= 无数据库兜底：知识库容器页（子页面存储） =================
function loadKbContainerId(): string {
  try {
    return localStorage.getItem(KB_CONTAINER_KEY) || "";
  } catch {
    return "";
  }
}
function saveKbContainerId(id: string): void {
  try {
    if (id) localStorage.setItem(KB_CONTAINER_KEY, id);
    else localStorage.removeItem(KB_CONTAINER_KEY);
  } catch {
    /* 忽略 */
  }
}
/** 清除容器页缓存（切换同步位置/测试用） */
export function resetKbContainerCache(): void {
  saveKbContainerId("");
}

/**
 * 确保「知识库」容器页存在（无数据库时知识条目存为它的子页面）：
 * 直接挂在「页面根目录」（第一个 Content access 根）下，不放进「AI Setting」备份根。
 * 按标题查重 + 校验父=该根，避免复用错位同名页。
 */
export async function ensureKbContainerPage(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (!token.trim()) return "";
  const cached = loadKbContainerId();
  if (cached) return cached;
  // 页面根目录 = Content access 根（第一个），而非备份根 AI Setting
  const roots = await resolveBackupRoots(token, fetchImpl);
  if (!roots.length) return "";
  const rootId = roots[0].id;
  const found = await findNotionPageByTitle(
    token,
    KB_CONTAINER_TITLE,
    fetchImpl,
  );
  if (found?.id) {
    try {
      const meta = await notionFetchPage(found.id, token, fetchImpl);
      if (meta.parentId === rootId) {
        saveKbContainerId(found.id);
        return found.id;
      }
    } catch {
      /* 校验失败 → 走新建 */
    }
  }
  const created = await createNotionSubPage(token, rootId, {
    title: KB_CONTAINER_TITLE,
    content: "知识库容器（自动生成，请勿删除）",
    fetchImpl,
  });
  if (created?.id) saveKbContainerId(created.id);
  return created?.id || "";
}

// ================= 同步队列（防抖合并 + 串行化 + latest-wins，追求速度） =================
const SYNC_DEBOUNCE_MS = 1500;

export interface KbSyncStatus {
  state: "idle" | "syncing";
  /** 最近一次同步失败原因（成功后清空） */
  error?: string;
}

interface QueueItem {
  entry: KbEntryRecord;
  databaseId?: string;
  fetchImpl?: typeof fetch;
  timer?: ReturnType<typeof setTimeout>;
}

const syncQueue = new Map<string, QueueItem>();
let syncStatus: KbSyncStatus = { state: "idle" };
const syncListeners = new Set<(s: KbSyncStatus) => void>();
let syncChain: Promise<unknown> = Promise.resolve();
let inflightId = "";

function emitSyncStatus(s: KbSyncStatus): void {
  syncStatus = s;
  syncListeners.forEach((l) => l(s));
}

const SYNC_ERROR_CLEAR_MS = 8000;
let syncErrorClearTimer: ReturnType<typeof setTimeout> | undefined;
function clearSyncErrorTimer() {
  if (syncErrorClearTimer) {
    clearTimeout(syncErrorClearTimer);
    syncErrorClearTimer = undefined;
  }
}
/** 同步失败后自动清除错误提示（避免「同步失败」永久滞留） */
function scheduleSyncErrorClear() {
  clearSyncErrorTimer();
  syncErrorClearTimer = setTimeout(() => {
    syncErrorClearTimer = undefined;
    emitSyncStatus({ state: syncStatus.state, error: undefined });
  }, SYNC_ERROR_CLEAR_MS);
}

/** 订阅同步状态（idle/syncing + 最近错误），返回取消订阅函数 */
export function subscribeKbSync(
  listener: (s: KbSyncStatus) => void,
): () => void {
  syncListeners.add(listener);
  listener(syncStatus);
  return () => syncListeners.delete(listener);
}

export function getKbSyncStatus(): KbSyncStatus {
  return syncStatus;
}

/** 是否已在队列等待或正在同步（拉取/删除时保护 dirty 条目不被覆盖） */
export function isKbEntryDirty(id: string): boolean {
  return syncQueue.has(id) || inflightId === id;
}

/** 清空同步队列与状态（测试用） */
export function resetKbSyncQueue(): void {
  for (const [, item] of syncQueue) {
    if (item.timer) clearTimeout(item.timer);
  }
  syncQueue.clear();
  inflightId = "";
  syncStatus = { state: "idle" };
  clearSyncErrorTimer();
  syncChain = Promise.resolve();
}

/** 把已保存条目入队后台同步（本机已写入；内容变化以最新为准并重置防抖） */
export function queueKbSync(
  entry: KbEntryRecord,
  opts: { databaseId?: string; fetchImpl?: typeof fetch } = {},
): void {
  if (resolveKbStore() !== "notion") return; // 非 Notion 目标不入队
  const prev = syncQueue.get(entry.id);
  if (prev?.timer) clearTimeout(prev.timer);
  syncQueue.set(entry.id, {
    entry,
    databaseId: opts.databaseId,
    fetchImpl: opts.fetchImpl,
    timer: setTimeout(() => flushKbSync(entry.id), SYNC_DEBOUNCE_MS),
  });
}

/** 立即执行待同步条目（单个 id 或全部；删除/离开前调用），返回该任务完成的 Promise */
export function flushKbSync(id?: string): Promise<void> {
  if (id) {
    const item = syncQueue.get(id);
    if (!item) return Promise.resolve();
    if (item.timer) clearTimeout(item.timer);
    syncQueue.delete(id);
    const p = syncChain.then(() => runSyncJob(item));
    syncChain = p.catch(() => undefined);
    return p;
  }
  return Promise.all([...syncQueue.keys()].map((k) => flushKbSync(k))).then(
    () => undefined,
  );
}

/** 等待同步队列全部任务完成（测试/离开前使用） */
export async function waitForKbSyncIdle(): Promise<void> {
  await syncChain;
}

async function runSyncJob(item: QueueItem): Promise<void> {
  inflightId = item.entry.id;
  emitSyncStatus({ state: "syncing" });
  try {
    // 关键：同步前用 localStorage 里最新的条目（含首次同步回填的 notionId），
    // 避免使用入队时的陈旧快照（仍无 notionId）把同一页面重复创建到 Notion。
    const fresh = loadKbEntries().find((e) => e.id === item.entry.id);
    if (!fresh) {
      // 条目已被删除：跳过（避免用旧快照把已删页面重建回 Notion）
      emitSyncStatus({
        state: syncQueue.size > 0 ? "syncing" : "idle",
        error: undefined,
      });
      return;
    }
    const r = await syncEntryNotion({
      entry: fresh,
      databaseId: item.databaseId,
      fetchImpl: item.fetchImpl,
    });
    emitSyncStatus({
      state: syncQueue.size > 0 ? "syncing" : "idle",
      error: r.error,
    });
    if (r.error) scheduleSyncErrorClear();
    else clearSyncErrorTimer();
  } catch {
    emitSyncStatus({
      state: syncQueue.size > 0 ? "syncing" : "idle",
      error: "Notion 同步失败",
    });
    scheduleSyncErrorClear();
  } finally {
    inflightId = "";
  }
}

/**
 * 自动回填：把本地未同步（无 notionId）条目分批后台推到 Notion（替代被删的手动导入按钮）。
 * 每批上限 BACKFILL_BATCH，其余留到下次（避免一次性大量请求触发限流）。
 */
const BACKFILL_BATCH = 10;
export function autoBackfillLocalToNotion(): void {
  if (resolveKbStore() !== "notion") return;
  const entries = loadKbEntries().filter((e) => !e.notionId);
  if (!entries.length) return;
  entries.slice(0, BACKFILL_BATCH).forEach((e) => queueKbSync(e));
}

// ---- 智能保存 ----
export interface KbSaveSmartResult {
  entry: KbEntryRecord;
  store: "local" | "notion";
  notionId?: string;
  /** 非空 = Notion 同步失败（内容已存本机） */
  error?: string;
}

/**
 * 智能保存知识条目：本机 always + 按 mode 入队后台同步 Notion（不阻塞 UI，追求速度）。
 * 立即返回；Notion 写入由同步队列异步完成（防抖合并），成功后回填 notionId/notionSyncedAt。
 */
export async function saveKbEntrySmart(opts: {
  title: string;
  content: string;
  mode?: KnowledgeStoreMode;
  token?: string;
  notionId?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
}): Promise<KbSaveSmartResult> {
  const { title, content, mode } = opts;
  snapshotKb(); // 写操作前留档（支持撤销）
  const base = saveKbEntry(title, content); // 本机 always（按标题去重）
  const store = resolveKbStore(mode);
  if (store === "notion") {
    queueKbSync(
      { ...base, notionId: opts.notionId || base.notionId },
      { databaseId: opts.databaseId, fetchImpl: opts.fetchImpl },
    );
  }
  return { entry: base, store, notionId: base.notionId };
}

// ---- 智能删除（双向：本机 + Notion） ----
export interface KbDeleteSmartResult {
  removedLocal: boolean;
  removedNotion: boolean;
}

/**
 * 仅把「已存在」的本地条目同步到 Notion（写入 + 回填 notionId），不重复创建本地。
 * - 有 notionId → 镜像覆盖（replaceNotionPageContent 删旧块+写新块）+ 更新标题
 * - 无 notionId 且有 notionParentId → 在父页面下创建子页面（parent=page_id）
 * - 无 notionId 且无父 → 在默认数据库创建页面，成功后回填 notionId/notionSyncedAt
 * - schema 走 TTL 缓存（写入提速）
 */
export async function syncEntryNotion(opts: {
  entry: KbEntryRecord;
  token?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ notionId?: string; error?: string }> {
  const { entry } = opts;
  const store = resolveKbStore();
  if (store !== "notion") return {};
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  if (!token.trim()) return { error: "未配置 Notion 或可用的数据库" };
  try {
    if (entry.notionId) {
      // 已有同步页面：镜像覆盖内容 + 更新标题（知识库为编辑入口，Notion 为镜像）。
      // 新条目均为独立页面（父=页面/知识库根），标题属性键固定为 "title"；
      // 旧版本存于数据库的条目，标题属性为数据库列名 → 失败时回退数据库 schema 更新。
      const titleUpdated = await updateNotionPageProps(
        token,
        entry.notionId,
        buildPageTitleProps(entry.name),
        opts.fetchImpl,
      );
      if (!titleUpdated) {
        try {
          const databaseId = await resolveKbDbId(
            token,
            opts.databaseId,
            opts.fetchImpl,
          );
          const titleProp = await resolveDbTitlePropertyCached(
            token,
            databaseId,
            opts.fetchImpl,
          );
          await updateNotionPageProps(
            token,
            entry.notionId,
            buildDbPageProperties(titleProp, entry.name),
            opts.fetchImpl,
          );
        } catch {
          /* 标题回退失败忽略（内容仍会同步） */
        }
      }
      await replaceNotionPageContent(
        token,
        entry.notionId,
        entry.content,
        opts.fetchImpl,
      );
      writeNotionMeta(entry.id, entry.notionId);
      return { notionId: entry.notionId };
    }
    // 子页面：在父页面（page_id）下创建，无需数据库
    if (entry.notionParentId) {
      const created = await createNotionSubPage(token, entry.notionParentId, {
        title: entry.name,
        content: entry.content,
        fetchImpl: opts.fetchImpl,
      });
      if (created?.id) {
        writeNotionMeta(entry.id, created.id);
        return { notionId: created.id };
      }
      return { error: "Notion 创建子页面失败" };
    }
    // 本地父（parentId）：父条目已同步 Notion → 作为其子页创建（保持本地层级）
    if (entry.parentId) {
      const localParent = loadKbEntries().find((x) => x.id === entry.parentId);
      if (localParent?.notionId) {
        const created = await createNotionSubPage(token, localParent.notionId, {
          title: entry.name,
          content: entry.content,
          fetchImpl: opts.fetchImpl,
        });
        if (created?.id) {
          writeNotionMeta(entry.id, created.id, {
            notionParentId: localParent.notionId,
            notionParentName: localParent.name,
            notionRootId: localParent.notionRootId || localParent.notionId,
            notionRootName: localParent.notionRootName || localParent.name,
          });
          return { notionId: created.id };
        }
        return { error: "Notion 创建子页面失败" };
      }
      // 父条目未同步：回退顶层（迁移时父层级扁平化）
    }
    // 顶层页面：统一存为「知识库」根页面的子页面（页面树，位于页面根目录/Content access 根下）。
    // 不再默认写入数据库——知识库以独立页面树形态存在于 Notion。
    const kbRootId = await ensureKbContainerPage(token, opts.fetchImpl);
    if (!kbRootId) return { error: "未配置 Notion 或可用的数据库" };
    const created = await createNotionSubPage(token, kbRootId, {
      title: entry.name,
      content: entry.content,
      fetchImpl: opts.fetchImpl,
    });
    if (created?.id) {
      writeNotionMeta(entry.id, created.id, {
        notionRootId: kbRootId,
        notionRootName: KB_CONTAINER_TITLE,
      });
      return { notionId: created.id };
    }
    return { error: "Notion 创建知识页失败" };
  } catch {
    return { error: "Notion 同步失败（已保存到本机）" };
  }
}

/** 删除知识条目：本机删除 + 有 notionId 且目标为 notion 时同步删除 Notion 页面 */
export async function deleteKbEntrySmart(opts: {
  id: string;
  mode?: KnowledgeStoreMode;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<KbDeleteSmartResult> {
  const { id } = opts;
  await flushKbSync(id); // 先落掉该条待同步内容，避免删除后又被队列重建
  snapshotKb(); // 删除前留档（支持撤销）
  const entries = loadKbEntries();
  const target = entries.find((e) => e.id === id);
  const store = resolveKbStore(opts.mode);
  let removedNotion = false;
  if (target?.notionId && store === "notion") {
    const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
    removedNotion = await deleteNotionPage(
      token,
      target.notionId,
      opts.fetchImpl,
    );
  }
  writeEntries(entries.filter((e) => e.id !== id));
  notifyKbChanged();
  return { removedLocal: true, removedNotion };
}

// ---- 本地数据导入 Notion（双写：本地保留为镜像） ----
export interface KbSyncResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * 把本地知识条目同步到 Notion（保留旧函数名，行为与「一键迁移到知识库根页面」一致）。
 * 统一改为在「知识库」根页面下创建子页面，不再写入数据库。
 */
export async function syncLocalKbToNotion(
  opts: { token?: string; databaseId?: string; fetchImpl?: typeof fetch } = {},
): Promise<KbSyncResult> {
  return migrateLocalKbToRoot({
    token: opts.token,
    fetchImpl: opts.fetchImpl,
  });
}

// ---- 一键迁移到「知识库」根页面（显式入口，替代静默回填的体验） ----
export interface KbMigrateResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * 把本机未同步（无 notionId）的知识条目逐条迁移到「知识库」根页面（页面根目录下）。
 * 与 syncEntryNotion 顶层策略一致：全部创建为该根页面的子页面并回填 notionId/根信息。
 * 返回结果供 UI 展示进度与失败原因。
 */
export async function migrateLocalKbToRoot(
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<KbMigrateResult> {
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  const out: KbMigrateResult = { total: 0, created: 0, skipped: 0, errors: [] };
  if (resolveKbStore() !== "notion" || !token.trim()) {
    out.errors.push("未配置 Notion");
    return out;
  }
  const rootId = await ensureKbContainerPage(token, opts.fetchImpl);
  if (!rootId) {
    out.errors.push("无法定位「知识库」根页面");
    return out;
  }
  const entries = loadKbEntries().filter((e) => !e.notionId);
  out.total = entries.length;
  for (const e of entries) {
    try {
      const created = await createNotionSubPage(token, rootId, {
        title: e.name,
        content: e.content,
        fetchImpl: opts.fetchImpl,
      });
      if (created?.id) {
        writeNotionMeta(e.id, created.id, {
          notionRootId: rootId,
          notionRootName: KB_CONTAINER_TITLE,
        });
        out.created++;
      } else {
        out.skipped++;
        out.errors.push(`「${e.name || "(无标题)"}」创建失败`);
      }
    } catch {
      out.skipped++;
      out.errors.push(`「${e.name || "(无标题)"}」迁移失败`);
    }
  }
  return out;
}

// ---- 页面树：移动（改父）—— 本地重排 + Notion「重建+删旧」 ----
export interface KbMoveResult {
  entry?: KbEntryRecord;
  /** 是否发生了 Notion 重建（页面 id 变化） */
  recreated?: boolean;
  error?: string;
}

/**
 * 移动知识条目（Notion 式页面树拖拽）:
 * - 本地改父 + 兄弟重编号（order）始终生效（纯本地持久化）。
 * - 已同步条目改父时：Notion API 无法修改页面 parent → 在新父下「重建」同标题内容页、
 *   删除旧页、回填新 notionId/parent/root（页面 id 变化，外部引用失效）。
 * - 未同步条目（本机）仅本地改父。
 */
export async function moveKbEntry(opts: {
  id: string;
  /** 目标父条目的本地 id；缺省/空 = 移到顶层（「知识库」根页面下） */
  newParentId?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<KbMoveResult> {
  const { id, newParentId } = opts;
  const entries = loadKbEntries();
  const target = entries.find((e) => e.id === id);
  if (!target) return { error: "条目不存在" };
  const newParent = newParentId
    ? entries.find((e) => e.id === newParentId)
    : undefined;
  if (newParentId && !newParent) return { error: "目标父页面不存在" };
  if (newParentId && isKbDescendant(entries, id, newParentId)) {
    return { error: "不能移动到自身或其子页面下" };
  }
  // 已同步页面改父：目标父须已同步（Notion 重建需要父页）；未同步页面可挂任意父（本地层级）
  if (target.notionId && newParentId && !newParent!.notionId) {
    return { error: "目标父页面尚未同步到 Notion" };
  }
  const newParentNotionId = newParent?.notionId || "";
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  // 已同步页面：改父需在 Notion「重建 + 删旧」（API 不能改 parent）
  let recreated = false;
  let newNotionId = target.notionId || "";
  let recreateParentId = "";
  if (target.notionId && resolveKbStore() === "notion") {
    if (!token.trim()) {
      return { error: "未配置 Notion，无法移动已同步页面" };
    }
    recreateParentId =
      newParentNotionId || (await ensureKbContainerPage(token, opts.fetchImpl));
    if (!recreateParentId) {
      return { error: "无法定位目标父页面（知识库根页面）" };
    }
    const created = await createNotionSubPage(token, recreateParentId, {
      title: target.name,
      content: target.content,
      fetchImpl: opts.fetchImpl,
    });
    if (!created?.id) {
      return { error: "Notion 移动失败（已取消，未改变）" };
    }
    await deleteNotionPage(token, target.notionId, opts.fetchImpl);
    newNotionId = created.id;
    recreated = true;
  }
  // 本地改父（含根信息继承与 order 重排）
  const rootId =
    (newParent
      ? newParent.notionRootId || newParentNotionId
      : recreateParentId || target.notionRootId) || "";
  const rootName =
    (newParent
      ? newParent.notionRootName || newParent.name
      : target.notionRootName) || "";
  let nx = reparentKbEntry(entries, id, newParentId || "");
  if (newNotionId) {
    nx = nx.map((e) =>
      e.id === id
        ? {
            ...e,
            notionId: newNotionId,
            notionRootId: rootId,
            notionRootName: rootName,
          }
        : e,
    );
  }
  writeEntries(nx);
  notifyKbChanged();
  return { entry: nx.find((e) => e.id === id), recreated };
}

// ---- Notion 页面 → 标准知识库卡片（双向同步，Notion 为权威） ----
export interface KbPullResult {
  total: number;
  imported: number;
  errors: string[];
}

/**
 * 把 Notion 可访问页面自动拉取转译为标准知识库卡片（name=标题/content=正文/notionId=页面id）。
 * - 分页拉全量列表（cap limit）→ 仅对「新增页」或「Notion 更新较新」的页拉正文（有界并发，提速）
 * - dirty（队列中未同步）条目跳过覆盖，避免把用户正在编辑的内容冲掉
 * - 列表完整时做删除对账：Notion 已无该页且非 dirty → 自动删除本地卡片（双向自动删除）
 */
const PULL_CONCURRENCY = 4;

/**
 * 收集「知识库」容器页下的全部后代页面 id（含容器自身）。
 * 用于把容器子树条目的根分组固定为该容器页，而非上层共享根。
 */
function collectContainerDescendants(
  pages: NotionSearchResult[],
  parentOf: Map<string, string | null>,
  containerId: string,
): Set<string> {
  const out = new Set<string>();
  if (!containerId) return out;
  const childrenOf = new Map<string, string[]>();
  for (const p of pages) {
    if (!p?.id) continue;
    const pid = parentOf.get(p.id) || "";
    if (pid) {
      const arr = childrenOf.get(pid) || [];
      arr.push(p.id);
      childrenOf.set(pid, arr);
    }
  }
  const stack = [containerId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childrenOf.get(id) || []) stack.push(c);
  }
  return out;
}

export async function pullNotionPagesToKb(
  opts: {
    token?: string;
    limit?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<KbPullResult> {
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  const out: KbPullResult = { total: 0, imported: 0, errors: [] };
  if (!token.trim()) {
    out.errors.push("未配置 Notion");
    return out;
  }
  const { pages: allPages, complete } = await listNotionPagesAll(token, {
    limit: opts.limit || 100,
    fetchImpl: opts.fetchImpl,
  });
  // 排除备份页（AI Setting 备份根页/「备份 · X」子页），不混入知识库条目。
  // 「知识库」容器页保留在层级计算中：它作为其子树条目的根分组，但自身不作为条目。
  const candidates = allPages.filter((p) => {
    const t = p.title || "";
    return t !== "AI Setting" && !t.startsWith("备份 · ");
  });
  // 知识库根页面（「知识库」容器页）：连接 Notion 后，知识库 = 该根页面下的页面树。
  // 仅把「知识库」子树内的页面作为知识条目，子树外（工作区其他页面）不混入知识库列表。
  const kbRootId =
    candidates.find((p) => p.title === KB_CONTAINER_TITLE)?.id || "";
  // Content access 层级：计算「根 → 父」映射 + 标题表（供条目回填 root/parent）
  const { rootOf, parentOf } = resolveNotionRoots(candidates);
  // 「知识库」容器页下的所有后代（含容器自身）
  const containerRoots = collectContainerDescendants(
    candidates,
    parentOf,
    kbRootId,
  );
  // 没有容器页（尚未建知识库根）→ 全量拉取（兼容旧数据）；有容器页 → 只拉其子树
  const pages = kbRootId
    ? candidates.filter((p) => p.id !== kbRootId && containerRoots.has(p.id))
    : candidates;
  out.total = pages.length;
  if (!pages.length) return out;
  const titleById = new Map<string, string>();
  for (const p of candidates) titleById.set(p.id, p.title || "(无标题)");
  const entries = loadKbEntries();
  const now = Date.now();
  const seen = new Set<string>();
  let i = 0;
  const workers = Array.from(
    { length: Math.min(PULL_CONCURRENCY, pages.length) },
    async () => {
      while (i < pages.length) {
        const p = pages[i++];
        if (!p?.id) continue;
        seen.add(p.id);
        const local = entries.find((e) => e.notionId === p.id);
        const edited = Date.parse(p.lastEdited || "") || 0;
        const dirty = isKbEntryDirty(p.id);
        const rootId = containerRoots.has(p.id)
          ? kbRootId
          : rootOf.get(p.id) || p.id;
        const parentId = parentOf.get(p.id) || "";
        const meta = {
          notionRootId: rootId,
          notionRootName: titleById.get(rootId) || "",
          notionParentId: parentId || undefined,
          notionParentName: parentId ? titleById.get(parentId) || "" : "",
        };
        try {
          const needFetch =
            !local ||
            !local.content ||
            !local.notionSyncedAt ||
            local.notionSyncedAt < edited;
          let content = local?.content || "";
          if (needFetch && !dirty) {
            content =
              (await fetchNotionPageText(token, p.id, opts.fetchImpl)) || "";
          }
          const name = p.title || "(无标题)";
          if (local) {
            // 手动重命名的页面：标题以本地为准（titleLocked），不被 Notion 侧覆盖
            const finalName = local.titleLocked ? local.name : name;
            if (needFetch && !dirty) {
              const idx = entries.findIndex((e) => e.id === local.id);
              if (idx >= 0)
                entries[idx] = {
                  ...entries[idx],
                  name: finalName,
                  content,
                  notionId: p.id,
                  notionSyncedAt: now,
                  ...meta,
                };
              out.imported++;
            } else if (
              local.name !== finalName ||
              local.notionRootId !== meta.notionRootId ||
              local.notionParentId !== meta.notionParentId
            ) {
              // 标题或层级变化：更新（含升级后首次拉取回填 root/parent）
              const idx = entries.findIndex((e) => e.id === local.id);
              if (idx >= 0)
                entries[idx] = { ...entries[idx], name: finalName, ...meta };
            }
          } else if (!dirty) {
            entries.unshift({
              id: uid(),
              name,
              content,
              notionId: p.id,
              createdAt: now,
              notionSyncedAt: now,
              ...meta,
            });
            out.imported++;
          }
        } catch {
          out.errors.push(`「${p.title || "(无标题)"}」同步失败`);
        }
      }
    },
  );
  await Promise.all(workers);
  // 删除对账：仅在列表完整时执行（避免 cap 未拉完误删）
  let filtered = entries;
  if (complete) {
    filtered = entries.filter(
      (e) =>
        !e.notionId ||
        isKbEntryDirty(e.id) ||
        // 有「知识库」根时：子树外条目不在本次拉取范围 → 保留（不因「未出现在结果」而误删）
        (kbRootId && !containerRoots.has(e.notionId)) ||
        seen.has(e.notionId),
    );
  }
  writeEntries(filtered);
  return { total: pages.length, imported: out.imported, errors: out.errors };
}

// ---- 版本快照（撤销/恢复） ----
export interface KbSnapshot {
  time: number;
  entries: KbEntryRecord[];
}

export function loadKbSnapshots(): KbSnapshot[] {
  try {
    const r = JSON.parse(localStorage.getItem(SNAP_KEY) || "[]");
    if (Array.isArray(r)) return r as KbSnapshot[];
  } catch {
    /* 忽略 */
  }
  return [];
}

/** 写操作前自动拍快照（环形 SNAP_MAX 份，存当前 entries） */
export function snapshotKb(): void {
  try {
    const snaps = loadKbSnapshots();
    const snap: KbSnapshot = { time: Date.now(), entries: loadKbEntries() };
    const next = [snap, ...snaps].slice(0, SNAP_MAX);
    localStorage.setItem(SNAP_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
}

export function hasKbSnapshot(): boolean {
  return loadKbSnapshots().length > 0;
}

/** 撤销：恢复最近一份快照到 kimo_kb_entries + kimo_kb_notes，并移除该快照 */
export function restoreKbSnapshot(): KbEntryRecord[] | null {
  const snaps = loadKbSnapshots();
  if (!snaps.length) return null;
  const snap = snaps[0];
  writeEntries(snap.entries);
  const rest = snaps.slice(1);
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(rest));
  } catch {
    /* 忽略 */
  }
  return snap.entries;
}
