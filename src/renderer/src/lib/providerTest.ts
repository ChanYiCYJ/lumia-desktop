/**
 * 自定义模型连接测试（OpenAI 兼容 /chat/completions）
 * ------------------------------------------------------------------
 * 在设置面板「自定义模型」中点击「测试连接」时调用，用于校验用户填写的
 * 接口地址 / API Key / 模型是否真实可用，给出友好中文反馈。
 *
 * - 纯函数实现 + 可注入 fetch，方便 vitest 单测（mock fetch 各分支）
 * - 不改变任何本地配置，只做一次最小请求（max_tokens 极小、单条 ping 消息）
 */
import { detectProvider } from "./providerPresets";

export interface TestTarget {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** 请求耗时（毫秒），网络/服务异常时可能缺失 */
  latencyMs?: number;
  /** 识别到的服务商（deepseek/kimi/openai/other） */
  provider?: string;
  /** 测试成功的模型名 */
  model?: string;
}

/** 按 HTTP 状态码返回可读的中文错误说明 */
function describeHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403)
    return "认证失败：API Key 无效或没有访问权限（401/403）";
  if (status === 404) return "接口地址或模型不存在（404），请检查地址与模型名";
  if (status === 429) return "请求过于频繁或额度不足（429），请稍后再试";
  if (status === 400) return `请求被拒绝（400）${detail ? `：${detail}` : ""}`;
  if (status >= 500) return `服务端错误（${status}），请稍后再试`;
  return `请求失败（${status}）${detail ? `：${detail}` : ""}`;
}

/**
 * 测试 OpenAI 兼容接口连通性。
 * @param cfg 接口地址 / API Key / 模型
 * @param fetchImpl 可注入的 fetch 实现（测试用），默认全局 fetch
 */
export async function testModelConnection(
  cfg: TestTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<TestConnectionResult> {
  const endpoint = (cfg.endpoint || "").trim();
  const apiKey = (cfg.apiKey || "").trim();
  const model = (cfg.model || "").trim();

  if (!endpoint) return { ok: false, message: "请先填写接口地址" };
  if (!apiKey) return { ok: false, message: "请先填写 API Key" };
  if (!model) return { ok: false, message: "请先填写模型名称" };

  const provider = detectProvider(endpoint, model);
  const start = Date.now();
  try {
    const res = await fetchImpl(
      endpoint.replace(/\/+$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 8,
          stream: false,
        }),
      },
    );
    const latencyMs = Date.now() - start;

    if (res.ok) {
      // 校验响应形状：OpenAI 兼容应返回 { choices: [{ message: { content } }] }
      const data = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[];
      } | null;
      if (!data || !Array.isArray(data.choices) || !data.choices.length) {
        return {
          ok: false,
          message: "响应格式异常：未返回有效结果，请确认接口为 OpenAI 兼容格式",
          latencyMs,
          provider,
        };
      }
      return {
        ok: true,
        message: `连接成功 · ${model}`,
        latencyMs,
        provider,
        model,
      };
    }

    const text = await res.text().catch(() => "");
    const detail = text.slice(0, 200).replace(/\s+/g, " ");
    return {
      ok: false,
      message: describeHttpError(res.status, detail),
      latencyMs,
      provider,
    };
  } catch (e) {
    return {
      ok: false,
      message: `网络错误：${
        e instanceof Error ? e.message : String(e)
      }（请检查接口地址与网络）`,
      latencyMs: Date.now() - start,
      provider,
    };
  }
}

/** 简化耗时展示：<1000ms 显示毫秒，否则显示秒 */
export function formatLatency(ms?: number): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export interface FetchModelsResult {
  ok: boolean;
  /** 拉取到的模型名列表（失败为空数组） */
  models: string[];
  /** 友好中文反馈（成功含模型数量/耗时，失败为原因） */
  message: string;
}

/**
 * 自动搜索模型：调用 OpenAI 兼容的 GET {endpoint}/models 拉取可用模型列表。
 * DeepSeek / Kimi / OpenAI 及各类兼容网关均支持此接口。
 * 纯函数实现 + 可注入 fetch，便于 vitest 单测。
 */
export async function fetchProviderModels(
  cfg: Pick<TestTarget, "endpoint" | "apiKey">,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchModelsResult> {
  const endpoint = (cfg.endpoint || "").trim();
  const apiKey = (cfg.apiKey || "").trim();

  if (!endpoint) return { ok: false, models: [], message: "请先填写接口地址" };
  if (!apiKey) return { ok: false, models: [], message: "请先填写 API Key" };

  const start = Date.now();
  try {
    const res = await fetchImpl(endpoint.replace(/\/+$/, "") + "/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = text.slice(0, 200).replace(/\s+/g, " ");
      return {
        ok: false,
        models: [],
        message: describeHttpError(res.status, detail),
      };
    }

    const data = (await res.json().catch(() => null)) as {
      data?: { id?: unknown }[];
    } | null;
    const list = Array.isArray(data?.data)
      ? (data as { data: { id?: unknown }[] }).data
          .map((m) => (typeof m?.id === "string" ? m.id : ""))
          .filter(Boolean)
      : [];
    if (!list.length) {
      return {
        ok: false,
        models: [],
        message: "接口未返回模型列表（该服务商可能不支持 /models 接口）",
      };
    }
    return {
      ok: true,
      models: list,
      message: `已获取 ${list.length} 个模型 · ${formatLatency(Date.now() - start)}`,
    };
  } catch (e) {
    return {
      ok: false,
      models: [],
      message: `网络错误：${
        e instanceof Error ? e.message : String(e)
      }（请检查接口地址与网络）`,
    };
  }
}
