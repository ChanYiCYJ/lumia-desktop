import type { AIChatConfig } from "./types";
import type { LocalAIConfig } from "./localCfg";

/**
 * AI Chat 用户设置统一存储层
 * ------------------------------------------------------------------
 * 收敛散落在 AIChat / SettingsTab 中的 localStorage 读写：
 * - 统一 key 常量（保持线上已部署的 key 名，避免破坏存量用户偏好，不做破坏性迁移）
 * - 统一默认值、类型校验与读写容错（try/catch 全部内聚于此）
 * - 纯函数实现，可直接在 vitest 中单测
 *
 * 覆盖「用户偏好类」设置：对话字体 / 网络搜索 / 自动朗读 / 本机记忆 / effCfg 合并。
 * 会话、冷却、每日额度、consent 等「会话数据」仍由 AIChat 内部管理。
 */

export type ChatFontSize = "sm" | "base" | "lg";

/**
 * 网络模式：auto=智能（默认，Fast/Auto 模式用；AI 缺准确数据时自动联网搜索重答，不生成完整文章）、search=深度联网（Deep 模式用；搜索并自动生成综合文章，View 页面仅此模式可调用）
 */
export type ChatNetMode = "auto" | "search";

export const FONT_SIZES: readonly ChatFontSize[] = ["sm", "base", "lg"];

// ---- key 常量（保持线上稳定，勿随意改名）----
const KEY_FONT_SIZE = "kimo_ai_fontsize";
const KEY_NET_MODE = "kimo_ai_net_mode";
const KEY_WEB_SEARCH = "kimo_ai_websearch";
const KEY_BROWSE_AGENT = "kimo_ai_browse_agent";
const KEY_TTS = "kimo_ai_tts";
const KEY_MEMORY_PREFIX = "kimo_chat_memory_";
const KEY_CUSTOM_MODEL = "kimo_ai_custom_model";
const KEY_AUTO_KNOWLEDGE = "kimo_ai_autoknow";
const KEY_PERSONA_KNOWLEDGE_PREFIX = "kimo_ai_persona_";

// ---- localStorage 安全封装 ----
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略（隐私模式/配额满） */
  }
}
export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

// ---- 对话字体 ----
export function loadChatFontSize(): ChatFontSize {
  const v = lsGet(KEY_FONT_SIZE);
  return FONT_SIZES.includes(v as ChatFontSize) ? (v as ChatFontSize) : "base";
}
export function saveChatFontSize(v: ChatFontSize): void {
  lsSet(KEY_FONT_SIZE, v);
}

// ---- 网络模式（auto=智能(默认，适当联网搜索重答) / search=深度联网并生成文章，View 仅此模式）----
export function loadNetMode(): ChatNetMode {
  const v = lsGet(KEY_NET_MODE);
  if (v === "search" || v === "auto") return v;
  // 兼容旧值：view（浏览 Agent）已整合进 search；fast → auto（旧版 Fast=关闭网络，合并为 Auto 智能模式）
  if (v === "view") return "search";
  if (v === "fast") return "auto";
  // 迁移旧 key（无新模式时）：浏览 Agent / 网络搜索 任一显式开启 → search；否则默认 auto
  if (lsGet(KEY_BROWSE_AGENT) === "1") return "search";
  if (lsGet(KEY_WEB_SEARCH) === "1") return "search";
  return "auto";
}
export function saveNetMode(mode: ChatNetMode): void {
  lsSet(KEY_NET_MODE, mode);
}

// ---- 搜索速度（Fast=纯本地快速：不联网不生成文章；默认 standard，仅 Auto/Deep 用）----
export type ChatSearchSpeed = "fast" | "standard";
const KEY_SEARCH_SPEED = "kimo_ai_search_speed";
const SEARCH_SPEEDS: readonly ChatSearchSpeed[] = ["fast", "standard"];
export function loadSearchSpeed(): ChatSearchSpeed {
  const v = lsGet(KEY_SEARCH_SPEED);
  return SEARCH_SPEEDS.includes(v as ChatSearchSpeed)
    ? (v as ChatSearchSpeed)
    : "standard";
}
export function saveSearchSpeed(v: ChatSearchSpeed): void {
  lsSet(KEY_SEARCH_SPEED, v);
}

// ---- 搜索深度（auto=适当联网搜索重答(默认) / deep=深度：搜索并生成完整文章，仅 Deep 模式）----
export type ChatSearchDepth = "auto" | "deep";
const KEY_SEARCH_DEPTH = "kimo_ai_search_depth";
const SEARCH_DEPTHS: readonly ChatSearchDepth[] = ["auto", "deep"];
export function loadSearchDepth(): ChatSearchDepth {
  const v = lsGet(KEY_SEARCH_DEPTH);
  return SEARCH_DEPTHS.includes(v as ChatSearchDepth)
    ? (v as ChatSearchDepth)
    : "auto";
}
export function saveSearchDepth(v: ChatSearchDepth): void {
  lsSet(KEY_SEARCH_DEPTH, v);
}

// ---- 网络搜索（默认关闭，属于 search 模式）----
export function loadWebSearchOn(): boolean {
  return lsGet(KEY_WEB_SEARCH) === "1";
}
export function saveWebSearchOn(on: boolean): void {
  lsSet(KEY_WEB_SEARCH, on ? "1" : "0");
}

// ---- 浏览 Agent（默认关闭；与网络搜索互斥，开启后搜索自动生成综合文章）----
export function loadBrowseAgentOn(): boolean {
  return lsGet(KEY_BROWSE_AGENT) === "1";
}
export function saveBrowseAgentOn(on: boolean): void {
  lsSet(KEY_BROWSE_AGENT, on ? "1" : "0");
}

// ---- 自动朗读（用户浏览器偏好优先，未设置时跟随 config.autoTTS）----
export interface TtsPref {
  /** 是否已由用户显式设置过 */
  set: boolean;
  /** 生效值 */
  on: boolean;
}
export function loadTtsPref(configAutoTTS?: boolean): TtsPref {
  const p = lsGet(KEY_TTS);
  if (p === "1" || p === "0") return { set: true, on: p === "1" };
  return { set: false, on: !!configAutoTTS };
}
export function saveTtsPref(on: boolean): void {
  lsSet(KEY_TTS, on ? "1" : "0");
}

// ---- 音频 TTS：朗读时用「可返回音频的 TTS 地址」真实音频波形驱动口型（speakAudio）。
//      内置后端（/api/v1/tts，edge-tts 免费）无需填地址；第三方地址模板支持 {text} 占位符。----
const KEY_TTS_AUDIO_URL = "kimo_ai_tts_audio_url";
export function loadTtsAudioUrl(): string {
  return (lsGet(KEY_TTS_AUDIO_URL) || "").trim();
}
export function saveTtsAudioUrl(url: string): void {
  lsSet(KEY_TTS_AUDIO_URL, (url || "").trim());
}

/** 由模板 + 文本构造音频 URL（纯函数，可单测）：有 {text} 占位符则替换，否则拼接 ?text= */
export function buildTtsAudioUrl(
  template: string,
  text: string,
): string | null {
  const t = (template || "").trim();
  const txt = (text || "").trim();
  if (!t || !txt) return null;
  const encoded = encodeURIComponent(txt);
  if (t.includes("{text}")) return t.replace(/\{text\}/g, encoded);
  const sep = t.includes("?") ? "&" : "?";
  return t + sep + "text=" + encoded;
}

// ---- TTS 总开关（默认关闭：关闭后隐藏消息「朗读」按钮，不朗读）----
const KEY_TTS_ON = "kimo_ai_tts_on";
export function loadTtsOn(): boolean {
  return lsGet(KEY_TTS_ON) === "1";
}
export function saveTtsOn(on: boolean): void {
  lsSet(KEY_TTS_ON, on ? "1" : "0");
}

// ---- TTS 音量（朗读音频输出控制）----
export type TtsVolume = "low" | "medium" | "high";
const KEY_TTS_VOLUME = "kimo_ai_tts_volume";
const TTS_VOLUMES: readonly TtsVolume[] = ["low", "medium", "high"];
export function loadTtsVolume(): TtsVolume {
  const v = lsGet(KEY_TTS_VOLUME);
  return TTS_VOLUMES.includes(v as TtsVolume) ? (v as TtsVolume) : "medium";
}
export function saveTtsVolume(v: TtsVolume): void {
  lsSet(KEY_TTS_VOLUME, v);
}
/** 音量档位 → 0~1 数值（speakAudio 用） */
export function ttsVolumeValue(v: TtsVolume): number {
  return v === "low" ? 0.5 : v === "high" ? 1 : 0.8;
}

// ---- TTS 音色（voice 参数，对应 edge-tts 免费中文神经语音；也兼容其他支持 voice 的 TTS）----
export const TTS_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 女声（温柔）" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 男声" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 女声（活泼）" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 男声（浑厚）" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 男声（新闻）" },
];
export type TtsVoice = string;
const KEY_TTS_VOICE = "kimo_ai_tts_voice";
/** 默认音色：晓晓（最常用中文女声） */
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";
export function loadTtsVoice(): TtsVoice {
  const v = lsGet(KEY_TTS_VOICE);
  return v && TTS_VOICES.some((x) => x.id === v) ? v : DEFAULT_TTS_VOICE;
}
export function saveTtsVoice(v: TtsVoice): void {
  lsSet(KEY_TTS_VOICE, v);
}

/**
 * 给 TTS URL 设置/替换 voice 参数（纯函数，可单测）。
 * 已有 voice= 则替换（选择器为权威），否则追加 ?voice= / &voice=。
 */
export function applyTtsVoice(url: string, voice: string): string {
  if (!url || !voice) return url;
  const qi = url.indexOf("?");
  const hasQuery = qi >= 0;
  const base = hasQuery ? url.slice(0, qi + 1) : url + "?";
  const query = hasQuery ? url.slice(qi + 1) : "";
  const params = query.split("&").filter(Boolean);
  const out: string[] = [];
  let found = false;
  for (const p of params) {
    if (/^voice=/.test(p)) {
      out.push("voice=" + encodeURIComponent(voice));
      found = true;
    } else {
      out.push(p);
    }
  }
  if (!found) out.push("voice=" + encodeURIComponent(voice));
  return base + out.join("&");
}

// ---- TTS 来源（音频 TTS 模式的音频来源）----
export type TtsSource = "backend" | "thirdparty";
const KEY_TTS_SOURCE = "kimo_ai_tts_source";
/** 内置后端 TTS 模板（走 Cloudflare Worker /api 同源反代 → FastAPI /api/v1/tts，edge-tts 免费） */
export const BACKEND_TTS_TEMPLATE = "/api/v1/tts?text={text}";
export function loadTtsSource(): TtsSource {
  return lsGet(KEY_TTS_SOURCE) === "thirdparty" ? "thirdparty" : "backend";
}
export function saveTtsSource(source: TtsSource): void {
  lsSet(KEY_TTS_SOURCE, source);
}

/**
 * 根据来源解析最终 TTS 音频 URL（纯函数，可单测）：
 * - backend：内置后端 /api/v1/tts?text={text}（无需用户填地址）
 * - thirdparty：用户填的第三方地址模板
 * 两者都追加所选音色 voice；文本为空或模板缺失返回 null。
 */
export function resolveTtsAudioUrl(
  source: TtsSource,
  thirdPartyUrl: string,
  voice: string,
  text: string,
): string | null {
  const template =
    source === "backend" ? BACKEND_TTS_TEMPLATE : thirdPartyUrl || "";
  const built = buildTtsAudioUrl(template, text);
  if (!built) return null;
  return applyTtsVoice(built, voice);
}

// ---- auto-knowledge（默认开启）：对话后自动学习人格笔记，越聊越贴合人设 ----
export function loadAutoKnowledge(): boolean {
  return lsGet(KEY_AUTO_KNOWLEDGE) !== "0";
}
export function saveAutoKnowledge(on: boolean): void {
  lsSet(KEY_AUTO_KNOWLEDGE, on ? "1" : "0");
}

/** 读取人格笔记（按 pageId 隔离） */
export function loadPersonaKnowledge(pageId: number): string {
  return lsGet(KEY_PERSONA_KNOWLEDGE_PREFIX + pageId) || "";
}
export function savePersonaKnowledge(pageId: number, text: string): void {
  lsSet(KEY_PERSONA_KNOWLEDGE_PREFIX + pageId, text);
}
export function clearPersonaKnowledge(pageId: number): void {
  lsRemove(KEY_PERSONA_KNOWLEDGE_PREFIX + pageId);
}

// ---- 本机记忆（按 pageId 隔离）----
export function loadMemory(pageId: number): string {
  return lsGet(KEY_MEMORY_PREFIX + pageId) || "";
}
export function saveMemory(pageId: number, memory: string): void {
  lsSet(KEY_MEMORY_PREFIX + pageId, memory);
}
export function clearMemory(pageId: number): void {
  lsRemove(KEY_MEMORY_PREFIX + pageId);
}

// ---- 记忆自动压缩（防止 token 滥用）----
// 记忆结构：每行一条 "- 用户问：xx → AI 答：yy"
// 压缩策略：
//   1. 相同「问题前段」视为同主题，合并为最新一条（避免重复积累）
//   2. 超过 MAX_MEMORY_LINES 时只保留最新条目（丢弃最旧）
//   3. 超长条目截断，保证总字符数可控
const MAX_MEMORY_LINES = 10;
const MAX_MEMORY_CHARS = 1400;
const MAX_LINE_CHARS = 220;

/** 解析记忆文本为行数组（过滤空行） */
function memoryLines(memory: string): string[] {
  return memory
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 压缩记忆：合并同主题 + 限制条数/长度。
 * 输入旧记忆全文与新增 Q&A，返回压缩后的新记忆文本。
 */
export function compressMemory(
  oldMemory: string,
  question: string,
  answer: string,
): string {
  const insight = `用户问：${question.slice(0, 50)} → AI 答：${answer.slice(0, 80)}${answer.length > 80 ? "…" : ""}`;
  const lines = memoryLines(oldMemory);

  // 1) 同主题合并：问题前 12 字相同视为同一主题，覆盖旧条目
  const key = question.slice(0, 12);
  const deduped = lines.filter(
    (l) => !l.startsWith("- 用户问：") || !l.slice(0, 14).includes(key),
  );
  deduped.push(`- ${insight}`);

  // 2) 只保留最新 MAX_MEMORY_LINES 条
  const capped = deduped.slice(-MAX_MEMORY_LINES);

  // 3) 逐行截断 + 总量控制
  const truncated = capped.map((l) =>
    l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l,
  );
  let total = truncated.join("\n");
  while (total.length > MAX_MEMORY_CHARS && truncated.length > 1) {
    truncated.shift();
    total = truncated.join("\n");
  }
  return total;
}

// ---- 自定义模型开关（默认关闭，仅控制设置面板中表单的展开）----
export function loadCustomModelOn(): boolean {
  return lsGet(KEY_CUSTOM_MODEL) === "1";
}
export function saveCustomModelOn(on: boolean): void {
  lsSet(KEY_CUSTOM_MODEL, on ? "1" : "0");
}

// ---- 有效配置合并（本地自定义 API/提示词 > 选中人设 > 机器人默认）----
export function hasLocalApi(cfg: LocalAIConfig): boolean {
  return !!(cfg.endpoint || cfg.apiKey || cfg.model);
}

export function mergeEffCfg(
  config: AIChatConfig,
  localCfg: LocalAIConfig,
  activePromptIdx?: number | null,
): AIChatConfig {
  const prompts = config.prompts || [];
  const selected =
    activePromptIdx != null ? prompts[activePromptIdx] : undefined;
  return {
    ...config,
    endpoint: localCfg.endpoint || config.endpoint,
    apiKey: localCfg.apiKey || config.apiKey,
    model: localCfg.model || config.model,
    systemPrompt:
      localCfg.prompt || selected?.systemPrompt || config.systemPrompt,
  };
}
