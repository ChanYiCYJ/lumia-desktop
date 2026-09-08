// ===== Live2D 角色人格模式 + 人物世界观·人格档案（纯函数层）=====
// 需求：
//  1) Live2D 有两个「人格来源」模式 —— 根据提示词（systemPrompt）/ 根据 Live2D 角色设定（角色扮演）
//  2) 角色设定 = 「人物世界观·人格档案」，首次启用（该角色无档案）时由 AI 自动搜索资料生成，并存入知识库
// 本模块只做纯函数 + localStorage（与 live2d.ts / chatSettings.ts 同构，可直接 vitest 单测）。

import { LIVE2D_CHARACTERS } from "./live2d";

// ---- 类型 ----

/** 人格来源模式：prompt=根据提示词（默认，AI 按后台配置的 systemPrompt 人设） / role=根据 Live2D 角色设定（角色扮演） */
export type Live2dPersonaMode = "prompt" | "role";

/** 角色设定档案（人物世界观·人格） */
export interface Live2dLore {
  /** 模型名（如 001_casual / 第三方 URL） */
  model: string;
  /** 角色名（如 户山 香澄） */
  name: string;
  /** 世界观 */
  world: string;
  /** 性格 */
  personality: string;
  /** 语气 / 说话风格 */
  tone: string;
  /** 背景故事 */
  background: string;
  /** 喜好 / 擅长 */
  likes: string;
  /** 重要关系 */
  relations: string;
  /** AI 自我搜索整理出的资料要点（可能为空） */
  notes: string;
  /** 是否已自动搜索过资料（true=已有网络资料支撑） */
  searched: boolean;
  updatedAt: number;
}

/** derive 后生成的档案草稿（不含 model/name/searched/updatedAt） */
export type Live2dLoreDraft = Pick<
  Live2dLore,
  | "world"
  | "personality"
  | "tone"
  | "background"
  | "likes"
  | "relations"
  | "notes"
>;

// ---- key 常量 ----

/** 人格模式（全局，Live2D 角色是站点级） */
export const L2D_PERSONA_MODE_KEY = "kimo_live2d_persona_mode";
/** 角色设定档案前缀（按模型隔离） */
export const L2D_LORE_PREFIX = "kimo_live2d_lore_";
/** 角色设定档案是否写入用户知识库（默认关=隔离，只用于角色扮演） */
export const L2D_LORE_TO_KB_KEY = "kimo_live2d_lore_to_kb";

// ---- localStorage 安全封装 ----

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略（隐私模式/配额满） */
  }
}

// ---- 人格模式读写 ----
// 默认「角色设定」：AI 默认以 Live2D 角色的人格扮演（用户偏好）；显式 prompt 才回退提示词人设

export function loadPersonaMode(): Live2dPersonaMode {
  return lsGet(L2D_PERSONA_MODE_KEY) === "prompt" ? "prompt" : "role";
}
export function savePersonaMode(mode: Live2dPersonaMode): void {
  lsSet(L2D_PERSONA_MODE_KEY, mode);
}

// ---- 知识库隔离：角色设定档案默认不写入用户知识库（只用于角色扮演） ----

export function loadLoreToKb(): boolean {
  return lsGet(L2D_LORE_TO_KB_KEY) === "1";
}
export function saveLoreToKb(on: boolean): void {
  lsSet(L2D_LORE_TO_KB_KEY, on ? "1" : "0");
}

// ---- 角色设定档案读写 ----

export function loadLore(model: string): Live2dLore | null {
  if (!model) return null;
  const raw = lsGet(L2D_LORE_PREFIX + model);
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as Live2dLore;
    if (!l || typeof l.name !== "string" || !l.name) return null;
    return l;
  } catch {
    return null;
  }
}

export function saveLore(model: string, lore: Live2dLore): void {
  if (!model || !lore) return;
  lsSet(L2D_LORE_PREFIX + model, JSON.stringify(lore));
}

/** 读取全部角色设定档案（按更新时间倒序），供知识库面板「角色设定」分区展示 */
export function loadAllLore(): Live2dLore[] {
  const list: Live2dLore[] = [];
  try {
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith(L2D_LORE_PREFIX),
    );
    for (const k of keys) {
      const l = loadLore(k.slice(L2D_LORE_PREFIX.length));
      if (l) list.push(l);
    }
  } catch {
    /* 忽略 */
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 删除角色档案（重新自动搜索用） */
export function clearLore(model: string): void {
  try {
    localStorage.removeItem(L2D_LORE_PREFIX + model);
  } catch {
    /* 忽略 */
  }
}

// ---- 搜索关键词 ----

/**
 * 生成角色资料搜索关键词：
 * - 内置 BanG Dream 角色 → 「{名} BanG Dream! 角色 设定 性格 背景 世界观」
 * - 第三方导入模型（未知角色）→ 「{名} Live2D 角色 设定 性格 世界观」
 */
export function loreSearchQuery(name: string, model?: string): string {
  const n = (name || "").trim();
  if (!n) return "";
  const known = !!model && LIVE2D_CHARACTERS.some((c) => c.model === model);
  return known
    ? `${n} BanG Dream! 角色 设定 性格 背景 世界观`
    : `${n} Live2D 角色 设定 性格 世界观`;
}

// ---- 档案 → 系统提示词（role 模式的人格来源，替代 systemPrompt）----

/**
 * 把角色设定档案组装成系统提示词人格片段。
 * 设计要点：强调「你就是这个角色」，世界观/性格/语气/背景/喜好/关系逐项给出，让 AI 稳定入戏；
 * 资料笔记（AI 自我搜索）也一并融入，回答时可引用真实设定。
 */
export function buildLorePrompt(lore: Live2dLore): string {
  if (!lore) return "";
  const rows = [
    `你是「${lore.name}」。这是你的人物世界观与人格设定，请始终保持这个角色的人设、语气与记忆，用第一人称与用户自然互动（不要提及"设定/扮演"这些词）。`,
    `世界观：${lore.world || "（未知）"}`,
    `性格：${lore.personality || "（未知）"}`,
    `语气：${lore.tone || "自然、贴近角色"}。`,
    `背景故事：${lore.background || "（未知）"}`,
    `喜好与擅长：${lore.likes || "（未知）"}`,
    `重要关系：${lore.relations || "（未知）"}`,
  ];
  if (lore.notes && lore.notes.trim()) {
    rows.push(`补充资料（可信设定）：${lore.notes.trim()}`);
  }
  rows.push(
    "当用户问起你的来历、经历或有关你的信息时，直接按以上设定回答；不清楚的可以自然地说你也不太确定，不要编造矛盾设定。",
  );
  return rows.join("\n");
}

// ---- 档案 → 知识库文本（首次自动搜索后写入知识库） ----

export function loreToText(lore: Live2dLore): string {
  const sec = (title: string, body: string) =>
    body && body.trim() ? `## ${title}\n${body.trim()}\n` : "";
  return [
    `# 「${lore.name}」角色设定档案`,
    "",
    sec("世界观", lore.world),
    sec("性格", lore.personality),
    sec("语气", lore.tone),
    sec("背景故事", lore.background),
    sec("喜好与擅长", lore.likes),
    sec("重要关系", lore.relations),
    sec("资料笔记", lore.notes),
    "（本档案由 AI 自动搜索资料整理生成，可作为角色扮演的事实参考）",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
