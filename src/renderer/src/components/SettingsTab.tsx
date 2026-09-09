import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  loadCustomModelOn,
  saveCustomModelOn,
  loadTtsAudioUrl,
  saveTtsAudioUrl,
  TTS_VOICES,
  type ChatFontSize,
  type TtsSource,
  type TtsVoice,
} from "../lib/chatSettings";
import { LocalApiForm } from "./LocalApiForm";
import { SearchApiForm } from "./SearchApiForm";
import { NotionForm } from "./NotionForm";
import { NotionIcon } from "./ui";
import { NotionBackupCard } from "./NotionBackupCard";
import { hasNotionCfg, loadNotionDbId, notionPageUrl } from "../lib/notion";
import type { KnowledgeStoreMode } from "../lib/kbStore";
import {
  loadMcpServers,
  saveMcpServers,
  mcpListTools,
  mcpId,
  type McpServerConfig,
} from "../lib/mcp";

/**
 * Agent 面板「设置」tab 的数据/回调集合。
 * 由 AIChat 构造并通过 AgentPanel 的 settings 属性传入（desktop/mobile 双渲染共用一份）。
 */
export interface AgentSettingsProps {
  pageId: number;
  canManage: boolean;
  hasCustom: boolean;
  botName: string;
  /** 搜索模式（设置页与「/」弹窗共用同一单选，双向同步） */
  searchMode: "fast" | "auto" | "deep";
  onSetSearchMode: (m: "fast" | "auto" | "deep") => void;
  chatFontSize?: ChatFontSize;
  onSetFontSize?: (v: ChatFontSize) => void;
  onCustomSaved: () => void;
  /** 自定义模型开关（由 AIChat 统一管理：关闭后不再识别为自定义，本地配置保留） */
  customModelOn?: boolean;
  onToggleCustomModel?: () => void;
  allowCustomApi?: boolean;
  /** TTS 总开关（默认关闭；关闭时隐藏消息「朗读」按钮） */
  ttsOn?: boolean;
  onToggleTts?: () => void;
  /** TTS 音色（voice 参数） */
  ttsVoice?: TtsVoice;
  onSetTtsVoice?: (v: TtsVoice) => void;
  /** TTS 来源（内置后端 / 第三方地址） */
  ttsSource?: TtsSource;
  onSetTtsSource?: (v: TtsSource) => void;
  /** 试听当前 TTS 配置（验证调用 + Live2D 口型） */
  onTestTts?: () => void;
  /** 知识库保存目标（auto/本地/Notion） */
  kbStoreMode?: KnowledgeStoreMode;
  onSetKbStoreMode?: (m: KnowledgeStoreMode) => void;
  /** 本机工具（终端/文件/剪贴板，AI 操作电脑能力；桌面版） */
  localToolsOn?: boolean;
  onToggleLocalTools?: () => void;
}

/** 设置卡片：细边框 + 无阴影（对齐 Live2D 面板质感），左侧灰色条作为区块标识 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200/60 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-gray-400 dark:text-gray-500">
        <span className="h-3 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
        {title}
      </p>
      <div className="mt-2.5 space-y-2">{children}</div>
    </section>
  );
}

/** 简洁行式开关（无边框盒，贴近 Shiro 留白风格） */
function Toggle({
  on,
  onClick,
  label,
  sub,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 py-1.5 text-left"
      role="switch"
      aria-checked={on}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </span>
        {sub && (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-400">
            {sub}
          </span>
        )}
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-gray-900 dark:bg-gray-200" : "bg-gray-300 dark:bg-gray-700"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

export function SettingsTab({
  pageId,
  canManage,
  hasCustom,
  botName,
  searchMode,
  onSetSearchMode,
  chatFontSize = "base",
  onSetFontSize,
  onCustomSaved,
  customModelOn,
  onToggleCustomModel,
  allowCustomApi = true,
  ttsOn = false,
  onToggleTts,
  ttsVoice = "zh-CN-XiaoxiaoNeural",
  onSetTtsVoice,
  ttsSource = "backend",
  onSetTtsSource,
  onTestTts,
  localToolsOn = false,
  onToggleLocalTools,
}: AgentSettingsProps) {
  // 自定义模型开关：由 AIChat 统一管理（props 驱动，关闭后不再识别为自定义）；
  // 未传 props 时回退本地逻辑（兼容旧用法）
  const customOn = customModelOn ?? (loadCustomModelOn() || hasCustom);
  const toggleCustom = () => {
    if (onToggleCustomModel) {
      onToggleCustomModel();
    } else {
      saveCustomModelOn(!customOn);
    }
  };
  // 音频 TTS（独立卡片，默认收起表单）：内置后端 / 第三方地址 / 音色 / 试听 / 音量
  const [ttsAudioUrl, setTtsAudioUrl] = useState(() => loadTtsAudioUrl());
  // Notion MCP 连接卡片折叠态（默认折叠）
  const [notionOpen, setNotionOpen] = useState(false);
  // Notion 配置热更新：连接/清除后即时刷新徽标与同步区（无需刷新页面）
  const [notionTick, setNotionTick] = useState(0);
  useEffect(() => {
    const onCfg = () => setNotionTick((t) => t + 1);
    window.addEventListener("kimo:notion:configured", onCfg);
    window.addEventListener("kimo:notion:cleared", onCfg);
    return () => {
      window.removeEventListener("kimo:notion:configured", onCfg);
      window.removeEventListener("kimo:notion:cleared", onCfg);
    };
  }, []);
  void notionTick; // 触发重渲染使 hasNotionCfg() 重新求值
  // 技能与 MCP：服务器列表 + 添加表单 + 测试连接
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  const [mcpForm, setMcpForm] = useState({ name: "", command: "", args: "" });
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState("");
  const persistMcp = (list: McpServerConfig[]) => {
    saveMcpServers(list);
    setMcpServers(list);
  };
  const mcpAdd = () => {
    const name = mcpForm.name.trim();
    const command = mcpForm.command.trim();
    if (!name || !command) {
      setMcpError("请填写服务器名称与启动命令（如 npx -y @modelcontextprotocol/server-git）");
      return;
    }
    const args = mcpForm.args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    persistMcp([
      ...mcpServers,
      { id: mcpId(), name, command, args, enabled: true, tools: [] },
    ]);
    setMcpForm({ name: "", command: "", args: "" });
    setMcpError("");
  };
  const mcpTest = async (id: string) => {
    setMcpBusy(id);
    setMcpError("");
    const s = mcpServers.find((x) => x.id === id);
    if (!s) return;
    const r = await mcpListTools(s);
    if (r.ok) {
      persistMcp(mcpServers.map((x) => (x.id === id ? { ...x, tools: r.tools } : x)));
      setMcpError(r.tools.length ? `已连接，共 ${r.tools.length} 个工具` : "已连接（未发现工具）");
    } else {
      setMcpError(`连接失败：${r.error || "未知错误"}`);
    }
    setMcpBusy(null);
  };
  const mcpToggle = (id: string) => {
    persistMcp(mcpServers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };
  const mcpRemove = (id: string) => {
    persistMcp(mcpServers.filter((s) => s.id !== id));
  };
  const notionConnected = hasNotionCfg();
  /** 已配置默认数据库 id（用于「在 Notion 中打开数据库」跳转） */
  const notionDbId = notionConnected ? loadNotionDbId() : "";
  /** 搜索模式说明文案 */
  const searchModeDesc =
    searchMode === "fast"
      ? "纯本地快速：不联网、不生成文章，直接基于本地知识回答"
      : searchMode === "deep"
        ? "深度联网：搜索并生成完整综合文章（View 页面），仅此模式可生成文章"
        : "适当联网搜索：需要时自动联网搜索快速回答，不生成完整文章";

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {/* 模型管理：统一入口（预设 + 测试连接 + 保存；保存后当前 AI 对话立即生效） */}
      <Section title="模型管理">
        {canManage ? (
          <p className="rounded-xl bg-gray-50 p-3 text-xs leading-relaxed text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            当前使用管理员在「AI 管理」中为「{botName}
            」配置的默认模型；也可在本机覆盖（仅保存在本机，加密存储）。
          </p>
        ) : !allowCustomApi ? (
          <p className="rounded-xl bg-gray-50 p-3 text-xs leading-relaxed text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            管理员已关闭自定义模型设置。
          </p>
        ) : (
          <>
            <Toggle
              on={customOn}
              onClick={toggleCustom}
              label="使用自定义模型"
              sub="DeepSeek / Kimi / OpenAI / Ollama / LM Studio / 任意 OpenAI 兼容接口；保存后当前浏览器立即生效"
            />
            {customOn && (
              <>
                <LocalApiForm
                  pageId={pageId}
                  variant="inline"
                  showEnabledHint={hasCustom}
                  onSaved={onCustomSaved}
                />
                <p className="text-[11px] leading-relaxed text-gray-400">
                  未配置时使用系统默认模型；配置后自动解除次数与冷却限制。
                </p>
              </>
            )}
          </>
        )}
      </Section>

      {/* Notion MCP：连接 + 备份（置顶合并卡片） */}
      <Section title="Notion MCP">
        {/* 连接：开关式折叠 */}
        <div className="rounded-xl border border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800">
          <button
            onClick={() => setNotionOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition hover:bg-gray-100/60 dark:hover:bg-gray-700/40"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <NotionIcon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                接入工作区
              </span>
              <span className="block text-[10px] text-gray-400">
                双向同步知识库 · 多端同步
              </span>
            </span>
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${
                hasNotionCfg()
                  ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
              }`}
            >
              {hasNotionCfg() ? "已连接" : "未连接"}
            </span>
            <svg
              className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${notionOpen ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          <div
            className={`grid transition-all duration-300 ease-out ${
              notionOpen
                ? "grid-rows-[1fr] opacity-100"
                : "grid-rows-[0fr] opacity-0"
            }`}
          >
            <div className="overflow-hidden">
              <div className="border-t border-gray-100 px-3 py-2.5 dark:border-gray-800">
                <NotionForm />
                {/* 已配置默认数据库：可直接跳转 Notion 页面查看 */}
                {notionDbId && (
                  <a
                    href={notionPageUrl(notionDbId)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-500 transition hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    <NotionIcon className="h-3 w-3" />在 Notion 中打开数据库
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* 备份：合并进 MCP 卡 */}
        <NotionBackupCard />
      </Section>

      {/* 通用 */}
      <Section title="通用">
        <div className="flex items-center justify-between py-1">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            对话字体
          </span>
          <div className="flex gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
            {(["sm", "base", "lg"] as const).map((sz) => (
              <button
                key={sz}
                onClick={() => onSetFontSize?.(sz)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
                  chatFontSize === sz
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {sz === "sm" ? "小" : sz === "lg" ? "大" : "中"}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* 搜索模式：网络模式 + 搜索速度 + 搜索深度 合并为 Fast/Auto/Deep 单选 */}
      <Section title="搜索模式">
        <div className="space-y-1.5">
          <div className="flex gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
            {(
              [
                { v: "fast", l: "Fast" },
                { v: "auto", l: "Auto" },
                { v: "deep", l: "Deep" },
              ] as { v: "fast" | "auto" | "deep"; l: string }[]
            ).map((m) => (
              <button
                key={m.v}
                onClick={() => onSetSearchMode(m.v)}
                className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition ${
                  searchMode === m.v
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {m.l}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400">
            {searchModeDesc}
          </p>
        </div>
      </Section>

      {/* 本机工具：AI 操作电脑（终端/文件/剪贴板，桌面版） */}
      <Section title="本机工具">
        <Toggle
          on={localToolsOn}
          onClick={() => onToggleLocalTools?.()}
          label="允许 AI 操作电脑"
          sub="终端 / 文件读写 / 剪贴板；执行前会弹出确认窗口，可随时关闭"
        />
        <p className="text-[11px] leading-relaxed text-gray-400">
          开启后 AI 可通过指令调用本机工具帮你运行命令、查看/修改文件、复制剪贴板；
          敏感操作（终端命令、写文件）会先经你确认再执行。
        </p>
      </Section>

      {/* 技能与 MCP：添加 MCP 服务器（stdio），AI 可调用其工具（如 filesystem/git） */}
      <Section title="技能与 MCP">
        <p className="text-[11px] leading-relaxed text-gray-400">
          内置技能：本机工具 / 联网搜索 / 知识库 / Notion / Live2D（前 4 项可在本页开关）。
          下方可添加 MCP 服务器扩展能力（兼容 Claude Code / Trae 生态的 npx MCP 包）。
        </p>
        {mcpError && (
          <p className="rounded-xl bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
            {mcpError}
          </p>
        )}
        <div className="space-y-2">
          {mcpServers.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-gray-200 bg-gray-50/60 p-2.5 dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                  {s.name}
                </span>
                {s.enabled && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                    {(s.tools || []).length > 0 ? `${s.tools!.length} 个工具` : "已启用"}
                  </span>
                )}
                <button
                  onClick={() => void mcpTest(s.id)}
                  disabled={mcpBusy === s.id}
                  className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                >
                  {mcpBusy === s.id ? "连接中…" : "测试连接"}
                </button>
                <button
                  onClick={() => mcpToggle(s.id)}
                  role="switch"
                  aria-checked={s.enabled !== false}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                    s.enabled !== false ? "bg-gray-900 dark:bg-gray-200" : "bg-gray-300 dark:bg-gray-700"
                  }`}
                  title={s.enabled !== false ? "已启用（点击停用）" : "已停用（点击启用）"}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                      s.enabled !== false ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </button>
                <button
                  onClick={() => mcpRemove(s.id)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-400 transition hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/30"
                  title="删除"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-gray-400">
                {s.command} {(s.args || []).join(" ")}
              </p>
              {(s.tools || []).length > 0 && (
                <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
                  工具：{(s.tools || []).slice(0, 12).join("、")}
                </p>
              )}
            </div>
          ))}
        </div>
        {/* 添加 MCP 服务器 */}
        <div className="space-y-1.5 rounded-xl border border-dashed border-gray-200 p-2.5 dark:border-gray-700">
          <input
            value={mcpForm.name}
            onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
            placeholder="服务器名称，如 filesystem"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          />
          <input
            value={mcpForm.command}
            onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
            placeholder="启动命令，如 npx -y @modelcontextprotocol/server-filesystem"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          />
          <input
            value={mcpForm.args}
            onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
            placeholder="参数（空格分隔），如 /path/to/dir"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          />
          <button
            onClick={mcpAdd}
            className="w-full rounded-xl bg-gray-900 py-2 text-xs font-medium text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900"
          >
            添加服务器
          </button>
        </div>
      </Section>

      {/* 搜索 API：第三方搜索平台（Tavily / SearXNG），同搜索模式卡片样式 */}
      <Section title="搜索 API">
        <div className="space-y-2 pt-1">
          <SearchApiForm />
        </div>
      </Section>

      {/* 音频 TTS：朗读开关与来源 tab 合并；开启后展示音色/试听 */}
      <Section title="音频 TTS">
        <div className="space-y-2">
          {/* 朗读开关 + 来源分段（内置后端 / 第三方地址）合并为同一行控件 */}
          <div className="flex items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 transition dark:border-gray-700 dark:bg-gray-800">
            <button
              type="button"
              onClick={onToggleTts ?? (() => {})}
              role="switch"
              aria-checked={ttsOn}
              className="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <span>朗读</span>
              <span
                className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                  ttsOn
                    ? "bg-gray-900 dark:bg-gray-200"
                    : "bg-gray-300 dark:bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all duration-200 ${
                    ttsOn ? "left-[14px]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
            <span className="h-4 w-px shrink-0 bg-gray-200 dark:bg-gray-700" />
            {/* 来源分段：内置后端 / 第三方地址（选来源时自动开启朗读） */}
            <div className="flex min-w-0 flex-1 gap-0.5">
              {(
                [
                  { v: "backend", l: "内置后端" },
                  { v: "thirdparty", l: "第三方地址" },
                ] as { v: TtsSource; l: string }[]
              ).map((s) => (
                <button
                  key={s.v}
                  type="button"
                  onClick={() => {
                    onSetTtsSource?.(s.v);
                    if (!ttsOn) onToggleTts?.();
                  }}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                    ttsOn && ttsSource === s.v
                      ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                      : "text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                  }`}
                >
                  {s.l}
                </button>
              ))}
            </div>
          </div>

          {/* 开启后：配置项（淡入上滑） */}
          {ttsOn && (
            <div className="space-y-2 pt-0.5 animate-[kfade_0.2s_ease-out]">
              {/* 第三方地址输入（仅第三方来源，输入即保存） */}
              {ttsSource === "thirdparty" && (
                <input
                  value={ttsAudioUrl}
                  onChange={(e) => {
                    setTtsAudioUrl(e.target.value);
                    saveTtsAudioUrl(e.target.value);
                  }}
                  placeholder="TTS 地址模板：https://…/tts?text={text}"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800 animate-[kfade_0.2s_ease-out]"
                />
              )}
              {/* 音色 */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  音色
                </span>
                <select
                  value={ttsVoice}
                  onChange={(e) => onSetTtsVoice?.(e.target.value)}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                >
                  {TTS_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* 试听 */}
              <button
                onClick={onTestTts}
                className="w-full rounded-xl border border-gray-200 bg-white py-2 text-sm text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 active:scale-[0.99] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600"
              >
                试听
              </button>
            </div>
          )}
        </div>
      </Section>

      <p className="pt-1 text-center text-[11px] text-gray-400 dark:text-gray-500">
        AI 生成内容仅供参考
      </p>
    </div>
  );
}
