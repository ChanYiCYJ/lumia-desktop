// ===== Live2D Agent — 纯函数配置层（bestdori · Cubism 2）=====
// 数据流：fetchBuildData(modelName) → .Base(BuildData) → buildLive2dSettings →
//         Live2DModel.from(settings)（在 live2dCore 中执行）
// bestdori.com 不返回 CORS 头，浏览器无法跨域直连 → 所有资源走同源反代：
//   /api/live2d/asset/* → bestdori.com/assets/*
//   /api/live2d/api/*   → bestdori.com/api/*
// 本模块全部为纯函数 + localStorage，可直接在 vitest 中单测。

import type { SiteSettings } from './types'

// ---- 类型 ----

export interface BundleFile {
  bundleName: string
  fileName: string
}

export interface BuildData {
  model: BundleFile
  physics?: BundleFile
  textures: BundleFile[]
  motions: BundleFile[]
  expressions: BundleFile[]
  transition?: BundleFile
}

/** 传给 pixi-live2d-display 的 settings 对象（model/physics/纹理/动作/表情全部为同源绝对 URL） */
export interface Live2dSettings {
  url: string
  model: string
  physics?: string
  textures: string[]
  motions: Record<string, { file: string }[]>
  expressions: { name: string; file: string }[]
  /** 命中区域（点击/触摸交互用）：{ name, id }，id 为模型 drawable 名/索引 */
  hitAreas?: { name: string; id: string }[]
}

export interface Live2dModelInfo {
  modelName: string
  characterId: string
  costume: string
}

// ---- 常量 ----

/** bestdori 模型名：{角色ID:03d}_{服装}，如 001_casual（香澄常服）、011_casual（心常服） */
export const DEFAULT_LIVE2D_MODEL = '001_casual'

/** 精选角色（Agent 面板 Live2D tab 的换角色卡片），NNN_casual 均已验证存在 */
export interface Live2dCharacter {
  model: string
  name: string
  /** 所属乐队（换角色分组用）；自定义导入模型无此字段 */
  band?: string
}
export const LIVE2D_CHARACTERS: Live2dCharacter[] = [
  { model: '001_casual', name: '户山 香澄', band: "Poppin'Party" },
  { model: '002_casual', name: '花园 多惠', band: "Poppin'Party" },
  { model: '003_casual', name: '牛込 里美', band: "Poppin'Party" },
  { model: '004_casual', name: '山吹 沙绫', band: "Poppin'Party" },
  { model: '005_casual', name: '市谷 有咲', band: "Poppin'Party" },
  { model: '006_casual', name: '美竹 兰', band: 'Afterglow' },
  { model: '007_casual', name: '青叶 摩卡', band: 'Afterglow' },
  { model: '008_casual', name: '上原 绯玛丽', band: 'Afterglow' },
  { model: '009_casual', name: '宇田川 巴', band: 'Afterglow' },
  { model: '010_casual', name: '羽泽 鸫', band: 'Afterglow' },
  { model: '011_casual', name: '弦卷 心', band: 'Hello, Happy World!' },
  { model: '012_casual', name: '濑田 薰', band: 'Hello, Happy World!' },
  { model: '013_casual', name: '北泽 育美', band: 'Hello, Happy World!' },
  { model: '014_casual', name: '松原 花音', band: 'Hello, Happy World!' },
  { model: '015_casual', name: '米歇尔', band: 'Hello, Happy World!' },
  { model: '016_casual', name: '丸山 彩', band: 'Pastel*Palettes' },
  { model: '017_casual', name: '冰川 日菜', band: 'Pastel*Palettes' },
  { model: '018_casual', name: '白鹭 千圣', band: 'Pastel*Palettes' },
  { model: '019_casual', name: '大和 麻弥', band: 'Pastel*Palettes' },
  { model: '020_casual', name: '若宫 伊芙', band: 'Pastel*Palettes' },
  { model: '021_casual', name: '凑 友希那', band: 'Roselia' },
  { model: '022_casual', name: '冰川 纱夜', band: 'Roselia' },
  { model: '023_casual', name: '今井 莉莎', band: 'Roselia' },
  { model: '024_casual', name: '宇田川 亚子', band: 'Roselia' },
  { model: '025_casual', name: '白金 燐子', band: 'Roselia' }
]

/** 自定义导入模型（用户输入 bestdori 模型名，如 026_casual / 001_summer 等） */
export interface CustomLive2dModel {
  model: string
  name: string
}
export const LIVE2D_CUSTOM_KEY = 'kimo_live2d_custom_models'

export function loadCustomModels(): CustomLive2dModel[] {
  try {
    const r = JSON.parse(localStorage.getItem(LIVE2D_CUSTOM_KEY) || '[]')
    return Array.isArray(r)
      ? r.filter((m) => typeof m?.model === 'string' && typeof m?.name === 'string')
      : []
  } catch {
    return []
  }
}

export function saveCustomModels(list: CustomLive2dModel[]): void {
  try {
    localStorage.setItem(LIVE2D_CUSTOM_KEY, JSON.stringify(list))
  } catch {}
}

/** 添加自定义模型（按 model 去重），返回新列表 */
export function addCustomModel(model: string, name?: string): CustomLive2dModel[] {
  const m = (model || '').trim()
  if (!m) return loadCustomModels()
  const item: CustomLive2dModel = {
    model: m,
    name: (name || '').trim() || m
  }
  const list = [item, ...loadCustomModels().filter((x) => x.model !== m)]
  saveCustomModels(list)
  return list
}

export function removeCustomModel(model: string): CustomLive2dModel[] {
  const list = loadCustomModels().filter((x) => x.model !== model)
  saveCustomModels(list)
  return list
}

/** 模型名 → 角色名（未知回退模型名） */
export function characterNameOf(model: string): string {
  return LIVE2D_CHARACTERS.find((c) => c.model === model)?.name || model
}

/** 枚举接口（_info.json）不可用时的内置兜底模型（NNN_casual 常服，名字未知时显示 角色{id}） */
export const CURATED_LIVE2D_MODELS: string[] = Array.from(
  { length: 30 },
  (_, i) => `${String(i + 1).padStart(3, '0')}_casual`
)

/** 站点设置 key（后台 Settings） */
export const SETTING_ENABLE = 'live2d_enable'
export const SETTING_MODEL = 'live2d_model'

/** 用户本地选择 key */
export const LIVE2D_MODEL_KEY = 'kimo_live2d_model'
export const LIVE2D_PICKER_CACHE_KEY = 'kimo_live2d_picker_cache_v1'

/** auto 哨兵：本地选择为 auto 时每次加载随机选一个角色 */
export const LIVE2D_MODEL_AUTO = 'auto'

/** 选择器列表缓存有效期（ms） */
export const PICKER_CACHE_TTL = 24 * 60 * 60 * 1000

// ---- localStorage 安全封装（与 chatSettings 一致）----

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 忽略 */
  }
}

// ---- 反代 URL 构造 ----

/** 单个资源文件的同源反代 URL（model/motion 去 .bytes，texture .bytes→.png / 无扩展名补 .png） */
export function assetUrl(
  file: BundleFile,
  kind: 'model' | 'physics' | 'texture' | 'motion' | 'expression'
): string {
  let fileName = file.fileName
  if (kind === 'model' || kind === 'motion') {
    // bestdori 真实 asset 无子目录：motion 的 fileName 带 "motion/" 前缀，必须去掉
    // （否则 URL 指向不存在的 …/motion/xxx.mtn，bestdori 返回主页兜底 → 动作加载失败“没反应”）
    fileName = fileName.replace(/^motion\//, '').replace(/\.bytes$/, '')
  }
  if (kind === 'texture') {
    if (fileName.endsWith('.bytes')) fileName = fileName.replace(/\.bytes$/, '.png')
    else if (!fileName.includes('.')) fileName = `${fileName}.png`
  }
  return `lumia-live2d://asset/jp/${file.bundleName}_rip/${fileName}`
}

/** buildData.asset 的同源反代 URL */
export function buildDataUrl(modelName: string): string {
  return `lumia-live2d://asset/jp/live2d/chara/${modelName}_rip/buildData.asset`
}

/** 拉取 buildData.asset 并返回 .Base */
export async function fetchBuildData(modelName: string): Promise<BuildData> {
  const res = await fetch(buildDataUrl(modelName))
  if (!res.ok) throw new Error(`buildData HTTP ${res.status}`)
  const json: unknown = await res.json()
  const base = (json as { Base?: BuildData } | null)?.Base
  if (!base) throw new Error('buildData 缺少 Base')
  return base
}

/** BuildData → pixi-live2d-display settings（绝对 URL 指向同源反代） */
export function buildLive2dSettings(modelName: string, bd: BuildData): Live2dSettings {
  const motions: Record<string, { file: string }[]> = {}
  for (const m of bd.motions || []) {
    const key =
      (m.fileName.split('/').pop() || 'idle').replace(/\.bytes$/, '').replace(/\.mtn$/, '') ||
      'idle'
    motions[key] = [{ file: assetUrl(m, 'motion') }]
  }
  return {
    url: buildDataUrl(modelName),
    model: assetUrl(bd.model, 'model'),
    physics: bd.physics ? assetUrl(bd.physics, 'physics') : undefined,
    textures: (bd.textures || []).map((t) => assetUrl(t, 'texture')),
    motions,
    expressions: (bd.expressions || []).map((e) => ({
      name: e.fileName.replace(/\.exp\.json$/, ''),
      file: assetUrl(e, 'expression')
    }))
  }
}

// ---- 第三方模型导入（支持任意 Cubism2 model.json 网址）----

/** 内嵌的第三方模型来源示例（shizuku 白无垢 · guansss/pixi-live2d-display 开源测试模型，Cubism2） */
export const THIRD_PARTY_DEMO_MODEL =
  'https://raw.githubusercontent.com/guansss/pixi-live2d-display/master/test/assets/shizuku/shizuku.model.json'

/** Cubism3/4 示例模型（.model3.json，升级双运行时后支持；经 /api/live2d/proxy 加载） */
export interface Cubism34Model {
  name: string
  url: string
}
export const CUBISM34_MODELS: Cubism34Model[] = [
  {
    name: 'Mao（Cubism3 · 发型/表情/口型组齐全）',
    url: 'https://model.hacxy.cn/Mao/Mao.model3.json'
  }
]

/** 是否为第三方 model.json 输入（http(s) 网址，或含路径/ .json） */
export function isThirdPartyModelInput(v: string): boolean {
  const s = (v || '').trim()
  return /^https?:\/\//i.test(s) || /\.json$/i.test(s) || s.includes('/')
}

/** 经主进程代理拉取任意 URL（第三方资源无 CORS 头时必需；桌面端为自定义协议） */
export function live2dProxyUrl(target: string): string {
  return 'lumia-live2d://proxy?url=' + encodeURIComponent(target)
}

/**
 * 第三方模型资源用的绝对代理 URL。
 * pixi-live2d-display 会用 settings.url（model.json 的 base）解析资源相对路径，
 * 若返回相对路径会被拼到第三方主机（如 raw.githubusercontent.com）上导致 404 —— 必须绝对。
 */
export function absoluteLive2dProxyUrl(target: string): string {
  return 'lumia-live2d://proxy?url=' + encodeURIComponent(target)
}

/** 拉取第三方 Cubism2 model.json 并构造 pixi-live2d-display settings（相对路径按 model.json 所在目录解析） */
export async function fetchThirdPartyModel(modelUrl: string): Promise<Live2dSettings> {
  const res = await fetch(live2dProxyUrl(modelUrl))
  if (!res.ok) throw new Error('model.json HTTP ' + res.status)
  const json: unknown = await res.json()
  const j = (json || {}) as {
    model?: string
    textures?: string[]
    physics?: string
    motions?: Record<string, { file: string }[]>
    expressions?: { name?: string; file: string }[]
  }
  if (!j.model) throw new Error('model.json 缺少 model 字段（需 Cubism2 格式）')
  const base = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1)
  const abs = (p: string): string => {
    try {
      return new URL(p, base).href
    } catch {
      return base + p
    }
  }
  const motions: Record<string, { file: string }[]> = {}
  for (const [k, arr] of Object.entries(j.motions || {})) {
    motions[k] = (arr || [])
      .filter((m) => m && m.file)
      .map((m) => ({ file: absoluteLive2dProxyUrl(abs(m.file)) }))
  }
  return {
    url: modelUrl,
    model: absoluteLive2dProxyUrl(abs(j.model)),
    physics: j.physics ? absoluteLive2dProxyUrl(abs(j.physics)) : undefined,
    textures: (j.textures || []).map((t) => absoluteLive2dProxyUrl(abs(t))),
    motions,
    expressions: (j.expressions || []).map((e) => ({
      name: e.name || 'exp',
      file: absoluteLive2dProxyUrl(abs(e.file))
    }))
  }
}

// ---- Cubism3/4（.model3.json）加载链路（升级到双运行时后支持）----

/** 是否为 Cubism3/4 模型入口（.model3.json） */
export function isModel3Url(v: string): boolean {
  return /\.model3\.json$/i.test((v || '').trim())
}

/**
 * 解析第三方 Cubism3/4 model3.json 并构造 pixi-live2d-display settings。
 * 结构：FileReferences.Moc/Textures/Physics/Pose/Expressions/Motions + HitAreas + Groups。
 * 全部资源转绝对代理 URL（同 fetchThirdPartyModel 的处理）。
 */
export async function buildLive2dSettingsFromModel3(modelUrl: string): Promise<Live2dSettings> {
  const res = await fetch(live2dProxyUrl(modelUrl))
  if (!res.ok) throw new Error('model3.json HTTP ' + res.status)
  const json: unknown = await res.json()
  const j = (json || {}) as {
    FileReferences?: {
      Moc?: string
      Textures?: string[]
      Physics?: string
      Pose?: string
      Expressions?: { Name?: string; File?: string }[]
      Motions?: Record<string, { File?: string }[]>
    }
    HitAreas?: { Id?: string; Name?: string }[]
  }
  const fr = j.FileReferences || {}
  if (!fr.Moc) throw new Error('model3.json 缺少 FileReferences.Moc')
  const base = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1)
  const abs = (p: string): string => {
    try {
      return new URL(p, base).href
    } catch {
      return base + p
    }
  }
  const motions: Record<string, { file: string }[]> = {}
  for (const [k, arr] of Object.entries(fr.Motions || {})) {
    motions[k] = (arr || [])
      .filter((m) => m && m.File)
      .map((m) => ({ file: absoluteLive2dProxyUrl(abs(m.File!)) }))
  }
  const hitAreas = (j.HitAreas || [])
    .filter((h) => h && h.Id && h.Name)
    .map((h) => ({ name: h.Name!, id: h.Id! }))
  return {
    url: modelUrl,
    model: absoluteLive2dProxyUrl(abs(fr.Moc)),
    physics: fr.Physics ? absoluteLive2dProxyUrl(abs(fr.Physics)) : undefined,
    textures: (fr.Textures || []).map((t) => absoluteLive2dProxyUrl(abs(t))),
    motions,
    expressions: (fr.Expressions || []).map((e) => ({
      name: e.Name || 'exp',
      file: absoluteLive2dProxyUrl(abs(e.File || ''))
    })),
    hitAreas: hitAreas.length ? hitAreas : undefined
  }
}

/** 统一第三方模型加载入口：model3（.model3.json）走 Cubism3/4 链路，否则 Cubism2 */
export async function fetchThirdPartyModelSafe(modelUrl: string): Promise<Live2dSettings> {
  return isModel3Url(modelUrl)
    ? buildLive2dSettingsFromModel3(modelUrl)
    : fetchThirdPartyModel(modelUrl)
}

// ---- 表情（借鉴 SoulLink_Live2D 预设 + 平滑过渡）----

export type Emotion =
  'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'shy' | 'thinking' | 'sleepy' | 'wink'

export const EMOTIONS: readonly Emotion[] = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'thinking',
  'sleepy',
  'wink'
]

export interface EmotionPreset {
  key: Emotion
  label: string
  duration: number
  /** Cubism2 参数名 → 目标值（setParamFloat） */
  params: Record<string, number>
}

/** Cubism 2 通用参数预设（对齐 SoulLink PRESET_EXPRESSIONS 的精神，适配 bestdori 模型） */
export const EMOTION_PRESETS: Record<Emotion, EmotionPreset> = {
  neutral: {
    key: 'neutral',
    label: '平静',
    duration: 500,
    params: {
      // 复位所有表情参数到中性态，避免切换残留
      ParamBodyAngleZ: 0
    }
  },
  happy: {
    key: 'happy',
    label: '开心',
    duration: 600,
    params: {
      ParamEyeLSmile: 0.9,
      ParamEyeRSmile: 0.9,
      ParamMouthForm: 0.8,
      ParamMouthOpenY: 0.2,
      ParamBrowLY: 0.3,
      ParamBrowRY: 0.3,
      ParamCheek: 0.6,
      ParamBodyAngleZ: 0
    }
  },
  sad: {
    key: 'sad',
    label: '难过',
    duration: 700,
    params: {
      ParamBrowLY: -0.4,
      ParamBrowRY: -0.4,
      ParamMouthForm: -0.5,
      ParamEyeLOpen: 0.45,
      ParamEyeROpen: 0.45,
      ParamTear: 0.5,
      ParamBodyAngleZ: 0
    }
  },
  angry: {
    key: 'angry',
    label: '生气',
    duration: 600,
    params: {
      ParamBrowLAngle: 0.8,
      ParamBrowRAngle: 0.8,
      ParamBrowLY: 0.5,
      ParamBrowRY: 0.5,
      ParamMouthForm: -0.4,
      ParamEyeLOpen: 0.9,
      ParamEyeROpen: 0.9,
      ParamEyeLSmile: -0.3,
      ParamEyeRSmile: -0.3,
      ParamBodyAngleZ: 0
    }
  },
  surprised: {
    key: 'surprised',
    label: '惊讶',
    duration: 500,
    params: {
      ParamEyeLOpen: 1,
      ParamEyeROpen: 1,
      ParamMouthOpenY: 1,
      ParamBrowLY: 0.7,
      ParamBrowRY: 0.7,
      ParamBodyAngleZ: 0
    }
  },
  shy: {
    key: 'shy',
    label: '害羞',
    duration: 700,
    params: {
      ParamEyeLSmile: 0.4,
      ParamEyeRSmile: 0.4,
      ParamMouthForm: 0.3,
      ParamBrowLY: 0.4,
      ParamBrowRY: 0.4,
      ParamEyeLOpen: 0.4,
      ParamEyeROpen: 0.4,
      ParamCheek: 0.55,
      ParamBodyAngleZ: -0.08
    }
  },
  thinking: {
    key: 'thinking',
    label: '思考',
    duration: 800,
    params: {
      ParamEyeROpen: 0.4,
      ParamEyeLSmile: -0.2,
      ParamEyeRSmile: -0.2,
      ParamBrowLY: -0.3,
      ParamBrowRY: 0.5,
      ParamBodyAngleZ: 0.06
    }
  },
  sleepy: {
    key: 'sleepy',
    label: '困倦',
    duration: 900,
    params: {
      ParamEyeLOpen: 0.2,
      ParamEyeROpen: 0.2,
      ParamMouthOpenY: 0.1,
      ParamBrowLY: -0.2,
      ParamBrowRY: -0.2,
      ParamBodyAngleZ: 0.04
    }
  },
  wink: {
    key: 'wink',
    label: '眨眼',
    duration: 500,
    params: {
      ParamEyeROpen: 0,
      ParamEyeLSmile: 0.5,
      ParamEyeRSmile: 0.5,
      ParamMouthForm: 0.4,
      ParamCheek: 0.35,
      ParamBodyAngleZ: 0.05
    }
  }
}

/**
 * 情感 → 模型自带动作名候选（bestdori 模型 motions 含 angry01/sad01/surprised01/
 * smile01/shame01/sleep01/wink01/idle01 等）。播放模型自己的动作 = 真正的动作控制，
 * 比微调参数更直观可见。取第一个模型上存在的动作播放。
 */
export const EMOTION_MOTIONS: Record<Emotion, string[]> = {
  neutral: ['idle01', 'idle02', 'idle03', 'idle'],
  happy: [
    'smile01',
    'smile02',
    'smile03',
    'smile04',
    'oowarai01',
    'jaan01',
    'niyaniya01',
    'sing01',
    'laugh01'
  ],
  sad: ['sad01', 'sad02', 'sad03', 'cry01', 'cry02', 'cry03'],
  angry: ['angry01', 'angry02', 'serious01'],
  surprised: ['surprised01', 'surprised02', 'surprised03', 'scared01', 'surprised04'],
  shy: ['shame01', 'shame02', 'niyaniya01'],
  thinking: ['serious01', 'serious02', 'eeto01', 'nod01', 'nod02', 'look01'],
  sleepy: ['sleep01', 'sleep02', 'sleep03'],
  wink: ['wink01', 'smile05', 'smile06', 'wink02']
}

// ---- 点击/触摸命中反应（借鉴开源看板娘"戳头/摸身"互动，不限于表情）----
// 桌面 + 手机沉浸都启用：点角色头/身触发对应情绪动作 + 表情。

/** 命中区域（按角色包围盒上下划分：上部=头，下部=身） */
export type HitRegion = 'head' | 'body'

/** 区域 → 反应：情绪 + 可用动作候选（随机选一个，播不出来则用参数表情兜底） */
export interface TapReaction {
  emotion: Emotion
  motions: string[]
}
export const TAP_REACTIONS: Record<HitRegion, TapReaction> = {
  head: {
    emotion: 'surprised',
    motions: ['surprised01', 'surprised02', 'surprised03', 'scared01']
  },
  body: {
    emotion: 'happy',
    motions: ['smile01', 'smile02', 'niyaniya01', 'oowarai01', 'jaan01']
  }
}

/** 随机挑一个区域反应（同一区域每次反应动作不同） */
export function pickTapReaction(region: HitRegion): TapReaction {
  const r = TAP_REACTIONS[region] || TAP_REACTIONS.body
  const list = r.motions.length ? r.motions : ['idle01']
  return {
    emotion: r.emotion,
    motions: [list[Math.floor(Math.random() * list.length)]]
  }
}

/**
 * 由点击/触摸点在角色包围盒内的位置判断命中区域（纯函数，可单测）。
 * 模型以 (cx, cy) 为中心、包围盒宽高 (w, h)（已含缩放）。
 * @returns "head"（上部 ~45%）| "body"（下部）| null（盒外）
 */
export function resolveHitRegion(
  px: number,
  py: number,
  cx: number,
  cy: number,
  w: number,
  h: number
): HitRegion | null {
  if (!(w > 0) || !(h > 0)) return null
  if (Math.abs(px - cx) > w / 2 || Math.abs(py - cy) > h / 2) return null
  return py < cy - h * 0.05 ? 'head' : 'body'
}

/**
 * 音频 RMS 音量（0~1）→ 嘴张幅度（ParamMouthOpenY 0.06~0.9）映射（纯函数，可单测）。
 * 低音量保持微张（0.06）避免"僵住闭嘴"；说话时嘴明显张开（增益放大中低音量区间，封顶 0.9 适中）。
 * 增益 4.0：让口型随音量有明显起伏（说话张大/轻声收小），体现"换气换词"节奏；
 * 依赖 rmsSmooth+smoothMouth 平滑避免"有声音就满张"的抽搐跳变。
 */
export function rmsToMouth(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0.06
  const v = Math.min(1, rms * 4.2) // 增益：说话明显张大（rms0.2→0.79），轻声也有微动（rms0.08→0.35）
  return Math.min(0.9, 0.06 + v * 0.84) // 0.06 ~ 0.9（封顶适中，避免满张夸张/不自然）
}

/**
 * 高频能量比（flux/rms, 0~3）→ 嘴型宽度（PARAM_MOUTH_FORM_01, -0.6~0.6）。
 * 高比值 = 辅音/擦音（s/f/t/p 等瞬态多）→ 嘴型偏宽（正值，横向拉开）；
 * 低比值 = 元音/持续音（a/i/u 等稳态多）→ 嘴型偏圆（负值，收拢）。
 * 借鉴官方 Cubism2 多参数联动思路，与 openY 独立变化产生丰富口型。
 */
export function fluxToMouthWidth(fluxRatio: number): number {
  if (!Number.isFinite(fluxRatio) || fluxRatio <= 0) return -0.2
  const v = Math.min(1, fluxRatio * 0.35)
  return Math.max(-0.6, Math.min(0.6, -0.6 + v * 1.2))
}

/**
 * 低频能量比（0~1）→ 嘴型圆度（PARAM_MOUTH_FORM_02, -0.4~0.5）。
 * 高比值 = 元音（能量集中在低频）→ 嘴型偏圆（正值，如"o"/"u"）；
 * 低比值 = 辅音（能量分散）→ 嘴型偏扁（负值，如"i"/"e"）。
 */
export function lowRatioToMouthRound(lowRatio: number): number {
  if (!Number.isFinite(lowRatio) || lowRatio <= 0) return 0
  return Math.max(-0.4, Math.min(0.5, -0.2 + lowRatio * 0.7))
}

/**
 * RMS 能量包络 → 嘴部缩放（PARAM_MOUTH_SCALE, 0.9~1.15）。
 * 响度大 → 嘴部略微放大（强调），响度小 → 正常/略收。
 */
export function rmsToMouthScale(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 1.0
  const v = Math.min(1, rms * 3.0)
  return 0.9 + v * 0.25
}

/** 口型平滑参数（attack 快/release 慢，贴合音节且避免波形抖动造成口型闪烁） */
export interface SmoothMouthOpts {
  /** 有声时逼近系数（默认 0.6，开口较快、开头响应及时，仍柔和） */
  attack?: number
  /** 无声时逼近系数（默认 0.28，闭口自然连贯） */
  release?: number
  /** 说话期间最小开口（默认 0.16，音节间隙不闭死） */
  hold?: number
  /** 判定「在说话」的目标值阈值（默认 0.1，开头微弱声音也能触发张嘴） */
  threshold?: number
}

/**
 * 口型平滑单步（纯函数，可单测）：`prev + (target - prev) * k`。
 * - 开口比闭口快（attack 0.6 vs release 0.28）让开头响应及时、口型过渡柔和连贯；
 * - 说话期间嘴保持明显张开（≥hold），音节间隙不闭死，口型更易察觉。
 */
export function smoothMouth(prev: number, rms: number, opts?: SmoothMouthOpts): number {
  const target = rmsToMouth(rms)
  const speaking = target > (opts?.threshold ?? 0.1)
  const k = speaking ? (opts?.attack ?? 0.6) : (opts?.release ?? 0.28)
  let v = prev + (target - prev) * k
  if (speaking && v < (opts?.hold ?? 0.16)) v = opts?.hold ?? 0.16
  return v
}

/**
 * 分析口型序列，找出短语边界（停顿段 mouth openY < threshold 持续 > minGapMs）。
 * 用于在朗读过程中触发微点头/身体调整等语音协调动作。
 * @returns 边界时间点数组（毫秒），已去重且排序。
 */
// ---- 频谱分析（频带能量 -> 嘴型参数映射）----
// 借鉴官方 Cubism2 多参数联动思路：不同频带对应不同嘴型，
// 元音(低频)->嘴圆, 辅音(高频)->嘴宽, 与 openY 联动产生自然口型。

/** 频带能量（归一化 0~1） */
export interface FreqBands {
  low: number
  mid: number
  high: number
}

/** 从 getByteFrequencyData 提取三段频带 RMS 能量 */
export function analyzeFrequencyBands(data: Uint8Array, sampleRate: number): FreqBands {
  const n = data.length
  if (!n || sampleRate <= 0) return { low: 0, mid: 0, high: 0 }
  const binHz = sampleRate / 2 / n
  const bandRms = (s: number, e: number): number => {
    if (e <= s) return 0
    let sum = 0
    for (let i = s; i < e; i++) sum += (data[i] / 255) ** 2
    return Math.sqrt(sum / (e - s))
  }
  const lowS = Math.max(0, Math.floor(80 / binHz))
  const lowE = Math.min(n, Math.ceil(400 / binHz))
  const midS = Math.min(n, lowE)
  const midE = Math.min(n, Math.ceil(2000 / binHz))
  const highS = Math.min(n, midE)
  const highE = Math.min(n, Math.ceil(8000 / binHz))
  const maxRms = bandRms(0, n)
  const sc = maxRms > 0.001 ? 1 / maxRms : 1
  return {
    low: Math.min(1, bandRms(lowS, lowE) * sc),
    mid: Math.min(1, bandRms(midS, midE) * sc),
    high: Math.min(1, bandRms(highS, highE) * sc)
  }
}

/** 嘴型多维度参数 */
export interface MouthFormParams {
  width: number // PARAM_MOUTH_FORM_01: -0.6~0.6
  round: number // PARAM_MOUTH_FORM_02: -0.4~0.5
  scale: number // PARAM_MOUTH_SCALE: 0.9~1.15
}

/** 频带能量 -> 嘴型参数（宽/圆/缩放）纯函数 */
export function bandEnergiesToMouthParams(bands: FreqBands, overallRms: number): MouthFormParams {
  const total = bands.low + bands.mid + bands.high
  if (total < 0.001) return { width: 0, round: 0, scale: 1.0 }
  const hfR = Math.min(2, bands.high / Math.max(0.01, total))
  const lfR = Math.min(1, bands.low / Math.max(0.01, total))
  return {
    width: fluxToMouthWidth(hfR * 3),
    round: lowRatioToMouthRound(lfR),
    scale: rmsToMouthScale(overallRms)
  }
}

/** RMS滑动窗口->自适应增益: 安静TTS(avg<0.08)->x1.35, 响亮(avg>0.25)->x0.85 */
export function adaptiveRmsGain(rmsHistory: number[]): number {
  if (!rmsHistory.length) return 1.0
  let sum = 0,
    n = 0
  for (const v of rmsHistory) {
    if (Number.isFinite(v) && v >= 0) {
      sum += v
      n++
    }
  }
  if (!n) return 1.0
  const avg = sum / n
  if (avg < 0.08) return 1.35
  if (avg < 0.15) return 1.15
  if (avg > 0.25) return 0.85
  return 1.0
}

/**
 * 分析口型序列，找出短语边界（停顿段 mouth openY < threshold 持续 > minGapMs）。
 * 用于在朗读过程中触发微点头/身体调整等语音协调动作。
 * @returns 边界时间点数组（毫秒），已去重且排序。
 */
export interface SpeechBreak {
  /** 边界时间点（毫秒偏移） */
  t: number
  /** 停顿持续时长（毫秒） */
  dur: number
}
export function analyzeSpeechBreaks(
  seq: readonly { t: number; openY: number }[],
  threshold = 0.35,
  minGapMs = 300
): SpeechBreak[] {
  if (!seq.length) return []
  const breaks: SpeechBreak[] = []
  let gapStart = -1
  for (let i = 0; i < seq.length; i++) {
    const kf = seq[i]
    if (kf.openY < threshold) {
      if (gapStart < 0) gapStart = kf.t
    } else if (gapStart >= 0) {
      const dur = kf.t - gapStart
      if (dur >= minGapMs) {
        breaks.push({ t: gapStart + dur / 2, dur }) // 边界取停顿中点
      }
      gapStart = -1
    }
  }
  // 序列末尾的停顿也算
  if (gapStart >= 0 && seq.length > 0) {
    const lastT = seq[seq.length - 1].t
    const dur = lastT - gapStart
    if (dur >= minGapMs) {
      breaks.push({ t: gapStart + dur / 2, dur })
    }
  }
  return breaks
}

/** 本地规则情感检测（关键词 + 表情符号，按命中数取最高；无命中 → neutral） */
const EMOTION_RULES: ReadonlyArray<readonly [Emotion, RegExp]> = [
  [
    'angry',
    /生气|气死|愤怒|可恶|气人|火大|讨厌|混蛋|气炸|烦躁|岂有此理|瞪|哼|怒了|恼火|气鼓鼓|不服|火冒三丈|不满|抗议|谴责|咬牙切齿|暴怒|怒不可遏|😡|🤬|😠|👿|💢/
  ],
  // 平手（得分相同）取先者 → 正向情绪（happy）排在 sad 前，避免"笑出声"与"语气放软"并存时误判为难过
  [
    'happy',
    /哈哈|嘻嘻|嘿嘿|开心|高兴|快乐|喜欢|太好了|耶|好棒|爱你|谢谢|笑|笑起来|笑死|眯眼|俏皮|嘴角|翘起|乐了|美滋滋|得意|眉开眼笑|元气|愉悦|兴奋|激动|欢呼|雀跃|飘飘然|欣喜|狂喜|😊|😍|🥰|😘|💕|🥹|😄/
  ],
  [
    'sad',
    /呜呜|难过|伤心|想哭|哭|难受|心碎|好惨|泪|沮丧|失望|郁闷|心累|崩溃|孤独|委屈|放软|轻声|叹气|低落|柔和|哽咽|破防|emo|绷不住|垂头|黯然|鼻酸|失落|惆怅|心酸|寂寞|空虚|悲哀|忧伤|😢|😭|🥺|😔|😞|💔/
  ],
  [
    'surprised',
    /震惊|竟然|天哪|真的吗|不可能|意外|惊讶|卧槽|哇塞|吓一跳|吓了一跳|吃惊|呆住|惊了|真的假的|难以置信|目瞪口呆|愣住|咦|诶|震撼|不可思议|大开眼界|叹为观止|诧异|愕然|😱|😨|😲|🤯|🙀/
  ],
  [
    'shy',
    /害羞|脸红|不好意思|羞涩|羞死|别过脸|低头|别扭|尴尬|难为情|含羞|怯生生|忸怩|支支吾吾|欲言又止|脸一红|惭愧|过意不去|无地自容|腼腆|害臊|窘迫|🫣/
  ],
  [
    'thinking',
    /思考|想想|琢磨|纠结|考虑|大概|也许|可能|沉思|若有所思|歪头|喃喃|唔|分析|推理|推测|盘算|斟酌|思索|🤔/
  ],
  [
    'sleepy',
    /困|睡觉|晚安|好累|疲惫|哈欠|乏|犯困|没精打采|打盹|累了|倦了|眯一会|瞌睡|昏昏欲睡|😴|🥱|💤/
  ],
  ['wink', /眨眼|抛媚眼|挤眉弄眼|使眼色|俏皮眨眼|😉|😜|😏/]
]

export function detectEmotion(text: string): Emotion {
  const t = (text || '').toLowerCase()
  let best: Emotion = 'neutral'
  let bestScore = 0
  for (const [em, re] of EMOTION_RULES) {
    const m = t.match(re)
    const score = m ? m.length : 0
    if (score > bestScore) {
      best = em
      bestScore = score
    }
  }
  return best
}

/**
 * 从 AI 回复推断角色情绪（AI 是 Live2D 角色）。
 * 优先解析括号内的动作/表情描写（如（吓了一跳）（声音放软了些）（别过脸去）），
 * 这些是 AI 角色的表演提示，比正文更准（避免正文里"开心"等安慰话术误判）；无则回退整段。
 */
export function detectReplyEmotion(text: string): Emotion {
  const t = text || ''
  const parens = (t.match(/[（(][^（）()]{1,50}[)）]/g) || []).join(' ')
  if (parens) {
    const fromParens = detectEmotion(parens)
    if (fromParens !== 'neutral') return fromParens
  }
  return detectEmotion(t)
}

// ---- AI 表情标签（AI Chat 控制表情）：回复末尾可附 [表情:开心] / 【表情:别扭】 / [EMOTION:开心] ----

/** 兼容方括号/中文括号，任意名称都捕获（由别名表映射，未知名返回 null） */
const EMOTION_TAG_RE = /[\[【]\s*(?:表情|EMOTION)\s*[:：]\s*([^\]】]{1,12}?)\s*[\]】]/i

/** 标签名称 → 情绪（含别名，AI 可能写 高兴/别扭/尴尬 等） */
const EMOTION_LABEL_ALIASES: Record<string, Emotion> = {
  平静: 'neutral',
  中性: 'neutral',
  开心: 'happy',
  高兴: 'happy',
  快乐: 'happy',
  愉悦: 'happy',
  喜悦: 'happy',
  欣喜: 'happy',
  狂喜: 'happy',
  满足: 'happy',
  兴奋: 'happy',
  难过: 'sad',
  伤心: 'sad',
  悲伤: 'sad',
  悲哀: 'sad',
  忧伤: 'sad',
  悲痛: 'sad',
  哀伤: 'sad',
  委屈: 'sad',
  沮丧: 'sad',
  生气: 'angry',
  愤怒: 'angry',
  恼怒: 'angry',
  愤慨: 'angry',
  暴怒: 'angry',
  震怒: 'angry',
  惊讶: 'surprised',
  震惊: 'surprised',
  意外: 'surprised',
  惊奇: 'surprised',
  诧异: 'surprised',
  愕然: 'surprised',
  骇然: 'surprised',
  害羞: 'shy',
  别扭: 'shy',
  尴尬: 'shy',
  羞涩: 'shy',
  腼腆: 'shy',
  害臊: 'shy',
  难堪: 'shy',
  窘迫: 'shy',
  思考: 'thinking',
  沉思: 'thinking',
  思索: 'thinking',
  困倦: 'sleepy',
  困: 'sleepy',
  困了: 'sleepy',
  疲惫: 'sleepy',
  眨眼: 'wink',
  俏皮: 'wink'
}

/** 从 AI 回复中解析表情标签，无则返回 null（AI 控制表情） */
export function parseEmotionTag(text: string): Emotion | null {
  const m = (text || '').match(EMOTION_TAG_RE)
  if (!m) return null
  return EMOTION_LABEL_ALIASES[m[1].trim()] || null
}

/** 剥离显示文本中的表情标签（与 stripToolCmds 一起用于消息展示；方/中文括号、任意名称都剥离） */
export function stripEmotionTag(text: string): string {
  return (text || '').replace(/[\[【]\s*(?:表情|EMOTION)\s*[:：]\s*[^\]】]*?[\]】]/gi, '').trim()
}

// ---- 模型选择（bestdori 枚举）----

/** 从 _info.json 提取 live2d.chara 键，过滤 NNN_* 角色服装模型 */
export function parseModelNames(assetsIndex: unknown): string[] {
  const chara =
    (assetsIndex as { live2d?: { chara?: Record<string, unknown> } })?.live2d?.chara || {}
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of Object.keys(chara)) {
    if (!/^\d{3}_[a-z0-9_-]+$/.test(k)) continue
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out.sort()
}

export function modelInfo(modelName: string): Live2dModelInfo {
  const m = /^(\d{3})_(.+)$/.exec(modelName)
  return {
    modelName,
    characterId: m ? m[1] : '',
    costume: m ? m[2] : modelName
  }
}

/** characters/all.2.json → id→名字（优先简体中文，回退首个非空） */
export function parseCharacters(chars: unknown): Map<string, string> {
  const map = new Map<string, string>()
  const obj = (chars as Record<string, { characterName?: unknown } | undefined>) || {}
  for (const [id, info] of Object.entries(obj)) {
    const arr = info?.characterName
    const list = Array.isArray(arr) ? (arr as unknown[]) : []
    // characterName 数组：[, 日文, 英文, 繁中, 简中, 韩文…] → 优先简中（index 3）
    const zh = typeof list[3] === 'string' && String(list[3]).trim() ? String(list[3]).trim() : ''
    const name = zh || list.find((s) => typeof s === 'string' && s.trim())
    map.set(id, String(name || id))
  }
  return map
}

/** 角色分组模型列表（选择器用）：{ characterId, characterName, models[] } */
export interface CharaGroup {
  characterId: string
  characterName: string
  models: string[]
}

export function groupModels(modelNames: string[], charaMap: Map<string, string>): CharaGroup[] {
  const groups = new Map<string, CharaGroup>()
  for (const name of modelNames) {
    const { characterId, costume } = modelInfo(name)
    if (!characterId) continue
    const g = groups.get(characterId) || {
      characterId,
      // chars 接口 key 是数字字符串（1,2…）而模型名是补零（001）→ 同时尝试两种形式
      characterName:
        charaMap.get(characterId) ||
        charaMap.get(String(Number(characterId))) ||
        charaMap.get(characterId.replace(/^0+/, '')) ||
        `角色 ${characterId}`,
      models: []
    }
    g.models.push(`${characterId}_${costume}`)
    groups.set(characterId, g)
  }
  return [...groups.values()].sort((a, b) => a.characterName.localeCompare(b.characterName, 'zh'))
}

// ---- 本地模型选择 + 选择器缓存 ----

export function loadLive2dModel(): string {
  return lsGet(LIVE2D_MODEL_KEY) || ''
}
export function saveLive2dModel(name: string): void {
  lsSet(LIVE2D_MODEL_KEY, name)
}

/** 随机选一个精选角色（auto 模式兜底用） */
export function randomLive2dModel(): string {
  const list = LIVE2D_CHARACTERS
  return list[Math.floor(Math.random() * list.length)].model
}

// ---- auto 模式：AI 按记忆/知识库选角（缓存最近一次 AI 选角，避免每次随机）----

/** AI 选角缓存 key */
export const LIVE2D_AUTO_PICK_KEY = 'kimo_live2d_auto_pick'
/** AI 选角缓存有效期（ms） */
export const AUTO_PICK_TTL = 60 * 60 * 1000

export interface Live2dAutoPick {
  model: string
  ts: number
}

export function saveAutoPick(model: string): void {
  try {
    lsSet(LIVE2D_AUTO_PICK_KEY, JSON.stringify({ model, ts: Date.now() }))
  } catch {
    /* 忽略 */
  }
}

export function getAutoPick(): Live2dAutoPick | null {
  const raw = lsGet(LIVE2D_AUTO_PICK_KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Live2dAutoPick
    if (
      !p ||
      typeof p.model !== 'string' ||
      !p.model ||
      typeof p.ts !== 'number' ||
      Date.now() - p.ts > AUTO_PICK_TTL
    )
      return null
    return p
  } catch {
    return null
  }
}

// ---- auto 选角请求（Live2DStage 开启 auto 时通知 AIChat 让 AI 重新选角）----

type AutoPickListener = () => void
const autoPickListeners = new Set<AutoPickListener>()

/** 订阅「auto 选角请求」事件（AIChat 用） */
export function onAutoPickRequest(fn: AutoPickListener): () => void {
  autoPickListeners.add(fn)
  return () => {
    autoPickListeners.delete(fn)
  }
}

/** 发出「auto 选角请求」（Live2DStage 开启 auto 时调用） */
export function requestAutoPick(): void {
  autoPickListeners.forEach((fn) => fn())
}

/** 解析实际加载的模型名：本地 auto→优先用最近 AI 选角（无则随机）；本地指定→本地；否则站点默认/内置默认 */
export function resolveLive2dModel(settingsModel?: string): string {
  const stored = loadLive2dModel()
  if (stored === LIVE2D_MODEL_AUTO) {
    const pick = getAutoPick()
    if (pick) return pick.model
    return randomLive2dModel()
  }
  if (stored) return stored
  return (settingsModel || '').trim() || DEFAULT_LIVE2D_MODEL
}

export interface Live2dPickerCache {
  ts: number
  models: string[]
  characters: { id: string; name: string }[]
}

export function loadPickerCache(): Live2dPickerCache | null {
  const raw = lsGet(LIVE2D_PICKER_CACHE_KEY)
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as Live2dPickerCache
    if (!c || typeof c.ts !== 'number' || Date.now() - c.ts > PICKER_CACHE_TTL) return null
    return c
  } catch {
    return null
  }
}

export function savePickerCache(c: Live2dPickerCache): void {
  lsSet(LIVE2D_PICKER_CACHE_KEY, JSON.stringify(c))
}

// ---- 站点设置解析 ----

export function resolveLive2dConfig(settings: SiteSettings): {
  enabled: boolean
  model: string
} {
  return {
    enabled: settings.live2d_enable !== '0',
    model: (settings.live2d_model || '').trim() || DEFAULT_LIVE2D_MODEL
  }
}

// ---- bestdori API（经反代）----

export async function fetchAssetsIndex(): Promise<unknown> {
  const res = await fetch(`lumia-live2d://api/explorer/jp/assets/_info.json?_=${Date.now()}`)
  if (!res.ok) throw new Error(`assets index HTTP ${res.status}`)
  return res.json()
}

export async function fetchCharacters(): Promise<unknown> {
  const res = await fetch(`lumia-live2d://api/characters/all.2.json?_=${Date.now()}`)
  if (!res.ok) throw new Error(`characters HTTP ${res.status}`)
  return res.json()
}

// ---- AI 动作指令（AI 直接控制 Live2D 参数级动作，绕过客户端情感推断）----
// AI 回复中可附加：
//   [PARAM:ParamEyeLOpen:0.8]   参数名:目标值（-1~1，越界自动 clamp）
//   [MOTION:smile01]             播放模型自带动作（存在才播）
//   [EXPRESSION:niyaniya01]      切换表情预设（模型有才切换）
// 支持中文别名：[参数:…] / [动作:…] / [表情预设:…]，方/中文括号均可。

export interface Live2dParamCmd {
  id: string
  value: number
}
export interface Live2dActionCommands {
  params: Live2dParamCmd[]
  motion?: string
  expression?: string
  /** 头部视线方向（[LOOK:left] 等，驱动 ParamAngleX/Y 短时） */
  look?: LookDirection
}

/** 视线方向 */
export type LookDirection = 'left' | 'right' | 'up' | 'down' | 'center'

/** 视线方向 → ParamAngleX/Y 目标角度（左/右摇头、上/下点头） */
export const LOOK_TARGETS: Record<LookDirection, { x: number; y: number }> = {
  left: { x: -30, y: 0 },
  right: { x: 30, y: 0 },
  up: { x: 0, y: -18 },
  down: { x: 0, y: 18 },
  center: { x: 0, y: 0 }
}

const ACTION_TAG_NAMES = '(?:PARAM|参数|MOTION|动作|EXPRESSION|表情预设|LOOK|看|视线)'

/** 单条指令正则（[PARAM:ParamEyeLOpen:0.8] 等；值可带小数/负号/空格） */
const ACTION_CMD_RE = new RegExp(
  `[\\[【]\\s*(${ACTION_TAG_NAMES})\\s*[:：]\\s*([^\\]】\\n]{1,40}?)\\s*[\\]】]`,
  'gi'
)

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 从 AI 回复解析全部动作指令（参数按出现顺序去重保留最后一个；动作/表情取最后一个） */
export function parseActionCommands(text: string): Live2dActionCommands {
  const params = new Map<string, number>()
  let motion: string | undefined
  let expression: string | undefined
  let look: LookDirection | undefined
  const t = text || ''
  ACTION_CMD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ACTION_CMD_RE.exec(t)) !== null) {
    const kind = m[1].toUpperCase()
    const body = m[2].trim()
    if (kind === 'PARAM' || kind === '参数') {
      // body 形如 "ParamEyeLOpen:0.8"（冒号分隔 id 与值）
      const sep = body.search(/[:：]/)
      if (sep <= 0) continue
      const id = body.slice(0, sep).trim()
      const raw = parseFloat(body.slice(sep + 1).replace(/[^\d.\-]/g, ''))
      if (!id || !Number.isFinite(raw)) continue
      params.set(id, clamp(raw, -1, 1))
    } else if (kind === 'MOTION' || kind === '动作') {
      if (body) motion = body
    } else if (kind === 'EXPRESSION' || kind === '表情预设') {
      if (body) expression = body
    } else if (kind === 'LOOK' || kind === '看' || kind === '视线') {
      const dir = body.toLowerCase().replace(/[\s，,。、]/g, '')
      // 中文方向词归一化（左/右/上/下/中间 → left/right/up/down/center）
      const zhMap: Record<string, LookDirection> = {
        左: 'left',
        左边: 'left',
        右: 'right',
        右边: 'right',
        上: 'up',
        上面: 'up',
        下: 'down',
        下面: 'down',
        中: 'center',
        中间: 'center',
        中央: 'center',
        正: 'center',
        正中: 'center'
      }
      const normalized = zhMap[dir] || dir
      if (normalized in LOOK_TARGETS) look = normalized as LookDirection
    }
  }
  return {
    params: [...params.entries()].map(([id, value]) => ({ id, value })),
    motion,
    expression,
    look
  }
}

/** 剥离显示文本中的动作指令标记（消息展示用，不露出 [PARAM:…] 原始标记） */
export function stripActionCommands(text: string): string {
  return (text || '')
    .replace(
      /[\[【]\s*(?:PARAM|参数|MOTION|动作|EXPRESSION|表情预设|LOOK|看|视线)\s*[:：]\s*[^\]】\n]{1,60}?[\]】]/gi,
      ''
    )
    .trim()
}
