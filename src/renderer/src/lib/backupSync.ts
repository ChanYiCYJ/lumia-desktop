/**
 * Notion 全量数据同步（设置页「Notion MCP」卡内的同步区，替代原「数据」导入/导出）
 * ------------------------------------------------------------------
 * - 自动同步：memory/persona/settings 变更防抖推送；sessions 长防抖 + 体积上限保护
 * - 多端合并：云端比本机上次推送更新（另一设备写过）→ 自动合并（默认），并写回本机让多端收敛
 * - 初次配置：连接 Notion 后 runInitialSync() 拉取云端数据合并到本机（无数据则空跑）
 * - 密钥永不同步：自定义模型 API / 搜索 API / Notion Token / 机器人注册表等一律过滤
 * - Notion 布局：根页「AI Setting」→ 子页「备份 · 记忆/人格/设置/会话」，正文=序列化 JSON
 * - 同步位置可选：存 kimo_backup_root_id；切换后清空分类页 id，重同步到新根（旧根保留）
 * - 复用 notion.ts 写基建 + kbStore 同步队列模式（防抖合并 + 串行链 + latest-wins）
 * - 纯函数 + 可注入 fetch（Notion 写入可单测）
 */
import {
  createNotionSubPage,
  fetchNotionPageText,
  findNotionPageByTitle,
  hasNotionCfg,
  listNotionPagesAll,
  loadNotionCfg,
  notionFetchPage,
  replaceNotionPageContent,
  resolveNotionRoots,
} from "./notion";

export type BackupCategory = "memory" | "persona" | "settings" | "sessions";

export interface BackupCategoryDef {
  id: BackupCategory;
  label: string;
  desc: string;
  /** 前缀匹配的 localStorage key */
  prefixes: string[];
  /** 精确匹配的 localStorage key */
  exactKeys: string[];
  /** 自动同步防抖（ms）：小数据短、会话长 */
  debounceMs: number;
  /** 序列化后体积上限（字节），超限跳过该分类同步 */
  maxBytes?: number;
}

export const BACKUP_CATEGORIES: BackupCategoryDef[] = [
  {
    id: "memory",
    label: "记忆",
    desc: "对话记忆",
    prefixes: ["kimo_chat_memory_"],
    exactKeys: [],
    debounceMs: 2000,
  },
  {
    id: "persona",
    label: "人格",
    desc: "人格笔记",
    prefixes: ["kimo_ai_persona_"],
    exactKeys: [],
    debounceMs: 2000,
  },
  {
    id: "settings",
    label: "设置",
    desc: "偏好与配置",
    prefixes: [
      "kimo_ai_fontsize",
      "kimo_ai_net_mode",
      "kimo_ai_search_speed",
      "kimo_ai_search_depth",
      "kimo_ai_custom_model",
      "kimo_ai_tts",
      "kimo_ai_websearch",
      "kimo_ai_browse_agent",
      "kimo_ai_autoknow",
      "kimo_theme_mode",
      "kimo_kb_store_mode",
      "kimo_live2d_",
    ],
    exactKeys: [],
    debounceMs: 2000,
  },
  {
    id: "sessions",
    label: "会话",
    desc: "对话历史",
    prefixes: [
      "kimo_chat_sessions_",
      "kimo_ai_viewtopic_",
      "kimo_ai_agent_state_",
      "kimo_ai_toolcalls_",
      "kimo_chat_daily_",
      "kimo_chat_consent_",
    ],
    exactKeys: [],
    debounceMs: 4000,
    maxBytes: 2 * 1024 * 1024,
  },
];

// ---- 密钥黑名单（绝不备份 / 绝不被恢复覆盖）----
const SECRET_KEY_PATTERNS = [
  "kimo_ai_local_", // 自定义模型 endpoint/apiKey/model
  "kimo_search_api_cfg", // 搜索 API key
  "kimo_notion_cfg", // Notion Token（备份通道登录凭据）
  "kimo_notion_sel",
  "kimo_notion_db",
  "kimo_ai_bots", // 机器人注册表（含 apiKey）
  "kimo_ai_bot_config",
  "kimo_ai_config",
  "kimo_ai_polish_bot",
  "kimo_token", // 站点 JWT
  "kimo_mock_settings",
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => key.startsWith(p));
}

// ---- 收集 / 序列化 / 反序列化 ----
export interface BackupPayload {
  v: number;
  cat: BackupCategory;
  updatedAt: number;
  data: Record<string, string>;
  bytes: number;
}

/** 收集某分类的 localStorage 键值（自动过滤密钥） */
export function collectBackupData(cat: BackupCategory): Record<string, string> {
  const def = BACKUP_CATEGORIES.find((d) => d.id === cat);
  if (!def) return {};
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || isSecretKey(k)) continue;
      const hit =
        def.exactKeys.includes(k) || def.prefixes.some((p) => k.startsWith(p));
      if (hit) out[k] = localStorage.getItem(k) || "";
    }
  } catch {
    /* 忽略 */
  }
  return out;
}

/** 序列化为 Notion 页正文（含 updatedAt/体积） */
export function serializeBackup(cat: BackupCategory): BackupPayload {
  const data = collectBackupData(cat);
  const payload = { v: 1, cat, updatedAt: Date.now(), data };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return { ...payload, bytes };
}

/** 反序列化 Notion 页正文 → BackupPayload（非法返回 null） */
export function parseBackup(text: string): BackupPayload | null {
  try {
    const o = JSON.parse(text);
    if (!o || o.v !== 1 || !o.cat || !o.data || typeof o.data !== "object")
      return null;
    return {
      v: 1,
      cat: o.cat as BackupCategory,
      updatedAt: Number(o.updatedAt) || 0,
      data: o.data as Record<string, string>,
      bytes: 0,
    };
  } catch {
    return null;
  }
}

// ---- 本地备份状态（上次成功同步时间/体积，供展示与恢复对照）----
export interface BackupCatState {
  updatedAt: number;
  bytes: number;
}
const BACKUP_STATE_KEY = "kimo_backup_state";
export function loadBackupState(): Partial<
  Record<BackupCategory, BackupCatState>
> {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_STATE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveBackupState(
  s: Partial<Record<BackupCategory, BackupCatState>>,
): void {
  try {
    localStorage.setItem(BACKUP_STATE_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

// ---- 备份位置（根页 + 分类页 id）----
const ROOT_KEY = "kimo_backup_root_id";
const PAGES_KEY = "kimo_backup_pages";
const ROOT_PAGE_KEY = "kimo_backup_root_page";

/** 备份根页（「AI Setting」）页面 id 缓存，避免每次推送都重新查找 */
function loadRootPageId(): string {
  try {
    return localStorage.getItem(ROOT_PAGE_KEY) || "";
  } catch {
    return "";
  }
}
function saveRootPageId(id: string): void {
  try {
    localStorage.setItem(ROOT_PAGE_KEY, id);
  } catch {
    /* 忽略 */
  }
}

export function loadNotionBackupRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) || "";
  } catch {
    return "";
  }
}
export function saveNotionBackupRoot(rootId: string): void {
  try {
    if (rootId) localStorage.setItem(ROOT_KEY, rootId);
    else localStorage.removeItem(ROOT_KEY);
    // 切换位置：清掉旧分类页 id 与根页缓存，强制重建到新根（旧根页面保留不清理）
    localStorage.removeItem(PAGES_KEY);
    localStorage.removeItem(ROOT_PAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
export function clearBackupPages(): void {
  try {
    localStorage.removeItem(PAGES_KEY);
  } catch {
    /* 忽略 */
  }
}
function loadBackupPageIds(): Partial<Record<BackupCategory, string>> {
  try {
    return JSON.parse(localStorage.getItem(PAGES_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveBackupPageIds(ids: Partial<Record<BackupCategory, string>>): void {
  try {
    localStorage.setItem(PAGES_KEY, JSON.stringify(ids));
  } catch {
    /* 忽略 */
  }
}

export interface BackupRootOption {
  id: string;
  title: string;
}

/** 列出候选备份根（Content access 根），供「选择备份位置」下拉 */
export async function resolveBackupRoots(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<BackupRootOption[]> {
  if (!token.trim()) return [];
  const { pages } = await listNotionPagesAll(token, { fetchImpl });
  const { roots } = resolveNotionRoots(pages);
  return roots.map((r) => ({ id: r.id, title: r.title || "未命名根页面" }));
}

const ROOT_TITLE = "AI Setting";
const ROOT_CONTENT = "AI 设置与数据根页面（自动生成，请勿删除）";

/** 读取备份正文的最大字符数（云端 JSON 可能很大，避免 15000 截断误判） */
const MAX_READ_CHARS = 2 * 1024 * 1024;

/** 清空备份根缓存（测试用）：根页 id 已持久化在 localStorage */
export function resetBackupRootCache(): void {
  try {
    localStorage.removeItem(ROOT_PAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 在指定父页（Content access 根）下找/建同名子页：
 * 先按标题全局查找，校验父=目标根才复用；否则在目标根下新建。
 * ——避免复用其他位置的同名页导致备份被存到外面。
 */
async function findOrCreateChild(
  token: string,
  parentId: string,
  title: string,
  content: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const found = await findNotionPageByTitle(token, title, fetchImpl);
  if (found?.id) {
    const meta = await notionFetchPage(found.id, token, fetchImpl);
    if (meta.parentId === parentId) return found.id;
    // 父不是目标根（旧位置/其他）→ 走新建
  }
  const created = await createNotionSubPage(token, parentId, {
    title,
    content,
    fetchImpl,
  });
  return created?.id || "";
}

/**
 * 确保备份根页存在：
 * 目标位置（Content access 根）= 已选位置存 id 优先；未选择 → 默认第一个根（只有一个时必为它）并固化保存。
 * 根页「AI Setting」在目标根下找/建（作用域限定），页面 id 缓存以提速。
 */
export async function ensureBackupRoot(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (!token.trim()) return "";
  let rootId = loadNotionBackupRoot();
  if (!rootId) {
    const roots = await resolveBackupRoots(token, fetchImpl);
    if (!roots.length) return "";
    rootId = roots[0].id;
    saveNotionBackupRoot(rootId); // 固化默认（仅首次/未选择时）
  }
  const cached = loadRootPageId();
  if (cached) return cached;
  const pageId = await findOrCreateChild(
    token,
    rootId,
    ROOT_TITLE,
    ROOT_CONTENT,
    fetchImpl,
  );
  if (pageId) saveRootPageId(pageId);
  return pageId;
}

/** 确保分类页存在（在备份根下找/建并缓存 id；多设备去重：先按标题复用已有页） */
export async function ensureCategoryPage(
  cat: BackupCategory,
  rootId: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const def = BACKUP_CATEGORIES.find((d) => d.id === cat);
  if (!def) return "";
  const ids = loadBackupPageIds();
  if (ids[cat]) return ids[cat] as string;
  if (!token.trim() || !rootId) return "";
  const pageId = await findOrCreateChild(
    token,
    rootId,
    `备份 · ${def.label}`,
    "",
    fetchImpl,
  );
  if (pageId) saveBackupPageIds({ ...ids, [cat]: pageId });
  return pageId;
}

// ---- 推送（写入 Notion，镜像覆盖）+ 多端合并（默认合并） ----
export interface PushBackupResult {
  ok: boolean;
  oversize?: boolean;
  error?: string;
}

/** 把 payload 写入指定 Notion 分类页（镜像覆盖），成功后更新本地同步状态 */
async function pushPayload(
  cat: BackupCategory,
  payload: BackupPayload,
  pageId: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<PushBackupResult> {
  const text = JSON.stringify(payload);
  const ok = await replaceNotionPageContent(token, pageId, text, fetchImpl);
  if (ok) {
    const state = loadBackupState();
    state[cat] = { updatedAt: payload.updatedAt, bytes: payload.bytes };
    saveBackupState(state);
  }
  return { ok, error: ok ? undefined : "写入 Notion 失败" };
}

/**
 * 推送 payload 到分类页；写入失败（如页面已被删除/移动导致缓存 id 失效）时，
 * 清除根/分类页缓存并重建页面重试一次（自愈：Notion 里手动删掉备份页后自动恢复）。
 */
async function pushPayloadRetry(
  cat: BackupCategory,
  payload: BackupPayload,
  pageId: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<PushBackupResult> {
  const r = await pushPayload(cat, payload, pageId, token, fetchImpl);
  if (r.ok) return r;
  // 缓存可能指向已删除/移动的页面 → 清缓存重建一次
  clearBackupPages();
  resetBackupRootCache();
  const root2 = await ensureBackupRoot(token, fetchImpl);
  if (!root2) return r;
  const page2 = await ensureCategoryPage(cat, root2, token, fetchImpl);
  if (!page2) return r;
  return pushPayload(cat, payload, page2, token, fetchImpl);
}

/**
 * 同步某分类：序列化 → 确保根/分类页 → 读取云端已有备份。
 * 云端比本机上次推送更新（另一设备写过）→ 自动合并（默认）并写回本机（多端收敛）；否则镜像覆盖。
 */
export async function pushBackup(
  cat: BackupCategory,
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<PushBackupResult> {
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  if (!token.trim()) return { ok: false, error: "未配置 Notion" };
  const payload = serializeBackup(cat);
  const def = BACKUP_CATEGORIES.find((d) => d.id === cat);
  if (def?.maxBytes && payload.bytes > def.maxBytes) {
    return { ok: false, oversize: true };
  }
  // 本机该分类无数据：无需推送（初次拉取由云端合并进入本机）
  if (Object.keys(payload.data).length === 0) return { ok: true };
  const rootId = await ensureBackupRoot(token, opts.fetchImpl);
  if (!rootId) return { ok: false, error: "未找到同步位置" };
  const pageId = await ensureCategoryPage(cat, rootId, token, opts.fetchImpl);
  if (!pageId) return { ok: false, error: "创建同步页失败" };
  // 多端合并：云端存在且更新时间晚于本机上次推送（另一设备写过）→ 自动合并并写回本机
  const existingText = await fetchNotionPageText(
    token,
    pageId,
    opts.fetchImpl,
    MAX_READ_CHARS,
  );
  // 读取云端失败：保守跳过推送（避免用本机覆盖云端导致数据丢失）
  if (existingText === null) {
    return { ok: false, error: "读取云端备份失败，已跳过（防止覆盖云端数据）" };
  }
  const existing = parseBackup(existingText);
  const lastLocalPush = loadBackupState()[cat]?.updatedAt || 0;
  let target = payload;
  if (
    existing &&
    Object.keys(existing.data).length > 0 &&
    existing.updatedAt > lastLocalPush
  ) {
    target = mergeBackupPayload(payload, existing);
    writeMergedToLocal(target); // 仅变化时写回 + 派发恢复事件（多端收敛）
  }
  return pushPayloadRetry(cat, target, pageId, token, opts.fetchImpl);
}

// ---- 合并（memory/persona 行并集；sessions 数组按 id 并集；settings 本机优先） ----
function mergeLines(a: string, b: string): string {
  return [
    ...new Set([
      ...(a || "").split("\n").filter(Boolean),
      ...(b || "").split("\n").filter(Boolean),
    ]),
  ].join("\n");
}

function mergeValue(
  cat: BackupCategory,
  localVal: string,
  notionVal: string,
): string {
  if (cat === "memory" || cat === "persona") {
    return mergeLines(localVal, notionVal);
  }
  if (cat === "sessions") {
    try {
      const a = JSON.parse(localVal || "[]");
      const b = JSON.parse(notionVal || "[]");
      if (Array.isArray(a) && Array.isArray(b)) {
        const byId = new Map<string, unknown>();
        for (const s of a) {
          if (s && typeof s.id === "string") byId.set(s.id, s);
        }
        for (const s of b) {
          if (s && typeof s.id === "string" && !byId.has(s.id)) {
            byId.set(s.id, s);
          }
        }
        return JSON.stringify([...byId.values()]);
      }
    } catch {
      /* 非 JSON 数组 → 本机优先 */
    }
    return localVal;
  }
  return localVal; // settings：本机优先
}

/** 合并两份备份：云端为基础，本机键覆盖/并入 */
function mergeBackupPayload(
  local: BackupPayload,
  notion: BackupPayload,
): BackupPayload {
  const data: Record<string, string> = { ...notion.data };
  for (const [k, v] of Object.entries(local.data)) {
    data[k] = data[k] !== undefined ? mergeValue(local.cat, v, data[k]) : v;
  }
  const payload = { v: 1, cat: local.cat, updatedAt: Date.now(), data };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return { ...payload, bytes };
}

/** 写回本机（仅变化时），并派发恢复事件供 UI 重载（多端收敛） */
function writeMergedToLocal(payload: BackupPayload): void {
  let changed = false;
  for (const [k, v] of Object.entries(payload.data)) {
    if (isSecretKey(k)) continue;
    try {
      if (localStorage.getItem(k) !== v) {
        localStorage.setItem(k, v);
        changed = true;
      }
    } catch {
      /* 忽略 */
    }
  }
  if (changed) {
    try {
      window.dispatchEvent(new CustomEvent("kimo:backup:restored"));
    } catch {
      /* 非浏览器环境忽略 */
    }
  }
}

// ---- 初次配置同步（多端收敛） ----
const INITIAL_SYNCED_KEY = "kimo_backup_initial_synced";
export function getInitialSynced(): boolean {
  try {
    return localStorage.getItem(INITIAL_SYNCED_KEY) === "1";
  } catch {
    return false;
  }
}
export function markInitialSynced(): void {
  try {
    localStorage.setItem(INITIAL_SYNCED_KEY, "1");
  } catch {
    /* 忽略 */
  }
}
export function clearInitialSynced(): void {
  try {
    localStorage.removeItem(INITIAL_SYNCED_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 初次配置同步：连接 Notion 且本设备尚未初始化 → 逐类拉取云端数据并合并到本机。
 * 由「配置 Notion」或首次进入应用触发；已初始化则跳过。
 */
export async function runInitialSync(): Promise<void> {
  if (!hasNotionCfg() || getInitialSynced()) return;
  await forceBackupAll();
  markInitialSynced();
}

/**
 * 页面加载/刷新时的双向收敛同步（替代只读拉取）：
 * 逐类读取云端备份并与本机对比——
 * - 完全一致 → 跳过（不产生写操作）
 * - 本机有数据而云端空 → 推送填充云端（修复首次推送失败/遗漏导致的空白页）
 * - 云端有数据而本机无 → 拉取云端合并进本机（新设备/清缓存恢复）
 * - 两边都有且不同 → 合并 → 写回本机 + 推送云端（双向收敛）
 * 合并语义与 pushBackup 一致：记忆/人格行并集、会话按 id 并集、设置本机优先；
 * 行并集/按 id 并集幂等，不会无限累积；有变更才推送。
 * 每次执行都会发出同步状态事件（syncing→idle），供侧滑栏/同步卡显示加载动画。
 */
export async function syncOnRefresh(
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  if (!token.trim() || !hasNotionCfg()) return;
  emitBackupStatus({ state: "syncing" });
  try {
    const rootId = await ensureBackupRoot(token, opts.fetchImpl);
    if (!rootId) return;
    // 阶段 1：串行确保各分类页（避免并发重复创建页面）
    const pageMap = new Map<BackupCategory, string>();
    for (const def of BACKUP_CATEGORIES) {
      const pageId = await ensureCategoryPage(
        def.id,
        rootId,
        token,
        opts.fetchImpl,
      );
      if (pageId) pageMap.set(def.id, pageId);
    }
    if (!pageMap.size) return;
    // 阶段 2：并发读取各分类云端正文（大内容上限；减少串行 RTT 提速刷新同步）
    const reads = await Promise.all(
      [...pageMap.entries()].map(async ([cat, pageId]) => {
        const text = await fetchNotionPageText(
          token,
          pageId,
          opts.fetchImpl,
          MAX_READ_CHARS,
        );
        return {
          def: BACKUP_CATEGORIES.find((d) => d.id === cat) as BackupCategoryDef,
          pageId,
          text,
        };
      }),
    );
    // 阶段 3：串行合并/推送（写路径串行避免缓存竞争）
    for (const { def, pageId, text } of reads) {
      if (text === null) {
        // 读取失败（页面被删/网络错误）：不清真推送覆盖云端；清缓存让下次重建重试
        clearBackupPages();
        resetBackupRootCache();
        continue;
      }
      const localPayload = serializeBackup(def.id);
      // 本机数据超限：仍可拉取云端合并到本机，但不推送本机（避免写超大 JSON）
      const oversize = !!(def.maxBytes && localPayload.bytes > def.maxBytes);
      const existing = parseBackup(text);
      const localEmpty = Object.keys(localPayload.data).length === 0;
      const cloudEmpty = !existing || Object.keys(existing.data).length === 0;
      if (localEmpty && cloudEmpty) continue; // 两边都空 → 跳过
      if (localEmpty) {
        // 本机空、云端有 → 拉取云端合并进本机（新设备/清缓存恢复）
        writeMergedToLocal(existing as BackupPayload);
        continue;
      }
      const localJson = JSON.stringify(localPayload.data);
      const existingJson = JSON.stringify(existing?.data || {});
      if (localJson === existingJson) continue; // 完全一致 → 跳过
      const merged = existing
        ? mergeBackupPayload(localPayload, existing)
        : localPayload;
      if (existing) writeMergedToLocal(merged); // 云端数据并入本机（仅变化时派发恢复事件；超限场景也拉取）
      if (oversize) continue; // 本机超限：合并到本机即可，不推送本机（避免写超大 JSON）
      await pushPayloadRetry(def.id, merged, pageId, token, opts.fetchImpl); // 推送合并结果（云端空 → 填充；失败自动清缓存重建）
    }
  } finally {
    // 结束时回到 idle（若仍有排队同步则保持 syncing）
    emitBackupStatus({
      state: backupQueue.size > 0 ? "syncing" : "idle",
      error: backupStatus.error,
    });
  }
}

// ---- 同步队列（镜像 kbStore.queueKbSync：防抖合并 + 串行链 + latest-wins）----
export interface BackupSyncStatus {
  state: "idle" | "syncing";
  error?: string;
  cat?: BackupCategory;
}
interface QueueItem {
  cat: BackupCategory;
  fetchImpl?: typeof fetch;
  timer?: ReturnType<typeof setTimeout>;
}

const backupQueue = new Map<BackupCategory, QueueItem>();
let backupStatus: BackupSyncStatus = { state: "idle" };
const backupListeners = new Set<(s: BackupSyncStatus) => void>();
let backupChain: Promise<unknown> = Promise.resolve();
const backupResults = new Map<BackupCategory, PushBackupResult>();

function emitBackupStatus(s: BackupSyncStatus): void {
  backupStatus = s;
  backupListeners.forEach((l) => l(s));
}

const BACKUP_ERROR_CLEAR_MS = 8000;
let backupErrTimer: ReturnType<typeof setTimeout> | undefined;
function clearBackupErrorTimer(): void {
  if (backupErrTimer) {
    clearTimeout(backupErrTimer);
    backupErrTimer = undefined;
  }
}
function scheduleBackupErrorClear(): void {
  clearBackupErrorTimer();
  backupErrTimer = setTimeout(() => {
    backupErrTimer = undefined;
    emitBackupStatus({ state: backupStatus.state, error: undefined });
  }, BACKUP_ERROR_CLEAR_MS);
}

/** 订阅备份状态（idle/syncing + 最近错误），返回取消订阅函数 */
export function subscribeBackupSync(
  listener: (s: BackupSyncStatus) => void,
): () => void {
  backupListeners.add(listener);
  listener(backupStatus);
  return () => backupListeners.delete(listener);
}

export function getBackupStatus(): BackupSyncStatus {
  return backupStatus;
}

/** 清空备份队列与状态（测试用） */
export function resetBackupSyncQueue(): void {
  for (const [, item] of backupQueue) {
    if (item.timer) clearTimeout(item.timer);
  }
  backupQueue.clear();
  backupStatus = { state: "idle" };
  clearBackupErrorTimer();
  backupChain = Promise.resolve();
  backupResults.clear();
}

/** 数据变更后入队后台同步（未配置 Notion 不入队；sessions 走长防抖） */
export function queueBackupSync(
  cat: BackupCategory,
  opts: { fetchImpl?: typeof fetch } = {},
): void {
  if (!hasNotionCfg()) return;
  const def = BACKUP_CATEGORIES.find((d) => d.id === cat);
  if (!def) return;
  const prev = backupQueue.get(cat);
  if (prev?.timer) clearTimeout(prev.timer);
  backupQueue.set(cat, {
    cat,
    fetchImpl: opts.fetchImpl,
    timer: setTimeout(() => flushBackupSync(cat), def.debounceMs),
  });
}

/** 立即执行待备份分类（单个或全部），返回该任务完成的 Promise */
export function flushBackupSync(cat?: BackupCategory): Promise<void> {
  if (cat) {
    const item = backupQueue.get(cat);
    if (!item) return Promise.resolve();
    if (item.timer) clearTimeout(item.timer);
    backupQueue.delete(cat);
    const p = backupChain.then(() => runBackupJob(item));
    backupChain = p.catch(() => undefined);
    return p;
  }
  return Promise.all(
    [...backupQueue.keys()].map((k) => flushBackupSync(k)),
  ).then(() => undefined);
}

async function runBackupJob(item: QueueItem): Promise<void> {
  emitBackupStatus({ state: "syncing", cat: item.cat });
  try {
    const r = await pushBackup(item.cat, { fetchImpl: item.fetchImpl });
    backupResults.set(item.cat, r);
    const label =
      BACKUP_CATEGORIES.find((d) => d.id === item.cat)?.label || item.cat;
    const err = r.oversize ? `${label}数据过大，未同步` : r.error;
    emitBackupStatus({
      state: backupQueue.size > 0 ? "syncing" : "idle",
      cat: item.cat,
      error: err,
    });
    if (err) scheduleBackupErrorClear();
    else clearBackupErrorTimer();
  } catch {
    backupResults.set(item.cat, { ok: false, error: "备份失败" });
    emitBackupStatus({
      state: backupQueue.size > 0 ? "syncing" : "idle",
      cat: item.cat,
      error: "备份失败",
    });
    scheduleBackupErrorClear();
  }
}

/** 手动「立即备份」：逐类入队并立即 flush，返回每类结果 */
export async function forceBackupAll(
  opts: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ cat: BackupCategory; ok: boolean; oversize?: boolean }[]> {
  if (!hasNotionCfg()) return [];
  for (const def of BACKUP_CATEGORIES) {
    queueBackupSync(def.id, { fetchImpl: opts.fetchImpl });
  }
  await flushBackupSync();
  return BACKUP_CATEGORIES.map((def) => {
    const r = backupResults.get(def.id) || { ok: false, error: "未执行" };
    return { cat: def.id, ok: r.ok, oversize: r.oversize };
  });
}

// ---- 拉取（从 Notion 恢复） ----
export interface PullBackupResult {
  restored: BackupCategory[];
  skipped: BackupCategory[];
}

/**
 * 从 Notion 恢复全部备份：仅当备份 updatedAt 新于本地才写回；
 * 绝不写密钥键（防御），绝不删除本机多余键；成功后派发 kimo:backup:restored 事件。
 */
export async function pullBackupAll(
  opts: {
    token?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PullBackupResult> {
  const token = opts.token !== undefined ? opts.token : loadNotionCfg().token;
  const restored: BackupCategory[] = [];
  const skipped: BackupCategory[] = [];
  if (!token.trim()) return { restored, skipped };
  const pageIds = loadBackupPageIds();
  const state = loadBackupState();
  for (const def of BACKUP_CATEGORIES) {
    const pageId = pageIds[def.id];
    if (!pageId) {
      skipped.push(def.id);
      continue;
    }
    const text = await fetchNotionPageText(
      token,
      pageId,
      opts.fetchImpl,
      MAX_READ_CHARS,
    );
    if (!text) {
      skipped.push(def.id);
      continue;
    }
    const parsed = parseBackup(text);
    if (!parsed) {
      skipped.push(def.id);
      continue;
    }
    const localUpdated = state[def.id]?.updatedAt || 0;
    if (parsed.updatedAt <= localUpdated) {
      skipped.push(def.id);
      continue;
    }
    let wrote = false;
    for (const [k, v] of Object.entries(parsed.data)) {
      if (isSecretKey(k)) continue; // 防御：备份里即使含密钥键也不写
      try {
        localStorage.setItem(k, v);
      } catch {
        /* 忽略 */
      }
      wrote = true;
    }
    state[def.id] = { updatedAt: parsed.updatedAt, bytes: parsed.bytes || 0 };
    if (wrote) restored.push(def.id);
    else skipped.push(def.id);
  }
  saveBackupState(state);
  try {
    window.dispatchEvent(new CustomEvent("kimo:backup:restored"));
  } catch {
    /* 非浏览器环境忽略 */
  }
  return { restored, skipped };
}
