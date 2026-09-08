import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  assetUrl,
  buildDataUrl,
  buildLive2dSettings,
  characterNameOf,
  detectEmotion,
  detectReplyEmotion,
  groupModels,
  loadLive2dModel,
  modelInfo,
  parseActionCommands,
  parseCharacters,
  parseEmotionTag,
  parseModelNames,
  resolveLive2dConfig,
  saveLive2dModel,
  stripActionCommands,
  stripEmotionTag,
  DEFAULT_LIVE2D_MODEL,
  EMOTION_MOTIONS,
  EMOTIONS,
  LIVE2D_CHARACTERS,
  LIVE2D_MODEL_AUTO,
  addCustomModel,
  getAutoPick,
  absoluteLive2dProxyUrl,
  isThirdPartyModelInput,
  live2dProxyUrl,
  loadCustomModels,
  THIRD_PARTY_DEMO_MODEL,
  randomLive2dModel,
  removeCustomModel,
  resolveLive2dModel,
  saveAutoPick,
  type BuildData,
  type HitRegion,
  pickTapReaction,
  resolveHitRegion,
  TAP_REACTIONS,
  rmsToMouth,
  smoothMouth,
  analyzeFrequencyBands,
  bandEnergiesToMouthParams,
  adaptiveRmsGain,
  isModel3Url,
  buildLive2dSettingsFromModel3,
  fetchThirdPartyModelSafe,
  LOOK_TARGETS,
} from "../live2d";

beforeEach(() => {
  localStorage.clear();
});

const sampleBuildData: BuildData = {
  model: { bundleName: "live2d/chara/001_casual", fileName: "model.moc.bytes" },
  physics: { bundleName: "live2d/chara/001_casual", fileName: "physics.json" },
  textures: [
    { bundleName: "live2d/chara/001_casual", fileName: "texture_00.bytes" },
    { bundleName: "live2d/chara/001_casual", fileName: "texture_01" },
    { bundleName: "live2d/chara/001_casual", fileName: "texture_02.png" },
  ],
  motions: [
    { bundleName: "live2d/chara/001_casual", fileName: "motion/idle.mtn" },
    {
      bundleName: "live2d/chara/001_general",
      fileName: "motion/tap_body.mtn.bytes",
    },
  ],
  expressions: [
    { bundleName: "live2d/chara/001_casual", fileName: "exp01.exp.json" },
  ],
};

describe("live2d · 反代 URL 构造", () => {
  it("model 去掉 .bytes 后缀", () => {
    expect(
      assetUrl(
        { bundleName: "live2d/chara/001_casual", fileName: "model.moc.bytes" },
        "model",
      ),
    ).toBe("lumia-live2d://asset/jp/live2d/chara/001_casual_rip/model.moc");
  });

  it("motion 去掉 motion/ 前缀与 .bytes（bestdori 真实 asset 无子目录）", () => {
    expect(
      assetUrl(
        {
          bundleName: "live2d/chara/001_general",
          fileName: "motion/smile01.mtn.bytes",
        },
        "motion",
      ),
    ).toBe("lumia-live2d://asset/jp/live2d/chara/001_general_rip/smile01.mtn");
  });

  it("texture .bytes → .png、无扩展名补 .png、保留 .png", () => {
    const base = "live2d/chara/001_casual";
    expect(assetUrl({ bundleName: base, fileName: "t.bytes" }, "texture")).toBe(
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/t.png",
    );
    expect(assetUrl({ bundleName: base, fileName: "t2" }, "texture")).toBe(
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/t2.png",
    );
    expect(assetUrl({ bundleName: base, fileName: "t3.png" }, "texture")).toBe(
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/t3.png",
    );
  });

  it("expression 保留扩展名", () => {
    expect(
      assetUrl(
        { bundleName: "live2d/chara/001_casual", fileName: "exp.exp.json" },
        "expression",
      ),
    ).toBe("lumia-live2d://asset/jp/live2d/chara/001_casual_rip/exp.exp.json");
  });

  it("buildDataUrl 指向反代入口", () => {
    expect(buildDataUrl("001_casual")).toBe(
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/buildData.asset",
    );
  });
});

describe("live2d · buildLive2dSettings", () => {
  it("把 BuildData 转成同源绝对 URL settings", () => {
    const s = buildLive2dSettings("001_casual", sampleBuildData);
    expect(s.url).toBe(buildDataUrl("001_casual"));
    expect(s.model).toContain("model.moc");
    expect(s.physics).toContain("physics.json");
    expect(s.textures).toEqual([
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/texture_00.png",
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/texture_01.png",
      "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/texture_02.png",
    ]);
  });

  it("motions 以文件名（去扩展）为 key", () => {
    const s = buildLive2dSettings("001_casual", sampleBuildData);
    expect(Object.keys(s.motions)).toEqual(["idle", "tap_body"]);
    // bestdori 真实 asset 无 motion/ 子目录（修复：去掉前缀）
    expect(s.motions.idle?.[0]?.file).toContain("001_casual_rip/idle.mtn");
    expect(s.motions.tap_body?.[0]?.file).toContain(
      "001_general_rip/tap_body.mtn",
    );
  });

  it("expressions 以去掉 .exp.json 的名为 name", () => {
    const s = buildLive2dSettings("001_casual", sampleBuildData);
    expect(s.expressions[0]).toEqual({
      name: "exp01",
      file: "lumia-live2d://asset/jp/live2d/chara/001_casual_rip/exp01.exp.json",
    });
  });
});

describe("live2d · detectEmotion 本地规则", () => {
  it("开心", () => expect(detectEmotion("哈哈哈 太开心了")).toBe("happy"));
  it("难过", () => expect(detectEmotion("呜呜 好难过")).toBe("sad"));
  it("生气", () => expect(detectEmotion("气死我了 😡")).toBe("angry"));
  it("惊讶", () => expect(detectEmotion("真的吗？太震惊了")).toBe("surprised"));
  it("害羞", () => expect(detectEmotion("好害羞呀 脸红")).toBe("shy"));
  it("别扭/尴尬 → 害羞", () => {
    expect(detectEmotion("好别扭啊 不知道说什么")).toBe("shy");
    expect(detectEmotion("有点尴尬")).toBe("shy");
  });
  it("困倦", () => expect(detectEmotion("晚安 睡觉了")).toBe("sleepy"));
  it("眨眼", () => expect(detectEmotion("😉")).toBe("wink"));
  it("思考", () =>
    expect(detectEmotion("让我想想 大概是这样")).toBe("thinking"));
  it("普通内容 → neutral", () =>
    expect(detectEmotion("今天天气不错")).toBe("neutral"));
});

describe("live2d · detectReplyEmotion（AI 角色回复情绪，括号表演提示优先）", () => {
  it("括号动作描写优先：吓了一跳 → 惊讶", () => {
    expect(detectReplyEmotion("（突然被吓了一跳，眨眨眼）真的吗？")).toBe(
      "surprised",
    );
  });
  it("括号表演提示优先：声音放软 → 难过（正文开心不误判）", () => {
    expect(
      detectReplyEmotion("（停了停，声音放软了些）不用勉强自己开心起来"),
    ).toBe("sad");
  });
  it("括号：别过脸去 → 害羞", () => {
    expect(
      detectReplyEmotion("（说完别过脸去，声音小了一点）……开玩笑的啦"),
    ).toBe("shy");
  });
  it("无括号时回退整段检测", () => {
    expect(detectReplyEmotion("哈哈 太开心了！")).toBe("happy");
  });
  it("括号表演提示：嘴角翘起 → 开心（正文提到快哭不误判）", () => {
    expect(
      detectReplyEmotion(
        "（偷偷瞄了你一眼，嘴角不自觉地翘起来）看到你现在这么开心，比刚才那副快哭的表情好多了。",
      ),
    ).toBe("happy");
  });
  it("多括号并存且平手：笑出声(happy) 优先于 语气放软(sad)", () => {
    expect(
      detectReplyEmotion(
        "（看你手舞足蹈的样子，忍不住笑出声）（歪了歪头，语气放软）今天真开心！",
      ),
    ).toBe("happy");
  });
});

describe("live2d · 情感动作映射 + 角色名", () => {
  it("每个情绪都有动作候选（真实控制）", () => {
    for (const e of EMOTIONS) {
      expect(EMOTION_MOTIONS[e].length).toBeGreaterThan(0);
    }
  });
  it("常见情绪映射到 bestdori 自带动作名", () => {
    expect(EMOTION_MOTIONS.happy).toContain("smile01");
    expect(EMOTION_MOTIONS.angry).toContain("angry01");
    expect(EMOTION_MOTIONS.sad).toContain("sad01");
    expect(EMOTION_MOTIONS.neutral).toContain("idle01");
  });
  it("characterNameOf 已知角色返回名字，未知回退模型名", () => {
    expect(characterNameOf("001_casual")).toBe("户山 香澄");
    expect(characterNameOf("021_casual")).toBe("凑 友希那");
    expect(characterNameOf("999_weird")).toBe("999_weird");
  });
});

describe("live2d · auto 随机角色", () => {
  it("randomLive2dModel 总是返回精选角色列表里的模型", () => {
    for (let i = 0; i < 50; i++) {
      const m = randomLive2dModel();
      expect(LIVE2D_CHARACTERS.some((c) => c.model === m)).toBe(true);
    }
  });
  it("resolveLive2dModel: 本地 auto → 随机精选角色", () => {
    saveLive2dModel(LIVE2D_MODEL_AUTO);
    const m = resolveLive2dModel("011_casual");
    expect(LIVE2D_CHARACTERS.some((c) => c.model === m)).toBe(true);
  });
  it("resolveLive2dModel: 本地指定优先于站点默认", () => {
    saveLive2dModel("011_casual");
    expect(resolveLive2dModel("001_casual")).toBe("011_casual");
  });
  it("resolveLive2dModel: 无本地 → 站点默认 → 内置默认", () => {
    expect(resolveLive2dModel("015_casual")).toBe("015_casual");
    expect(resolveLive2dModel("")).toBe(DEFAULT_LIVE2D_MODEL);
  });
  it("auto 模式优先用最近 AI 选角缓存", () => {
    saveLive2dModel(LIVE2D_MODEL_AUTO);
    saveAutoPick("021_casual");
    expect(getAutoPick()?.model).toBe("021_casual");
    expect(resolveLive2dModel("001_casual")).toBe("021_casual");
  });
  it("auto 模式无缓存时回退随机精选角色", () => {
    saveLive2dModel(LIVE2D_MODEL_AUTO);
    const m = resolveLive2dModel("001_casual");
    expect(LIVE2D_CHARACTERS.some((c) => c.model === m)).toBe(true);
  });
});

describe("live2d · AI 表情标签（AI Chat 控制表情）", () => {
  it("解析 [表情:开心] 标签", () => {
    expect(parseEmotionTag("好的呢～[表情:开心]")).toBe("happy");
    expect(parseEmotionTag("不行！[表情:生气]")).toBe("angry");
  });
  it("解析 [EMOTION:难过] 标签（英文别名）", () => {
    expect(parseEmotionTag("嗯…[EMOTION:难过]")).toBe("sad");
  });
  it("无标签 → null", () => {
    expect(parseEmotionTag("好的，我来帮你")).toBeNull();
  });
  it("剥离标签保留正文", () => {
    expect(stripEmotionTag("好的呢～[表情:开心]")).toBe("好的呢～");
    expect(stripEmotionTag("不行！[EMOTION:生气]")).toBe("不行！");
    expect(stripEmotionTag("没有标签的正文")).toBe("没有标签的正文");
  });
  it("非法名称标签不解析但会被剥离", () => {
    expect(parseEmotionTag("[表情:疯癫]")).toBeNull();
    expect(stripEmotionTag("正文[表情:疯癫]")).toBe("正文");
  });
  it("中文括号标签：解析别名（别扭→害羞）并剥离", () => {
    expect(parseEmotionTag("好的【表情:别扭】")).toBe("shy");
    expect(parseEmotionTag("哈哈【表情:高兴】")).toBe("happy");
    expect(stripEmotionTag("好的【表情:别扭】")).toBe("好的");
    expect(stripEmotionTag("正文【EMOTION:开心】结尾")).toBe("正文结尾");
  });
});

describe("live2d · AI 动作指令（参数级精细控制）", () => {
  it("解析 [PARAM:参数:数值] 指令", () => {
    const cmds = parseActionCommands(
      "哈哈[PARAM:ParamMouthOpenY:0.8][PARAM:ParamEyeLOpen:0.5]",
    );
    expect(cmds.params).toHaveLength(2);
    expect(cmds.params[0]).toEqual({ id: "ParamMouthOpenY", value: 0.8 });
    expect(cmds.params[1]).toEqual({ id: "ParamEyeLOpen", value: 0.5 });
    expect(cmds.motion).toBeUndefined();
  });
  it("解析 [MOTION:动作] 与 [EXPRESSION:表情预设]", () => {
    const cmds = parseActionCommands(
      "[MOTION:smile01][EXPRESSION:niyaniya01]正文",
    );
    expect(cmds.motion).toBe("smile01");
    expect(cmds.expression).toBe("niyaniya01");
    expect(cmds.params).toHaveLength(0);
  });
  it("中文别名：[参数:…]/[动作:…]/[表情预设:…] 与中文括号", () => {
    const cmds = parseActionCommands(
      "【参数:ParamAngleX:0.4】【动作: nod01 】【表情预设:serious01】",
    );
    expect(cmds.params).toEqual([{ id: "ParamAngleX", value: 0.4 }]);
    expect(cmds.motion).toBe("nod01");
    expect(cmds.expression).toBe("serious01");
  });
  it("负值/小数/越界 clamp", () => {
    const cmds = parseActionCommands(
      "[PARAM:ParamBrowLY:-0.5][PARAM:ParamMouthOpenY:2.5]",
    );
    expect(cmds.params.find((p) => p.id === "ParamBrowLY")?.value).toBe(-0.5);
    // 2.5 越界 → clamp 到 1
    expect(cmds.params.find((p) => p.id === "ParamMouthOpenY")?.value).toBe(1);
  });
  it("同名参数多次出现保留最后一个", () => {
    const cmds = parseActionCommands(
      "[PARAM:ParamMouthOpenY:0.2][PARAM:ParamMouthOpenY:0.9]",
    );
    expect(cmds.params).toHaveLength(1);
    expect(cmds.params[0].value).toBe(0.9);
  });
  it("无指令 → 空结果", () => {
    const cmds = parseActionCommands("只是普通的回复，没有指令");
    expect(cmds.params).toHaveLength(0);
    expect(cmds.motion).toBeUndefined();
    expect(cmds.expression).toBeUndefined();
  });
  it("剥离动作指令保留正文", () => {
    expect(stripActionCommands("哈哈[PARAM:ParamMouthOpenY:0.8]")).toBe("哈哈");
    expect(stripActionCommands("[MOTION:smile01]你好")).toBe("你好");
    expect(stripActionCommands("正文[参数:ParamAngleX:0.4]结尾")).toBe(
      "正文结尾",
    );
    expect(stripActionCommands("无指令正文")).toBe("无指令正文");
  });
  it("与表情标签共存：动作指令解析不受 [表情:] 影响", () => {
    const cmds = parseActionCommands(
      "哈哈[PARAM:ParamMouthOpenY:0.6][表情:开心]",
    );
    expect(cmds.params).toEqual([{ id: "ParamMouthOpenY", value: 0.6 }]);
    expect(cmds.motion).toBeUndefined();
    // 表情标签由 stripEmotionTag 剥离，动作指令由 stripActionCommands 剥离，互不干扰
    expect(
      stripActionCommands("哈哈[PARAM:ParamMouthOpenY:0.6][表情:开心]"),
    ).toBe("哈哈[表情:开心]");
    expect(stripEmotionTag("哈哈[PARAM:ParamMouthOpenY:0.6][表情:开心]")).toBe(
      "哈哈[PARAM:ParamMouthOpenY:0.6]",
    );
  });
});

describe("live2d · 模型名解析", () => {
  it("parseModelNames 只取 NNN_* 角色服装，排除 live_event_/bili_/general", () => {
    const idx = {
      live2d: {
        chara: {
          "001_casual": {},
          "011_casual": {},
          live_event_123: {},
          bili_9_abc: {},
          general: {},
          "bad-name": {},
        },
      },
    };
    expect(parseModelNames(idx)).toEqual(["001_casual", "011_casual"]);
  });

  it("modelInfo 拆分 characterId / costume", () => {
    expect(modelInfo("011_casual")).toEqual({
      modelName: "011_casual",
      characterId: "011",
      costume: "casual",
    });
    expect(modelInfo("custom").characterId).toBe("");
  });

  it("parseCharacters 取多语言名字第一个非空", () => {
    const chars = {
      "1": { characterName: ["", "Kasumi", "香澄"] },
      "11": { characterName: ["こころ", "Kokoro"] },
    };
    const map = parseCharacters(chars);
    expect(map.get("1")).toBe("Kasumi");
    expect(map.get("11")).toBe("こころ");
  });

  it("parseCharacters 优先简体中文（index 3）", () => {
    const chars = {
      "1": {
        characterName: ["戸山 香澄", "Kasumi Toyama", "戶山 香澄", "户山 香澄"],
      },
    };
    expect(parseCharacters(chars).get("1")).toBe("户山 香澄");
  });

  it("groupModels 按角色分组并带名字", () => {
    const groups = groupModels(
      ["001_casual", "001_blooming", "011_casual"],
      new Map([
        ["001", "香澄"],
        ["011", "心"],
      ]),
    );
    expect(groups).toHaveLength(2);
    const kasumi = groups.find((g) => g.characterId === "001");
    expect(kasumi?.characterName).toBe("香澄");
    expect(kasumi?.models).toEqual(["001_casual", "001_blooming"]);
  });

  it("groupModels 兼容 chars 接口非补零 key（1/11）", () => {
    const groups = groupModels(
      ["001_casual", "011_casual"],
      new Map([
        ["1", "户山 香澄"],
        ["11", "弦卷心"],
      ]),
    );
    const kasumi = groups.find((g) => g.characterId === "001");
    expect(kasumi?.characterName).toBe("户山 香澄");
    const kokoro = groups.find((g) => g.characterId === "011");
    expect(kokoro?.characterName).toBe("弦卷心");
  });

  it("groupModels 未知角色回退 角色{id}", () => {
    const groups = groupModels(["999_casual"], new Map());
    expect(groups[0].characterName).toBe("角色 999");
  });
});

describe("live2d · 本地选择 + 站点配置", () => {
  it("save/load 模型名", () => {
    expect(loadLive2dModel()).toBe("");
    saveLive2dModel("011_casual");
    expect(loadLive2dModel()).toBe("011_casual");
  });

  it("resolveLive2dConfig：enabled 解析 + 默认模型回退", () => {
    expect(resolveLive2dConfig({})).toEqual({
      enabled: true,
      model: DEFAULT_LIVE2D_MODEL,
    });
    expect(
      resolveLive2dConfig({ live2d_enable: "0", live2d_model: "011_casual" }),
    ).toEqual({ enabled: false, model: "011_casual" });
    expect(
      resolveLive2dConfig({ live2d_enable: "0", live2d_model: "  " }),
    ).toEqual({ enabled: false, model: DEFAULT_LIVE2D_MODEL });
  });
});

describe("live2d · 第三方模型导入", () => {
  it("isThirdPartyModelInput 识别网址/路径/.json，模型名不算", () => {
    expect(isThirdPartyModelInput("https://example.com/model/model.json")).toBe(
      true,
    );
    expect(isThirdPartyModelInput("https://a.com/moc/model.json")).toBe(true);
    expect(isThirdPartyModelInput("026_casual")).toBe(false);
    expect(isThirdPartyModelInput("001_summer")).toBe(false);
  });

  it("THIRD_PARTY_DEMO_MODEL 内嵌第三方示例来源（可识别为第三方输入）", () => {
    expect(THIRD_PARTY_DEMO_MODEL).toContain("http");
    expect(THIRD_PARTY_DEMO_MODEL.endsWith(".model.json")).toBe(true);
    expect(isThirdPartyModelInput(THIRD_PARTY_DEMO_MODEL)).toBe(true);
  });

  it("live2dProxyUrl 构造通用代理 URL", () => {
    expect(live2dProxyUrl("https://example.com/model/model.json")).toBe(
      "lumia-live2d://proxy?url=" +
        encodeURIComponent("https://example.com/model/model.json"),
    );
  });

  it("absoluteLive2dProxyUrl 含 origin（防 pixi 基于 model.json base 拼错主机）", () => {
    const u = absoluteLive2dProxyUrl("https://example.com/a.png");
    expect(u).toContain("lumia-live2d://proxy?url=");
    expect(u).toContain(encodeURIComponent("https://example.com/a.png"));
    expect(u.startsWith("lumia-live2d://proxy?url=")).toBe(true);
  });
});

describe("live2d · 角色分组 + 自定义模型导入", () => {
  it("精选角色按乐队分组（5 队，每队 5 人）", () => {
    const bands = new Set(LIVE2D_CHARACTERS.map((c) => c.band));
    expect(bands.size).toBe(5);
    expect(bands.has("Poppin'Party")).toBe(true);
    expect(bands.has("Roselia")).toBe(true);
    for (const b of bands) {
      expect(LIVE2D_CHARACTERS.filter((c) => c.band === b).length).toBe(5);
    }
  });

  it("add/load/remove 自定义模型（去重 + 持久化）", () => {
    expect(loadCustomModels()).toEqual([]);
    const a = addCustomModel("026_casual");
    expect(a).toEqual([{ model: "026_casual", name: "026_casual" }]);
    // 去重：同名模型只保留一份（且保留新名字）
    const b = addCustomModel("026_casual", "自定义角色");
    expect(b.length).toBe(1);
    expect(b[0].name).toBe("自定义角色");
    expect(loadCustomModels()).toEqual([
      { model: "026_casual", name: "自定义角色" },
    ]);
    // 空值不写入
    addCustomModel("   ");
    expect(loadCustomModels().length).toBe(1);
    // 删除
    const c = removeCustomModel("026_casual");
    expect(c).toEqual([]);
    expect(loadCustomModels()).toEqual([]);
  });
});

describe("live2d · 点击/触摸命中反应（Tap 交互）", () => {
  it("TAP_REACTIONS 头=惊讶、身=开心", () => {
    expect(TAP_REACTIONS.head.emotion).toBe("surprised");
    expect(TAP_REACTIONS.body.emotion).toBe("happy");
    expect(TAP_REACTIONS.head.motions.length).toBeGreaterThan(0);
    expect(TAP_REACTIONS.body.motions.length).toBeGreaterThan(0);
  });

  it("pickTapReaction 返回对应区域反应且动作候选非空", () => {
    const h = pickTapReaction("head");
    expect(h.emotion).toBe("surprised");
    expect(h.motions.length).toBe(1);
    const b = pickTapReaction("body");
    expect(b.emotion).toBe("happy");
    expect(b.motions.length).toBe(1);
  });

  it("resolveHitRegion：盒内上部=头、下部=身、盒外=null", () => {
    // 中心 (100,100)，包围盒 200x300
    // 上部（y < 100 - 300*0.05 = 85）→ head
    expect(resolveHitRegion(100, 50, 100, 100, 200, 300)).toBe("head");
    expect(resolveHitRegion(100, 10, 100, 100, 200, 300)).toBe("head");
    // 下部 → body
    expect(resolveHitRegion(100, 200, 100, 100, 200, 300)).toBe("body");
    expect(resolveHitRegion(100, 240, 100, 100, 200, 300)).toBe("body");
    // 盒外 → null（左右/上下越界）
    expect(resolveHitRegion(-10, 100, 100, 100, 200, 300)).toBeNull();
    expect(resolveHitRegion(100, 400, 100, 100, 200, 300)).toBeNull();
    expect(resolveHitRegion(210, 100, 100, 100, 200, 300)).toBeNull();
  });

  it("resolveHitRegion：零尺寸安全返回 null", () => {
    expect(resolveHitRegion(10, 10, 0, 0, 0, 0)).toBeNull();
    expect(resolveHitRegion(10, 10, 0, 0, -1, 5)).toBeNull();
  });

  it("resolveHitRegion：类型收窄为 HitRegion", () => {
    const r: HitRegion | null = resolveHitRegion(100, 50, 100, 100, 200, 300);
    expect(r).not.toBeNull();
  });
});

describe("live2d · rmsToMouth（真实音频口型映射）", () => {
  it("静音/无效输入 → 微张 0.06", () => {
    expect(rmsToMouth(0)).toBeCloseTo(0.06, 5);
    expect(rmsToMouth(-1)).toBeCloseTo(0.06, 5);
    expect(rmsToMouth(NaN)).toBeCloseTo(0.06, 5);
    expect(rmsToMouth(Infinity)).toBeCloseTo(0.06, 5);
  });

  it("音量越大嘴张越大，且封顶适中 0.9", () => {
    const low = rmsToMouth(0.1);
    const mid = rmsToMouth(0.3);
    const high = rmsToMouth(1.0);
    expect(low).toBeGreaterThan(0.06);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeCloseTo(0.9, 5);
    expect(rmsToMouth(5)).toBeCloseTo(0.9, 5); // 超量封顶
  });

  it("范围始终在 [0.06, 0.9] 内", () => {
    for (const r of [0.01, 0.05, 0.2, 0.5, 0.8, 2]) {
      const v = rmsToMouth(r);
      expect(v).toBeGreaterThanOrEqual(0.06);
      expect(v).toBeLessThanOrEqual(0.9);
    }
  });

  it("中等音量幅度适中不夸张（增益放大，有换气换词起伏）", () => {
    // RMS 0.2 → 嘴张明显（~0.77），说话节奏有起伏
    const v = rmsToMouth(0.2);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.86);
  });
});

describe("live2d · smoothMouth（口型平滑，attack 快/release 慢/说话保持）", () => {
  it("有声（RMS 大）→ 快速逼近目标（attack 0.6）", () => {
    // rms=0.5 → target≈0.9；从 0.06 起步，开口较快、开头响应及时
    const v = smoothMouth(0.06, 0.5);
    expect(v).toBeGreaterThan(0.5);
    // 与 release 相比明显更快
    const silentStep = smoothMouth(0.6, 0);
    expect(v - 0.06).toBeGreaterThan(0.6 - silentStep);
  });

  it("无声（RMS=0）→ 缓闭合（release 0.28）", () => {
    const v = smoothMouth(0.6, 0);
    expect(v).toBeLessThan(0.6);
    expect(v).toBeGreaterThan(0.06); // 未一步闭合，平滑回落
  });

  it("说话期间嘴保持 ≥0.16（音节间隙不闭死）", () => {
    // 微弱有声：rms=0.03 → target≈0.149 > 阈值 0.12 → speaking=true
    const v = smoothMouth(0, 0.03);
    expect(v).toBeGreaterThanOrEqual(0.16);
  });

  it("多次迭代收敛到目标值", () => {
    let v = 0.06;
    for (let i = 0; i < 100; i++) v = smoothMouth(v, 0.5); // target≈0.8
    expect(v).toBeCloseTo(rmsToMouth(0.5), 1);
  });

  it("静音最终收敛到微张 0.06，且不越界", () => {
    let v = 0.7;
    for (let i = 0; i < 100; i++) v = smoothMouth(v, 0);
    expect(v).toBeCloseTo(0.06, 1);
  });

  it("自定义参数生效（attack/release/hold/threshold）", () => {
    // 更慢的 attack → 单步上升更小
    const slow = smoothMouth(0.06, 0.5, { attack: 0.2 });
    const fast = smoothMouth(0.06, 0.5, { attack: 0.9 });
    expect(slow).toBeLessThan(fast);
    // 更高的 hold → 说话保持更明显
    const held = smoothMouth(0, 0.03, { hold: 0.3 });
    expect(held).toBeGreaterThanOrEqual(0.3);
    // 更小的阈值 → 更易判定为说话
    const th = smoothMouth(0, 0.01, { threshold: 0.05 });
    expect(th).toBeGreaterThanOrEqual(0.16);
  });

  it("无效 RMS → 按静音处理（收敛向 0.06）", () => {
    expect(smoothMouth(0.5, NaN)).toBeLessThan(0.5);
    expect(smoothMouth(0.5, -1)).toBeLessThan(0.5);
  });
});

describe("live2d · analyzeFrequencyBands（频谱分段分析）", () => {
  it("空数据 → 全零", () => {
    const b = analyzeFrequencyBands(new Uint8Array(0), 44100);
    expect(b.low).toBe(0);
    expect(b.mid).toBe(0);
    expect(b.high).toBe(0);
  });

  it("无效采样率 → 全零", () => {
    const data = new Uint8Array(512).fill(128);
    const b = analyzeFrequencyBands(data, 0);
    expect(b.low).toBe(0);
    expect(b.mid).toBe(0);
    expect(b.high).toBe(0);
  });

  it("纯静音 → 低能量", () => {
    const data = new Uint8Array(512).fill(0);
    const b = analyzeFrequencyBands(data, 44100);
    expect(b.low).toBeLessThanOrEqual(0.1);
    expect(b.mid).toBeLessThanOrEqual(0.1);
    expect(b.high).toBeLessThanOrEqual(0.1);
  });

  it("全频带满能量 → 归一化接近1", () => {
    const data = new Uint8Array(512).fill(200);
    const b = analyzeFrequencyBands(data, 44100);
    expect(b.low).toBeCloseTo(1, 0);
    expect(b.mid).toBeCloseTo(1, 0);
    expect(b.high).toBeCloseTo(1, 0);
  });

  it("只低频有能量 → low > mid, low > high", () => {
    // Fill only bins 2-9: at 44100Hz/512bins => ~86-387Hz (low band)
    const data = new Uint8Array(512);
    for (let i = 2; i < 10; i++) data[i] = 200;
    const b = analyzeFrequencyBands(data, 44100);
    expect(b.low).toBeGreaterThan(0.5);
    expect(b.mid).toBeLessThan(b.low);
    expect(b.high).toBeLessThan(b.low);
  });

  it("值在 [0, 1] 范围内", () => {
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i++) data[i] = Math.floor(Math.random() * 256);
    const b = analyzeFrequencyBands(data, 44100);
    expect(b.low).toBeGreaterThanOrEqual(0);
    expect(b.low).toBeLessThanOrEqual(1);
    expect(b.mid).toBeGreaterThanOrEqual(0);
    expect(b.mid).toBeLessThanOrEqual(1);
    expect(b.high).toBeGreaterThanOrEqual(0);
    expect(b.high).toBeLessThanOrEqual(1);
  });
});

describe("live2d · bandEnergiesToMouthParams（频带→嘴型映射）", () => {
  it("零能量 → 中性", () => {
    const mp = bandEnergiesToMouthParams({ low: 0, mid: 0, high: 0 }, 0);
    expect(mp.width).toBe(0);
    expect(mp.round).toBe(0);
    expect(mp.scale).toBe(1);
  });

  it("高频主导 → 嘴型偏宽", () => {
    const mp = bandEnergiesToMouthParams(
      { low: 0.1, mid: 0.2, high: 0.7 },
      0.3,
    );
    expect(mp.width).toBeGreaterThan(0);
  });

  it("低频主导 → 嘴型偏圆", () => {
    const mp = bandEnergiesToMouthParams(
      { low: 0.7, mid: 0.2, high: 0.1 },
      0.3,
    );
    expect(mp.round).toBeGreaterThan(0);
  });

  it("RMS 大 → 缩放 > 1", () => {
    const mp = bandEnergiesToMouthParams(
      { low: 0.3, mid: 0.3, high: 0.3 },
      0.5,
    );
    expect(mp.scale).toBeGreaterThan(1);
  });

  it("值在合理范围内", () => {
    const mp = bandEnergiesToMouthParams(
      { low: 0.5, mid: 0.5, high: 0.5 },
      0.3,
    );
    expect(mp.width).toBeGreaterThanOrEqual(-0.6);
    expect(mp.width).toBeLessThanOrEqual(0.6);
    expect(mp.round).toBeGreaterThanOrEqual(-0.4);
    expect(mp.round).toBeLessThanOrEqual(0.5);
    expect(mp.scale).toBeGreaterThanOrEqual(0.9);
    expect(mp.scale).toBeLessThanOrEqual(1.15);
  });
});

describe("live2d · adaptiveRmsGain（自适应增益）", () => {
  it("空历史 → 默认 1.0", () => {
    expect(adaptiveRmsGain([])).toBe(1.0);
  });

  it("安静 TTS（avg<0.08）→ 增益放大 1.35", () => {
    const h = Array(20).fill(0.05);
    expect(adaptiveRmsGain(h)).toBe(1.35);
  });

  it("偏安静（avg<0.15）→ 略放大 1.15", () => {
    const h = Array(20).fill(0.12);
    expect(adaptiveRmsGain(h)).toBe(1.15);
  });

  it("响亮 TTS（avg>0.25）→ 缩小 0.85", () => {
    const h = Array(20).fill(0.3);
    expect(adaptiveRmsGain(h)).toBe(0.85);
  });

  it("正常响度 → 默认 1.0", () => {
    const h = Array(20).fill(0.18);
    expect(adaptiveRmsGain(h)).toBe(1.0);
  });

  it("含无效值 → 过滤后计算", () => {
    const h = [0.05, NaN, 0.05, Infinity, 0.05, -1, 0.05];
    expect(adaptiveRmsGain(h)).toBe(1.35);
  });
});

describe("live2d · Cubism3/4（.model3.json）加载链路", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isModel3Url 识别 .model3.json", () => {
    expect(isModel3Url("https://x.com/Haru/Haru.model3.json")).toBe(true);
    expect(isModel3Url("https://x.com/shizuku/shizuku.model.json")).toBe(false);
    expect(isModel3Url("")).toBe(false);
  });

  it("buildLive2dSettingsFromModel3 解析 FileReferences + HitAreas（绝对代理 URL）", async () => {
    const modelJson = {
      FileReferences: {
        Moc: "Haru.moc3",
        Textures: ["Haru.2048/texture_00.png"],
        Physics: "Haru.physics3.json",
        Expressions: [{ Name: "f01", File: "expressions/f01.exp3.json" }],
        Motions: {
          Idle: [{ File: "motions/idle_0.motion3.json" }],
          TapBody: [{ File: "motions/tap.motion3.json" }],
        },
      },
      HitAreas: [{ Id: "HitArea", Name: "Body" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => modelJson,
      }),
    );
    const url = "https://raw.example.com/models/Haru/Haru.model3.json";
    const s = await buildLive2dSettingsFromModel3(url);
    expect(s.model).toContain("lumia-live2d://proxy?url=");
    expect(s.model).toContain(
      encodeURIComponent("https://raw.example.com/models/Haru/Haru.moc3"),
    );
    expect(s.textures.length).toBe(1);
    expect(s.textures[0]).toContain("texture_00.png");
    expect(s.physics).toContain("Haru.physics3.json");
    expect(s.expressions[0].name).toBe("f01");
    expect(s.motions.Idle[0].file).toContain("idle_0.motion3.json");
    expect(s.hitAreas).toEqual([{ name: "Body", id: "HitArea" }]);
  });

  it("buildLive2dSettingsFromModel3 缺 Moc 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ FileReferences: {} }),
      }),
    );
    await expect(
      buildLive2dSettingsFromModel3("https://x.com/m/M.model3.json"),
    ).rejects.toThrow();
  });

  it("fetchThirdPartyModelSafe 按扩展名分流（model3 vs model.json）", async () => {
    const m3 = {
      FileReferences: { Moc: "a.moc3", Textures: ["t.png"], Motions: {} },
    };
    const m2 = { model: "a.moc", textures: ["t.png"], motions: {} };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo) => {
        const ustr = String(u);
        calls.push(ustr);
        if (ustr.includes("M.model3.json"))
          return { ok: true, json: async () => m3 };
        return { ok: true, json: async () => m2 };
      }),
    );
    const s3 = await fetchThirdPartyModelSafe(
      "https://x.com/models/M/M.model3.json",
    );
    expect(s3.model).toContain("a.moc3");
    const s2 = await fetchThirdPartyModelSafe(
      "https://x.com/models/S/S.model.json",
    );
    expect(s2.model).toContain("a.moc");
  });
});

describe("live2d · [LOOK:方向] 视线指令", () => {
  it("解析 LOOK 中英文别名方向", () => {
    expect(parseActionCommands("[LOOK:left]").look).toBe("left");
    expect(parseActionCommands("【看:右】").look).toBe("right");
    expect(parseActionCommands("[视线:up]").look).toBe("up");
    expect(parseActionCommands("朝下看 [看:down]").look).toBe("down");
    expect(parseActionCommands("[LOOK:center]").look).toBe("center");
  });

  it("非法方向不设置 look", () => {
    const c = parseActionCommands("[LOOK:sideways]");
    expect(c.look).toBeUndefined();
  });

  it("stripActionCommands 剥离 LOOK 指令", () => {
    const s = stripActionCommands("他点了点头 [LOOK:down] 继续说着");
    expect(s).toBe("他点了点头  继续说着");
  });

  it("LOOK_TARGETS 方向角度映射", () => {
    expect(LOOK_TARGETS.left.x).toBeLessThan(0);
    expect(LOOK_TARGETS.right.x).toBeGreaterThan(0);
    expect(LOOK_TARGETS.up.y).toBeLessThan(0);
    expect(LOOK_TARGETS.down.y).toBeGreaterThan(0);
    expect(LOOK_TARGETS.center).toEqual({ x: 0, y: 0 });
  });
});
