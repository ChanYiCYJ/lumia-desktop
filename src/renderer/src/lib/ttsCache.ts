// ===== TTS 音频缓存层（速度优化）=====
// 目标：同一文本重复朗读秒播（命中缓存跳过 edge-tts 网络合成），并支持「预合成」。
// - 文本 → 稳定 key（djb2 hash，不存明文文本）
// - 内存 Map（会话级 ArrayBuffer/Blob）+ IndexedDB 持久化（跨会话），LRU 上限
// - 可注入 storage / fetch（纯函数可单测）
//
// 设计对齐开源思路：@liyao1520/live2d-motionSync 的 `play(AudioBuffer)`——先解码为
// AudioBuffer 再播放 → 口型第一帧即可同步（见 docs/tts-lipsync-research.md）。

import { stripEmotionTag } from "./live2d";
import { stripToolCmds } from "./toolCmds";
import { resolveTtsAudioUrl, type TtsSource } from "./chatSettings";

/** 默认缓存上限（条数） */
export const TTS_CACHE_MAX = 50;
/** 默认单条容量上限（约 10MB，edge-tts 中文本远小于此） */
export const TTS_CACHE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 清洗朗读文本（与 playTTS 一致）：
 * 去 [表情:]/[工具指令] 标签 + Markdown 符号 + 多余空白，限长。
 * 避免把"表情冒号 happy"这类指令词或前导空格读出来。
 */
export function cleanTtsText(text: string, maxLen = 600): string {
  return stripToolCmds(stripEmotionTag(text))
    .replace(/[*_`#~>\[\]\(\)]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** djb2 字符串哈希（32bit，同步、可单测）；TTS key 用，避免把朗读文本明文当 IndexedDB key */
export function djb2Hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * 构造 TTS 缓存 key（纯函数，可单测）：
 * `source:voice:hash(cleanText)`
 */
export function ttsCacheKey(
  cleanText: string,
  voice: string,
  source: string,
): string {
  return `${source || "tts"}:${voice || "default"}:${djb2Hash(cleanText)}`;
}

/**
 * 由朗读文本 + 配置计算缓存 key（getTtsAudio 与调用方共用，保证一致）：
 * `source:voice:hash(cleanText)`（第三维用最终 URL 区分来源/第三方模板）
 */
export function getTtsCacheKey(
  text: string,
  voice: string,
  source: string,
  thirdPartyUrl?: string,
  maxLen = 600,
): string | null {
  const clean = cleanTtsText(text, maxLen);
  if (!clean) return null;
  const src: TtsSource = source === "thirdparty" ? "thirdparty" : "backend";
  const url = resolveTtsAudioUrl(src, thirdPartyUrl || "", voice, clean);
  if (!url) return null;
  return ttsCacheKey(clean, voice, url);
}

// ---- 存储抽象（可注入内存实现便于单测）----
export interface TtsCacheStorage {
  get(key: string): Promise<ArrayBuffer | null>;
  set(key: string, buf: ArrayBuffer): Promise<void>;
  clear(): Promise<void>;
}

/** 内存存储（测试 / IndexedDB 不可用时的兜底，同时做会话级 LRU） */
export function createMemoryStorage(
  max = TTS_CACHE_MAX,
): TtsCacheStorage & { _size: () => number } {
  const map = new Map<string, ArrayBuffer>();
  return {
    async get(key: string) {
      const v = map.get(key);
      if (v === undefined) return null;
      // LRU：命中移到末尾
      map.delete(key);
      map.set(key, v);
      return v;
    },
    async set(key: string, buf: ArrayBuffer) {
      map.delete(key);
      map.set(key, buf);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    async clear() {
      map.clear();
    },
    _size() {
      return map.size;
    },
  };
}

const DB_NAME = "kimo-tts-cache";
const DB_STORE = "audio";
let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 打开 IndexedDB（不可用时返回 null → 调用方降级到内存/直连） */
function openTtsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** IndexedDB 持久化存储（跨会话缓存音频 ArrayBuffer） */
export function createIndexedDbStorage(): TtsCacheStorage {
  let mem: TtsCacheStorage | null = null;
  const memStorage = () => (mem ||= createMemoryStorage());
  const db = () => openTtsDb();
  return {
    async get(key: string) {
      const d = await db();
      if (!d) return memStorage().get(key);
      return new Promise<ArrayBuffer | null>((resolve) => {
        try {
          const tx = d.transaction(DB_STORE, "readonly");
          const req = tx.objectStore(DB_STORE).get(key);
          req.onsuccess = () => {
            const v = req.result as ArrayBuffer | undefined;
            resolve(v instanceof ArrayBuffer ? v : null);
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },
    async set(key: string, buf: ArrayBuffer) {
      if (buf.byteLength > TTS_CACHE_MAX_BYTES) return; // 超限不持久化
      const d = await db();
      if (!d) {
        await memStorage().set(key, buf);
        return;
      }
      return new Promise<void>((resolve) => {
        try {
          const tx = d.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).put(buf, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
    async clear() {
      const d = await db();
      if (!d) return;
      return new Promise<void>((resolve) => {
        try {
          const tx = d.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

let defaultStorage: TtsCacheStorage | null = null;
/** 默认存储：IndexedDB 持久化（不可用时降级内存） */
export function getDefaultTtsStorage(): TtsCacheStorage {
  return (defaultStorage ||= createIndexedDbStorage());
}

/** 会话级内存 blob/ArrayBuffer 快速缓存（同步读取，避免每次点朗读都走 IndexedDB 异步） */
const memBuffer = new Map<string, ArrayBuffer>();
export function getTtsMemBuffer(key: string): ArrayBuffer | null {
  return memBuffer.get(key) || null;
}
export function setTtsMemBuffer(key: string, buf: ArrayBuffer): void {
  memBuffer.delete(key);
  memBuffer.set(key, buf);
  while (memBuffer.size > TTS_CACHE_MAX) {
    const oldest = memBuffer.keys().next().value;
    if (oldest === undefined) break;
    memBuffer.delete(oldest);
  }
}

// in-flight 去重：同一 URL 并发请求只发一次（预合成 + 朗读同时触发时）
const inflight = new Map<string, Promise<ArrayBuffer | null>>();

export interface GetTtsAudioOpts {
  /** 原始朗读文本（内部会清洗） */
  text: string;
  voice: string;
  source: string;
  /** 第三方 URL 模板（backend 时忽略） */
  thirdPartyUrl?: string;
  /** 缓存存储（默认 IndexedDB） */
  storage?: TtsCacheStorage;
  /** fetch 实现（默认全局 fetch，可注入） */
  fetchImpl?: typeof fetch;
  /** 朗读文本限长 */
  maxLen?: number;
}

export interface TtsAudioResult {
  arrayBuffer: ArrayBuffer;
  /** 是否命中缓存（true = 未发网络请求） */
  cached: boolean;
}

/**
 * 获取 TTS 音频：命中缓存 → 秒返；未命中 → fetch → 写缓存。
 * 失败返回 null（调用方回退 <audio> 直连或提示）。
 */
export async function getTtsAudio(
  opts: GetTtsAudioOpts,
): Promise<TtsAudioResult | null> {
  const clean = cleanTtsText(opts.text, opts.maxLen);
  if (!clean) return null;
  const src: TtsSource =
    opts.source === "thirdparty" ? "thirdparty" : "backend";
  const url = resolveTtsAudioUrl(
    src,
    opts.thirdPartyUrl || "",
    opts.voice,
    clean,
  );
  if (!url) return null;
  const key = ttsCacheKey(clean, opts.voice, url);
  const storage = opts.storage || getDefaultTtsStorage();
  const fetchImpl = opts.fetchImpl || fetch;

  // 1) 内存缓存（同步快）
  const mem = getTtsMemBuffer(key);
  if (mem) return { arrayBuffer: mem, cached: true };

  // 2) 持久化缓存（IndexedDB）
  try {
    const hit = await storage.get(key);
    if (hit && hit.byteLength > 0) {
      setTtsMemBuffer(key, hit);
      return { arrayBuffer: hit, cached: true };
    }
  } catch {}

  // 3) 网络合成（in-flight 去重）
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) return null;
        try {
          await storage.set(key, buf);
        } catch {}
        setTtsMemBuffer(key, buf);
        return buf;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  const buf = await p;
  if (!buf) return null;
  return { arrayBuffer: buf, cached: false };
}

/** 清空全部 TTS 缓存（供「数据管理」/设置页清除使用） */
export async function clearTtsCache(): Promise<void> {
  memBuffer.clear();
  inflight.clear();
  try {
    await getDefaultTtsStorage().clear();
  } catch {}
}
