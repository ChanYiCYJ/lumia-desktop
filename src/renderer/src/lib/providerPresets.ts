/**
 * 模型服务商预设与特定适配（DeepSeek / Kimi(Moonshot) / OpenAI 兼容）
 * ------------------------------------------------------------------
 * - PROVIDER_PRESETS：各服务商一键填充的接口地址/推荐模型（LocalApiForm 快捷预设用）
 * - detectProvider：根据 endpoint / model 识别服务商（用于特定适配与 UI 提示）
 * - isReasoningModel：是否为推理模型（回复前先输出 reasoning_content 思考过程）
 * - resolveMaxTokens：按模型返回合理的输出 token 上限
 *   （推理模型如 deepseek-reasoner / kimi-thinking 会先消耗 reasoning token，
 *    必须给足否则 content 为空；Kimi moonshot-v1 默认 max_tokens=1024，长文易被截断）
 */

export type AiProvider = "deepseek" | "kimi" | "openai" | "other";

export interface ProviderPreset {
  id: AiProvider;
  /** 显示名 */
  name: string;
  /** 一键填充的接口地址（OpenAI 兼容 /chat/completions） */
  endpoint: string;
  /** 默认（推荐）模型 */
  model: string;
  /** 可选模型列表（下拉/提示用，按推荐度排序，最新在前） */
  models: string[];
  /** 最新（推荐）模型，用于卡片「最新」角标 */
  latest: string[];
  /** 说明文案（展示给用户） */
  desc: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v3.2",
      "deepseek-v3.1",
      "deepseek-v3",
      "deepseek-r1",
    ],
    latest: ["deepseek-v4-flash", "deepseek-v4-pro"],
    desc: "OpenAI 兼容接口。最新 v4-flash 支持 1M 上下文与思考/非思考双模式，性价比高",
  },
  {
    id: "kimi",
    name: "Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    models: [
      "kimi-k2.6",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-latest",
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
      "kimi-k2-turbo-preview",
      "kimi-k2-thinking-preview",
      "kimi-k2-0905-preview",
      "kimi-k2-0711-preview",
    ],
    latest: ["kimi-k2.6", "kimi-k3"],
    desc: "月之暗面兼容接口。最新 kimi-k2.6 支持 256K 上下文与思考模式；默认输出上限已自动调大避免长文被截断",
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1-nano"],
    latest: ["gpt-4o-mini"],
    desc: "OpenAI 官方兼容接口",
  },
];

export function getPreset(id: AiProvider): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** 根据接口地址 / 模型名识别服务商（用于特定适配与 UI 提示） */
export function detectProvider(endpoint: string, model: string): AiProvider {
  const e = endpoint.toLowerCase();
  const m = model.toLowerCase();
  if (e.includes("deepseek") || m.includes("deepseek")) return "deepseek";
  if (
    e.includes("moonshot") ||
    m.includes("moonshot") ||
    e.includes("kimi") ||
    m.includes("kimi")
  )
    return "kimi";
  if (e.includes("openai") || e.includes("openrouter") || m.includes("gpt"))
    return "openai";
  return "other";
}

/** 是否为推理模型（DeepSeek reasoner / Kimi thinking / OpenAI o1~o4 系列） */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("reasoner") ||
    m.includes("thinking") ||
    /(^|[-_./])(o[1-4])([-_./]|$)/.test(m) ||
    m.includes("o1-") ||
    m.includes("o3-") ||
    m.includes("o4-")
  );
}

/**
 * 按模型返回合理的输出 token 上限：
 * - 推理模型：16384（思考会先占用 token，给足避免 content 为空）
 * - Kimi/Moonshot：8192（默认 1024 太短，长文/文章生成易截断）
 * - 其他：fallback（默认 4096）
 */
export function resolveMaxTokens(model: string, fallback = 4096): number {
  const m = model.toLowerCase();
  if (isReasoningModel(m)) return 16384;
  if (m.includes("moonshot") || m.includes("kimi") || m.includes("k2"))
    return 8192;
  return fallback;
}

/**
 * 从 OpenAI 兼容的流式 delta 中解析增量文本。
 * 兼容 DeepSeek reasoner / Kimi thinking：思考过程在 delta.reasoning_content，
 * 正文在 delta.content。返回 { content, reasoning } 两个增量。
 */
export function parseDelta(delta: unknown): {
  content: string;
  reasoning: string;
} {
  const d = (delta || {}) as Record<string, unknown>;
  return {
    content:
      typeof d.content === "string"
        ? (d.content as string)
        : Array.isArray(d.content)
          ? (d.content as unknown[])
              .map((c) => {
                const p = c as { text?: string };
                return typeof p?.text === "string" ? p.text : "";
              })
              .join("")
          : "",
    reasoning:
      typeof d.reasoning_content === "string"
        ? (d.reasoning_content as string)
        : typeof d.reasoning === "string"
          ? (d.reasoning as string)
          : "",
  };
}

/** 从 OpenAI 兼容的非流式响应中提取正文（推理模型额外返回 reasoning_content，仅作统计/日志用） */
export function extractMessage(msg: unknown): {
  content: string;
  reasoning: string;
} {
  const m = (msg || {}) as Record<string, unknown>;
  return {
    content: typeof m.content === "string" ? (m.content as string) : "",
    reasoning:
      typeof m.reasoning_content === "string"
        ? (m.reasoning_content as string)
        : "",
  };
}
