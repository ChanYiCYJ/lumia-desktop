// ===== 多模型角色路由（借鉴 LiteLLM router：路由/回退/重试思路）=====
// 目标：搜索/关键词/摘要等「快任务」用便宜快速的模型，主对话/文章用主模型。
// 关键设计：只配 1 个模型时 fast/verifier 全部回落 primary（行为完全不变）；
// 只有用户在 kimo_ai_bots 注册了 ≥2 个机器人时才启用多模型路由——不强制、不破坏单模型。

import type { AIChatConfig } from "./types";
import { isReasoningModel } from "./providerPresets";

export type ModelRole = "primary" | "fast" | "verifier";

/** 三个角色（单模型时三者相同） */
export interface ModelRoles {
  primary: AIChatConfig;
  fast: AIChatConfig;
  verifier: AIChatConfig;
}

/** kimo_ai_bots 注册表项（AICenter loadBots 写入） */
export interface BotRegistryEntry {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

const BOT_REGISTRY_KEY = "kimo_ai_bots";

export function loadBotRegistry(): BotRegistryEntry[] {
  try {
    const raw = localStorage.getItem(BOT_REGISTRY_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as BotRegistryEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * 解析模型角色。单模型（或注册表 <2 个可用项）时 fast/verifier 回落 primary。
 * 多模型时：
 * - fast：优先选「非推理 + 名字含 fast/mini/flash/lite/small/8k」的便宜模型；否则第一个其他模型；
 * - verifier：与 fast 不同的另一个模型（用于事实共识校验，可选增强）。
 */
export function resolveModelRoles(primary: AIChatConfig): ModelRoles {
  const roles: ModelRoles = { primary, fast: primary, verifier: primary };
  try {
    const bots = loadBotRegistry();
    // 「另一个模型」= 与主模型不同的模型（同模型不同端点视为同一模型，不用于路由）
    const others = bots.filter((b) => b.model !== primary.model);
    if (others.length < 1) return roles; // 无第二个可用模型 → 全部回落 primary

    // fast：按「快」评分排序（非推理优先 + 命名启发式强弱），取最高分
    const fastRank = (b: BotRegistryEntry): number => {
      let s = 0;
      if (!isReasoningModel(b.model)) s += 10; // 推理模型不做 fast
      if (/mini|flash|lite/i.test(b.model)) s += 5; // 强信号
      if (/fast|small|turbo|nano/i.test(b.model)) s += 3;
      if (/8k|32k|128k/i.test(b.model)) s += 1; // 短上下文=便宜，弱信号
      return s;
    };
    const fastPick = [...others].sort((a, b) => fastRank(b) - fastRank(a))[0];
    roles.fast = {
      ...primary,
      endpoint: fastPick.endpoint,
      apiKey: fastPick.apiKey,
      model: fastPick.model,
    };

    // verifier：与 fast 不同的另一个模型（可能再用于另一视角）
    const verifierPick =
      others.find((b) => b.model !== fastPick.model) || fastPick;
    roles.verifier = {
      ...primary,
      endpoint: verifierPick.endpoint,
      apiKey: verifierPick.apiKey,
      model: verifierPick.model,
    };
  } catch {
    /* 任何异常回退单模型 */
  }
  return roles;
}

/** 按任务路由到模型角色（单模型时恒返回 primary，调用方无需感知） */
export function routeModel(roles: ModelRoles, task: ModelRole): AIChatConfig {
  return roles[task] || roles.primary;
}
