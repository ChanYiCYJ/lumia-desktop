import { describe, it, expect, beforeEach } from "vitest";
import {
  loadChatFontSize,
  saveChatFontSize,
  loadWebSearchOn,
  saveWebSearchOn,
  loadNetMode,
  saveNetMode,
  loadSearchSpeed,
  saveSearchSpeed,
  loadSearchDepth,
  saveSearchDepth,
  loadTtsPref,
  saveTtsPref,
  loadMemory,
  saveMemory,
  clearMemory,
  loadAutoKnowledge,
  saveAutoKnowledge,
  loadPersonaKnowledge,
  savePersonaKnowledge,
  clearPersonaKnowledge,
  hasLocalApi,
  mergeEffCfg,
  loadCustomModelOn,
  saveCustomModelOn,
  loadTtsAudioUrl,
  saveTtsAudioUrl,
  buildTtsAudioUrl,
  loadTtsOn,
  saveTtsOn,
  loadTtsVolume,
  saveTtsVolume,
  ttsVolumeValue,
  loadTtsVoice,
  saveTtsVoice,
  applyTtsVoice,
  DEFAULT_TTS_VOICE,
  loadTtsSource,
  saveTtsSource,
  resolveTtsAudioUrl,
  BACKEND_TTS_TEMPLATE,
} from "../chatSettings";
import type { AIChatConfig } from "../types";
import type { LocalAIConfig } from "../localCfg";

beforeEach(() => {
  localStorage.clear();
});

const baseConfig: AIChatConfig = {
  endpoint: "https://api.example.com/v1",
  apiKey: "site-key",
  model: "gpt-4o",
  botName: "Test Bot",
  systemPrompt: "默认人设",
};

describe("chatSettings · 对话字体", () => {
  it("默认返回 base", () => {
    expect(loadChatFontSize()).toBe("base");
  });
  it("非法值回退 base", () => {
    localStorage.setItem("kimo_ai_fontsize", "xl");
    expect(loadChatFontSize()).toBe("base");
  });
  it("保存后可读取", () => {
    saveChatFontSize("lg");
    expect(loadChatFontSize()).toBe("lg");
  });
});

describe("chatSettings · 网络搜索", () => {
  it("默认关闭（非 search 模式）", () => {
    expect(loadWebSearchOn()).toBe(false);
  });
  it("开启后持久化", () => {
    saveWebSearchOn(true);
    expect(loadWebSearchOn()).toBe(true);
    expect(localStorage.getItem("kimo_ai_websearch")).toBe("1");
  });
  it("关闭后持久化", () => {
    saveWebSearchOn(true);
    saveWebSearchOn(false);
    expect(loadWebSearchOn()).toBe(false);
  });
});

describe("chatSettings · 网络模式（Auto/search，原 view 已整合进 search）", () => {
  it("默认 Auto（先答，缺数据自动升级）", () => {
    expect(loadNetMode()).toBe("auto");
  });
  it("保存后可读取", () => {
    saveNetMode("search");
    expect(loadNetMode()).toBe("search");
    saveNetMode("auto");
    expect(loadNetMode()).toBe("auto");
  });
  it("旧值 fast 迁移为 auto", () => {
    localStorage.setItem("kimo_ai_net_mode", "fast");
    expect(loadNetMode()).toBe("auto");
  });
  it("旧值 view 迁移为 search（view 已整合进 search）", () => {
    localStorage.setItem("kimo_ai_net_mode", "view");
    expect(loadNetMode()).toBe("search");
  });
  it("非法值回退 Auto", () => {
    localStorage.setItem("kimo_ai_net_mode", "xxx");
    expect(loadNetMode()).toBe("auto");
  });
  it("旧 key 迁移：浏览 Agent 开启 → search", () => {
    localStorage.setItem("kimo_ai_browse_agent", "1");
    expect(loadNetMode()).toBe("search");
  });
  it("旧 key 迁移：网络搜索显式开启 → search", () => {
    localStorage.setItem("kimo_ai_websearch", "1");
    expect(loadNetMode()).toBe("search");
  });
  it("旧 key 迁移：网络搜索显式关闭 → auto", () => {
    localStorage.setItem("kimo_ai_websearch", "0");
    expect(loadNetMode()).toBe("auto");
  });
  it("新模式优先于旧 key", () => {
    localStorage.setItem("kimo_ai_net_mode", "search");
    localStorage.setItem("kimo_ai_browse_agent", "1");
    expect(loadNetMode()).toBe("search");
  });
});

describe("chatSettings · 搜索速度（Fast/标准）", () => {
  it("默认标准 standard", () => {
    expect(loadSearchSpeed()).toBe("standard");
  });
  it("保存后可读取", () => {
    saveSearchSpeed("fast");
    expect(loadSearchSpeed()).toBe("fast");
    saveSearchSpeed("standard");
    expect(loadSearchSpeed()).toBe("standard");
  });
  it("非法值回退标准", () => {
    localStorage.setItem("kimo_ai_search_speed", "ultra");
    expect(loadSearchSpeed()).toBe("standard");
  });
});

describe("chatSettings · 搜索深度（Auto/深度）", () => {
  it("默认自动 auto", () => {
    expect(loadSearchDepth()).toBe("auto");
  });
  it("保存后可读取", () => {
    saveSearchDepth("deep");
    expect(loadSearchDepth()).toBe("deep");
    saveSearchDepth("auto");
    expect(loadSearchDepth()).toBe("auto");
  });
  it("非法值回退 auto", () => {
    localStorage.setItem("kimo_ai_search_depth", "shallow");
    expect(loadSearchDepth()).toBe("auto");
  });
});

describe("chatSettings · 自动朗读", () => {
  it("未设置时跟随 config.autoTTS", () => {
    expect(loadTtsPref(false)).toEqual({ set: false, on: false });
    expect(loadTtsPref(true)).toEqual({ set: false, on: true });
  });
  it("用户显式设置后优先于 config.autoTTS", () => {
    saveTtsPref(false);
    expect(loadTtsPref(true)).toEqual({ set: true, on: false });
    saveTtsPref(true);
    expect(loadTtsPref(false)).toEqual({ set: true, on: true });
  });
});

describe("chatSettings · 本机记忆（按 pageId 隔离）", () => {
  it("默认空串", () => {
    expect(loadMemory(1)).toBe("");
  });
  it("保存/读取", () => {
    saveMemory(2, "用户偏好：喜欢简洁回答");
    expect(loadMemory(2)).toBe("用户偏好：喜欢简洁回答");
    // 不影响其他 pageId
    expect(loadMemory(1)).toBe("");
  });
  it("清除", () => {
    saveMemory(2, "x");
    clearMemory(2);
    expect(loadMemory(2)).toBe("");
  });
});

describe("chatSettings · auto-knowledge / 人格笔记", () => {
  it("auto-knowledge 默认开启", () => {
    expect(loadAutoKnowledge()).toBe(true);
  });
  it("开启/关闭持久化", () => {
    saveAutoKnowledge(false);
    expect(loadAutoKnowledge()).toBe(false);
    expect(localStorage.getItem("kimo_ai_autoknow")).toBe("0");
    saveAutoKnowledge(true);
    expect(loadAutoKnowledge()).toBe(true);
  });
  it("人格笔记按 pageId 隔离存取", () => {
    expect(loadPersonaKnowledge(1)).toBe("");
    savePersonaKnowledge(1, "- 笔记A");
    expect(loadPersonaKnowledge(1)).toBe("- 笔记A");
    expect(loadPersonaKnowledge(2)).toBe("");
  });
  it("清除人格笔记", () => {
    savePersonaKnowledge(1, "- x");
    clearPersonaKnowledge(1);
    expect(loadPersonaKnowledge(1)).toBe("");
  });
});

describe("chatSettings · 自定义模型开关", () => {
  it("默认关闭（未设置）", () => {
    expect(loadCustomModelOn()).toBe(false);
  });
  it("开启/关闭持久化", () => {
    saveCustomModelOn(true);
    expect(loadCustomModelOn()).toBe(true);
    expect(localStorage.getItem("kimo_ai_custom_model")).toBe("1");
    saveCustomModelOn(false);
    expect(loadCustomModelOn()).toBe(false);
  });
});

describe("chatSettings · hasLocalApi", () => {
  it("全空为 false", () => {
    expect(hasLocalApi({ endpoint: "", apiKey: "", model: "" })).toBe(false);
  });
  it("任一字段非空为 true", () => {
    expect(hasLocalApi({ endpoint: "https://x", apiKey: "", model: "" })).toBe(
      true,
    );
  });
});

describe("chatSettings · mergeEffCfg", () => {
  it("无本地配置时使用机器人默认", () => {
    const local: LocalAIConfig = { endpoint: "", apiKey: "", model: "" };
    const eff = mergeEffCfg(baseConfig, local);
    expect(eff.endpoint).toBe(baseConfig.endpoint);
    expect(eff.apiKey).toBe(baseConfig.apiKey);
    expect(eff.model).toBe(baseConfig.model);
    expect(eff.systemPrompt).toBe("默认人设");
  });
  it("本地配置覆盖 endpoint/apiKey/model", () => {
    const local: LocalAIConfig = {
      endpoint: "https://local.example.com",
      apiKey: "local-key",
      model: "deepseek",
    };
    const eff = mergeEffCfg(baseConfig, local);
    expect(eff.endpoint).toBe("https://local.example.com");
    expect(eff.apiKey).toBe("local-key");
    expect(eff.model).toBe("deepseek");
  });
  it("本地 prompt 覆盖 systemPrompt", () => {
    const local: LocalAIConfig = {
      endpoint: "",
      apiKey: "",
      model: "",
      prompt: "本机人设",
    };
    expect(mergeEffCfg(baseConfig, local).systemPrompt).toBe("本机人设");
  });
  it("未选人设时 systemPrompt 为默认", () => {
    const local: LocalAIConfig = { endpoint: "", apiKey: "", model: "" };
    const cfg: AIChatConfig = {
      ...baseConfig,
      prompts: [
        { name: "A", systemPrompt: "人设A" },
        { name: "B", systemPrompt: "人设B" },
      ],
    };
    expect(mergeEffCfg(cfg, local, null).systemPrompt).toBe("默认人设");
  });
  it("选中人设时 systemPrompt 被覆盖（本地 prompt 仍优先）", () => {
    const local: LocalAIConfig = { endpoint: "", apiKey: "", model: "" };
    const cfg: AIChatConfig = {
      ...baseConfig,
      prompts: [
        { name: "A", systemPrompt: "人设A" },
        { name: "B", systemPrompt: "人设B" },
      ],
    };
    expect(mergeEffCfg(cfg, local, 1).systemPrompt).toBe("人设B");
    const local2: LocalAIConfig = {
      endpoint: "",
      apiKey: "",
      model: "",
      prompt: "本机人设",
    };
    expect(mergeEffCfg(cfg, local2, 1).systemPrompt).toBe("本机人设");
  });
  it("越界人设索引安全回退默认", () => {
    const local: LocalAIConfig = { endpoint: "", apiKey: "", model: "" };
    const cfg: AIChatConfig = {
      ...baseConfig,
      prompts: [{ name: "A", systemPrompt: "人设A" }],
    };
    expect(mergeEffCfg(cfg, local, 5).systemPrompt).toBe("默认人设");
  });
});

describe("chatSettings · 音频 TTS 地址（真实音频口型）", () => {
  it("load/save 读写（trim）", () => {
    expect(loadTtsAudioUrl()).toBe("");
    saveTtsAudioUrl("  https://tts.example.com/tts?text={text}  ");
    expect(loadTtsAudioUrl()).toBe("https://tts.example.com/tts?text={text}");
    saveTtsAudioUrl("");
    expect(loadTtsAudioUrl()).toBe("");
  });

  it("buildTtsAudioUrl：{text} 占位符替换（URL 编码）", () => {
    const u = buildTtsAudioUrl(
      "https://x.com/tts?voice=zh&text={text}",
      "你好，世界",
    );
    expect(u).toBe(
      "https://x.com/tts?voice=zh&text=" + encodeURIComponent("你好，世界"),
    );
  });

  it("buildTtsAudioUrl：无占位符拼 ?text=", () => {
    const u = buildTtsAudioUrl("https://x.com/tts", "hi");
    expect(u).toBe("https://x.com/tts?text=hi");
    // 已有 query 用 & 拼接
    const u2 = buildTtsAudioUrl("https://x.com/tts?a=1", "hi");
    expect(u2).toBe("https://x.com/tts?a=1&text=hi");
  });

  it("buildTtsAudioUrl：空模板/空文本返回 null", () => {
    expect(buildTtsAudioUrl("", "hi")).toBeNull();
    expect(buildTtsAudioUrl("https://x.com/tts", "  ")).toBeNull();
    expect(buildTtsAudioUrl("  ", "  ")).toBeNull();
  });
});

describe("chatSettings · TTS 来源（内置后端 / 第三方地址）", () => {
  it("默认内置后端；读取/保存", () => {
    expect(loadTtsSource()).toBe("backend");
    saveTtsSource("thirdparty");
    expect(loadTtsSource()).toBe("thirdparty");
    saveTtsSource("backend");
    expect(loadTtsSource()).toBe("backend");
    // 非法值回退默认
    localStorage.setItem("kimo_ai_tts_source", "weird");
    expect(loadTtsSource()).toBe("backend");
  });

  it("BACKEND_TTS_TEMPLATE 指向本站后端", () => {
    expect(BACKEND_TTS_TEMPLATE).toBe("/api/v1/tts?text={text}");
  });

  it("resolveTtsAudioUrl：内置后端走模板 + 追加音色", () => {
    const u = resolveTtsAudioUrl(
      "backend",
      "https://third-party.example/tts",
      "zh-CN-XiaoxiaoNeural",
      "你好，世界",
    );
    expect(u).toBe(
      "/api/v1/tts?text=" +
        encodeURIComponent("你好，世界") +
        "&voice=zh-CN-XiaoxiaoNeural",
    );
  });

  it("resolveTtsAudioUrl：第三方地址走用户 URL + 追加音色", () => {
    const u = resolveTtsAudioUrl(
      "thirdparty",
      "https://x.com/tts?text={text}",
      "zh-CN-YunxiNeural",
      "hi",
    );
    expect(u).toBe("https://x.com/tts?text=hi&voice=zh-CN-YunxiNeural");
  });

  it("resolveTtsAudioUrl：第三方无地址时返回 null", () => {
    expect(
      resolveTtsAudioUrl("thirdparty", "", "zh-CN-XiaoxiaoNeural", "hi"),
    ).toBeNull();
    expect(
      resolveTtsAudioUrl("thirdparty", "   ", "zh-CN-XiaoxiaoNeural", ""),
    ).toBeNull();
  });
});

describe("chatSettings · TTS 总开关 + 音量", () => {
  it("TTS 总开关默认关闭；开启/关闭可持久化", () => {
    expect(loadTtsOn()).toBe(false);
    saveTtsOn(true);
    expect(loadTtsOn()).toBe(true);
    saveTtsOn(false);
    expect(loadTtsOn()).toBe(false);
  });

  it("音量默认中；非法值回退中", () => {
    expect(loadTtsVolume()).toBe("medium");
    saveTtsVolume("high");
    expect(loadTtsVolume()).toBe("high");
    saveTtsVolume("low");
    expect(loadTtsVolume()).toBe("low");
  });

  it("ttsVolumeValue 档位映射到 0~1 数值", () => {
    expect(ttsVolumeValue("low")).toBe(0.5);
    expect(ttsVolumeValue("medium")).toBe(0.8);
    expect(ttsVolumeValue("high")).toBe(1);
  });
});

describe("chatSettings · TTS 音色（voice 参数）", () => {
  it("音色默认晓晓；读取/保存", () => {
    expect(loadTtsVoice()).toBe(DEFAULT_TTS_VOICE);
    expect(DEFAULT_TTS_VOICE).toBe("zh-CN-XiaoxiaoNeural");
    saveTtsVoice("zh-CN-YunxiNeural");
    expect(loadTtsVoice()).toBe("zh-CN-YunxiNeural");
    // 非法值回退默认
    localStorage.setItem("kimo_ai_tts_voice", "invalid-voice");
    expect(loadTtsVoice()).toBe(DEFAULT_TTS_VOICE);
  });

  it("applyTtsVoice：无 voice 时追加", () => {
    const u = applyTtsVoice(
      "https://x.com/tts?text=hi",
      "zh-CN-XiaoxiaoNeural",
    );
    expect(u).toBe("https://x.com/tts?text=hi&voice=zh-CN-XiaoxiaoNeural");
  });

  it("applyTtsVoice：已有 voice 时替换（选择器为权威）", () => {
    const u = applyTtsVoice(
      "https://x.com/tts?text=hi&voice=zh-CN-YunxiNeural",
      "zh-CN-XiaoyiNeural",
    );
    expect(u).toBe("https://x.com/tts?text=hi&voice=zh-CN-XiaoyiNeural");
  });

  it("applyTtsVoice：无 query 时用 ?voice=", () => {
    const u = applyTtsVoice("https://x.com/tts", "zh-CN-YunxiNeural");
    expect(u).toBe("https://x.com/tts?voice=zh-CN-YunxiNeural");
  });
});
