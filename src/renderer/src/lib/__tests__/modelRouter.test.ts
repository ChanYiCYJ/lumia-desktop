import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveModelRoles,
  routeModel,
  loadBotRegistry,
  type ModelRoles,
} from "../modelRouter";
import type { AIChatConfig } from "../types";

const primary: AIChatConfig = {
  endpoint: "https://api.deepseek.com/v1",
  apiKey: "sk-primary",
  model: "deepseek-chat",
  botName: "YunoSeek",
  systemPrompt: "你是助手",
};

function setBots(bots: unknown): void {
  localStorage.setItem("kimo_ai_bots", JSON.stringify(bots));
}

beforeEach(() => {
  localStorage.clear();
});

describe("modelRouter · 单模型回退", () => {
  it("无注册表：fast/verifier 回落 primary", () => {
    const roles = resolveModelRoles(primary);
    expect(roles.fast).toBe(primary);
    expect(roles.verifier).toBe(primary);
  });

  it("注册表只有主模型：仍回落 primary", () => {
    setBots([
      {
        id: "a",
        endpoint: "https://api.deepseek.com/v1",
        apiKey: "k",
        model: "deepseek-chat",
      },
    ]);
    const roles = resolveModelRoles(primary);
    expect(roles.fast).toBe(primary);
  });
});

describe("modelRouter · 多模型路由", () => {
  it("存在第二个模型：fast 选中非推理模型", () => {
    setBots([
      {
        id: "a",
        endpoint: "https://api.deepseek.com/v1",
        apiKey: "k1",
        model: "deepseek-chat",
      },
      {
        id: "b",
        endpoint: "https://api.moonshot.cn/v1",
        apiKey: "k2",
        model: "moonshot-v1-8k",
      },
    ]);
    const roles = resolveModelRoles(primary);
    expect(roles.fast).not.toBe(primary);
    expect(roles.fast.model).toBe("moonshot-v1-8k");
  });

  it("优先选名字含 fast/mini/lite 的模型做 fast", () => {
    setBots([
      { id: "a", endpoint: "https://x.com/v1", apiKey: "k1", model: "gpt-4o" },
      {
        id: "b",
        endpoint: "https://y.com/v1",
        apiKey: "k2",
        model: "gpt-4o-mini",
      },
    ]);
    const roles = resolveModelRoles(primary);
    expect(roles.fast.model).toBe("gpt-4o-mini");
  });

  it("推理模型不选作 fast（reasoner/thinking）", () => {
    setBots([
      {
        id: "a",
        endpoint: "https://x.com/v1",
        apiKey: "k1",
        model: "deepseek-chat",
      },
      {
        id: "b",
        endpoint: "https://x.com/v1",
        apiKey: "k2",
        model: "deepseek-reasoner",
      },
    ]);
    const roles = resolveModelRoles(primary);
    // 唯一其他模型是推理模型 → 无更优 fast，退而选它
    expect(roles.fast.model).toBe("deepseek-reasoner");
  });

  it("verifier 与 fast 不同（第三个模型存在时）", () => {
    setBots([
      {
        id: "a",
        endpoint: "https://x.com/v1",
        apiKey: "k1",
        model: "deepseek-chat",
      },
      {
        id: "b",
        endpoint: "https://x.com/v1",
        apiKey: "k2",
        model: "moonshot-v1-8k",
      },
      {
        id: "c",
        endpoint: "https://x.com/v1",
        apiKey: "k3",
        model: "gpt-4o-mini",
      },
    ]);
    const roles = resolveModelRoles(primary);
    expect(roles.fast.model).toBe("gpt-4o-mini");
    expect(roles.verifier.model).toBe("moonshot-v1-8k");
  });

  it("routeModel：单模型恒返回 primary，多模型按角色", () => {
    const single = resolveModelRoles(primary);
    expect(routeModel(single, "fast")).toBe(primary);
    setBots([
      {
        id: "a",
        endpoint: "https://x.com/v1",
        apiKey: "k1",
        model: "deepseek-chat",
      },
      {
        id: "b",
        endpoint: "https://y.com/v1",
        apiKey: "k2",
        model: "moonshot-v1-8k",
      },
    ]);
    const multi = resolveModelRoles(primary);
    expect(routeModel(multi, "fast").model).toBe("moonshot-v1-8k");
    expect(routeModel(multi, "primary")).toBe(primary);
  });

  it("注册表损坏 JSON：静默回落单模型", () => {
    localStorage.setItem("kimo_ai_bots", "{bad json");
    const roles = resolveModelRoles(primary);
    expect(roles.fast).toBe(primary);
  });
});

describe("modelRouter · loadBotRegistry", () => {
  it("读取并校验数组", () => {
    setBots([{ id: "a", endpoint: "e", apiKey: "k", model: "m" }]);
    const bots = loadBotRegistry();
    expect(bots).toHaveLength(1);
    expect(bots[0].model).toBe("m");
  });
  it("非数组返回空", () => {
    setBots({ a: 1 });
    expect(loadBotRegistry()).toEqual([]);
  });
});

// 类型导出检查（避免误删）
export type _ModelRoles = ModelRoles;
