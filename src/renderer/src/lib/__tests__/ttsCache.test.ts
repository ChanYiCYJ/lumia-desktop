import { describe, it, expect, vi } from "vitest";
import {
  cleanTtsText,
  djb2Hash,
  ttsCacheKey,
  getTtsCacheKey,
  createMemoryStorage,
  createIndexedDbStorage,
  getTtsAudio,
  getTtsMemBuffer,
  setTtsMemBuffer,
  clearTtsCache,
  TTS_CACHE_MAX,
} from "../ttsCache";

function fakeResponse(buf: ArrayBuffer, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

describe("ttsCache · cleanTtsText（朗读文本清洗）", () => {
  it("去掉 [表情:]/[PARAM:] 等指令标签", () => {
    expect(cleanTtsText("哈哈[表情:happy][PARAM:ParamMouthOpenY:0.8]")).toBe(
      "哈哈",
    );
  });

  it("去掉 Markdown 符号与多余空白", () => {
    expect(cleanTtsText("**你好**，`code` [链接](x)   世界")).toBe(
      "你好，code 链接x 世界",
    );
  });

  it("空文本/纯标签 → 空字符串", () => {
    expect(cleanTtsText("")).toBe("");
    expect(cleanTtsText("[表情:happy]")).toBe("");
    expect(cleanTtsText("   ")).toBe("");
  });

  it("限长（默认 600）", () => {
    const long = "字".repeat(700);
    expect(cleanTtsText(long)).toHaveLength(600);
    expect(cleanTtsText(long, 50)).toHaveLength(50);
  });
});

describe("ttsCache · djb2Hash + ttsCacheKey", () => {
  it("djb2Hash 确定性、区分内容", () => {
    expect(djb2Hash("你好")).toBe(djb2Hash("你好"));
    expect(djb2Hash("你好")).not.toBe(djb2Hash("你好吗"));
    expect(djb2Hash("")).toBe(djb2Hash(""));
  });

  it("ttsCacheKey 稳定且区分音色/来源", () => {
    const a = ttsCacheKey("你好", "zh-CN-XiaoxiaoNeural", "backend");
    expect(a).toBe(ttsCacheKey("你好", "zh-CN-XiaoxiaoNeural", "backend"));
    expect(a).not.toBe(ttsCacheKey("你好", "zh-CN-YunxiNeural", "backend"));
    expect(a).not.toBe(
      ttsCacheKey("你好", "zh-CN-XiaoxiaoNeural", "thirdparty"),
    );
  });
});

describe("ttsCache · createMemoryStorage（LRU）", () => {
  it("get 未命中 → null；set 后可 get", async () => {
    const s = createMemoryStorage(3);
    expect(await s.get("k1")).toBeNull();
    await s.set("k1", new ArrayBuffer(4));
    expect((await s.get("k1"))?.byteLength).toBe(4);
  });

  it("超过上限淘汰最旧（LRU）", async () => {
    const s = createMemoryStorage(2);
    await s.set("a", new ArrayBuffer(1));
    await s.set("b", new ArrayBuffer(1));
    await s.set("c", new ArrayBuffer(1)); // 淘汰 a
    expect(await s.get("a")).toBeNull();
    expect(await s.get("b")).not.toBeNull();
    expect(await s.get("c")).not.toBeNull();
    // 访问 b 后 b 变最新，再插入 d 淘汰 c
    await s.get("b");
    await s.set("d", new ArrayBuffer(1));
    expect(await s.get("c")).toBeNull();
    expect(await s.get("b")).not.toBeNull();
  });
});

describe("ttsCache · getTtsAudio（缓存命中/合成/降级）", () => {
  it("命中缓存 → 不发起网络请求，cached=true", async () => {
    const storage = createMemoryStorage();
    await storage.set(
      getTtsCacheKey("你好", "v1", "backend")!,
      new ArrayBuffer(8),
    );
    const fetchImpl = vi.fn(async () => fakeResponse(new ArrayBuffer(0)));
    const r = await getTtsAudio({
      text: "你好",
      voice: "v1",
      source: "backend",
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r?.cached).toBe(true);
    expect(r?.arrayBuffer.byteLength).toBe(8);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("未命中 → fetch 合成 + 写缓存，cached=false", async () => {
    const storage = createMemoryStorage();
    const buf = new ArrayBuffer(16);
    const fetchImpl = vi.fn(async () => fakeResponse(buf));
    const r = await getTtsAudio({
      text: "你好世界",
      voice: "v1",
      source: "backend",
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r?.cached).toBe(false);
    expect(r?.arrayBuffer.byteLength).toBe(16);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 已写入缓存
    expect(
      await storage.get(getTtsCacheKey("你好世界", "v1", "backend")!),
    ).not.toBeNull();
  });

  it("空文本 → null（不请求）", async () => {
    const fetchImpl = vi.fn();
    const r = await getTtsAudio({
      text: "   ",
      voice: "v1",
      source: "backend",
      storage: createMemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetch 失败（非 ok / 抛错）→ null，且不污染缓存", async () => {
    const storage = createMemoryStorage();
    const r1 = await getTtsAudio({
      text: "失败文本",
      voice: "v1",
      source: "backend",
      storage,
      fetchImpl: (async () =>
        fakeResponse(new ArrayBuffer(0), false)) as unknown as typeof fetch,
    });
    expect(r1).toBeNull();
    const r2 = await getTtsAudio({
      text: "失败文本2",
      voice: "v1",
      source: "backend",
      storage,
      fetchImpl: (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    });
    expect(r2).toBeNull();
  });

  it("storage 读取失败 → 仍可 fetch 降级", async () => {
    const badStorage = {
      get: async () => {
        throw new Error("idb fail");
      },
      set: async () => {},
      clear: async () => {},
    };
    const buf = new ArrayBuffer(4);
    const r = await getTtsAudio({
      text: "降级文本",
      voice: "v1",
      source: "backend",
      storage: badStorage,
      fetchImpl: (async () => fakeResponse(buf)) as unknown as typeof fetch,
    });
    expect(r?.cached).toBe(false);
    expect(r?.arrayBuffer.byteLength).toBe(4);
  });

  it("并发同一文本 → 只发起一次请求（in-flight 去重）", async () => {
    const storage = createMemoryStorage();
    const buf = new ArrayBuffer(4);
    const fetchImpl = vi.fn(async () => fakeResponse(buf));
    const opts = {
      text: "并发文本",
      voice: "v1",
      source: "backend" as const,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    const [a, b] = await Promise.all([getTtsAudio(opts), getTtsAudio(opts)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a?.arrayBuffer.byteLength).toBe(4);
    expect(b?.arrayBuffer.byteLength).toBe(4);
  });

  it("内存缓存：set 后可同步命中", async () => {
    setTtsMemBuffer("memkey", new ArrayBuffer(8));
    expect(getTtsMemBuffer("memkey")?.byteLength).toBe(8);
    expect(getTtsMemBuffer("missing")).toBeNull();
  });
});

describe("ttsCache · 其他", () => {
  it("createIndexedDbStorage 在无 IndexedDB 环境不抛错（降级内存）", async () => {
    const s = createIndexedDbStorage();
    await s.set("k", new ArrayBuffer(2));
    const v = await s.get("k");
    expect(v?.byteLength).toBe(2);
  });

  it("clearTtsCache 清空不抛错", async () => {
    setTtsMemBuffer("x", new ArrayBuffer(1));
    await clearTtsCache();
    expect(getTtsMemBuffer("x")).toBeNull();
    expect(TTS_CACHE_MAX).toBeGreaterThan(0);
  });
});
