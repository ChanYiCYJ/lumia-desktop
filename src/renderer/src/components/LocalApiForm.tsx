import { useMemo, useState } from "react";
import {
  getLocalCfg,
  saveLocalCfg,
  clearLocalCfg,
  type LocalAIConfig,
} from "../lib/localCfg";
import {
  PROVIDER_PRESETS,
  detectProvider,
  type AiProvider,
} from "../lib/providerPresets";
import {
  testModelConnection,
  fetchProviderModels,
  formatLatency,
  type TestConnectionResult,
  type FetchModelsResult,
} from "../lib/providerTest";

/**
 * 本地模型 API 配置表单（共享组件）。
 * LocalApiModal 与 Agent 面板「设置」tab 的模型 API 区块共用，
 * 消除此前两处重复的 getLocalCfg/saveLocalCfg/clearLocalCfg 逻辑。
 *
 * 新增 DeepSeek / Kimi / OpenAI 一键预设：点击自动填充接口地址与推荐模型，
 * 并在已填入时按 endpoint/model 识别当前服务商。
 */
export interface LocalApiFormProps {
  pageId: number;
  /** 保存/清除后回调（modal 在此负责关闭，inline 在此刷新外层状态） */
  onSaved: () => void;
  /** 渲染风格：modal=带 label 的完整表单；inline=紧凑占位符表单 */
  variant?: "modal" | "inline";
  /** inline 模式下显示“自定义 API 已启用（限制已解除）”提示 */
  showEnabledHint?: boolean;
}

const inputCls =
  "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800";

export function LocalApiForm({
  pageId,
  onSaved,
  variant = "inline",
  showEnabledHint = false,
}: LocalApiFormProps) {
  const [cfg, setCfg] = useState<LocalAIConfig>(() => getLocalCfg(pageId));
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "loading" | "done">(
    "idle",
  );
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(
    null,
  );
  // 自动搜索模型：从 {endpoint}/models 拉取可用列表
  const [modelFetchState, setModelFetchState] = useState<
    "idle" | "loading" | "done"
  >("idle");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchResult, setFetchResult] = useState<FetchModelsResult | null>(
    null,
  );
  const isModal = variant === "modal";

  const provider = detectProvider(cfg.endpoint, cfg.model);
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider);

  /** 模型下拉候选 = 预设列表 + 自动搜索到的模型（去重，最新优先） */
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    preset?.models.forEach((m) => set.add(m));
    fetchedModels.forEach((m) => set.add(m));
    return Array.from(set);
  }, [preset, fetchedModels]);

  /** 自动搜索模型：读取 {endpoint}/models 并填入候选列表 */
  const fetchModels = async () => {
    if (modelFetchState === "loading") return;
    setModelFetchState("loading");
    setFetchResult(null);
    const r = await fetchProviderModels({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
    });
    setFetchedModels(r.models);
    setFetchResult(r);
    setModelFetchState("done");
  };

  /** 测试并保存：先保存配置，再自动发起连接测试（校验 接口/密钥/模型 是否可用） */
  const saveAndTest = async () => {
    const target = {
      endpoint: cfg.endpoint.trim(),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim(),
    };
    saveLocalCfg(pageId, {
      ...target,
      prompt: cfg.prompt,
    });
    onSaved();
    setTestState("loading");
    setTestResult(null);
    const r = await testModelConnection(target);
    setTestResult(r);
    setTestState("done");
  };

  /** 一键填充服务商预设（接口地址 + 推荐模型；不覆盖用户已填的 API Key / 提示词） */
  const applyPreset = (id: AiProvider) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setCfg((prev) => ({
      ...prev,
      endpoint: p.endpoint,
      // 模型为空或当前非该服务商时填入推荐模型（避免覆盖已选好的同类模型）
      model:
        !prev.model.trim() || detectProvider(prev.endpoint, prev.model) !== id
          ? p.model
          : prev.model,
    }));
  };

  const clear = () => {
    clearLocalCfg(pageId);
    setCfg({ endpoint: "", apiKey: "", model: "", prompt: "" });
    onSaved();
  };

  return (
    <>
      {/* 一键预设：DeepSeek / Kimi / OpenAI */}
      <div className="space-y-1">
        {isModal && (
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            快捷预设
          </label>
        )}
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_PRESETS.map((p) => {
            const active = provider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                title={p.desc}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition active:scale-95 ${
                  active
                    ? "border-gray-900 bg-gray-900 text-white dark:border-gray-200 dark:bg-gray-200 dark:text-gray-900"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div>
          {isModal && (
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              接口地址（留空使用默认）
            </label>
          )}
          <input
            value={cfg.endpoint}
            onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })}
            placeholder={
              isModal ? "https://api.openai.com/v1" : "接口地址（留空用默认）"
            }
            className={inputCls}
          />
        </div>
        <div>
          {isModal && (
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              API Key（留空使用默认）
            </label>
          )}
          <div className="relative">
            <input
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              type={showKey ? "text" : "password"}
              placeholder={isModal ? "sk-..." : "API Key（留空用默认）"}
              className={inputCls}
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              title={showKey ? "隐藏密钥" : "显示密钥"}
            >
              {showKey ? (
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div>
          {isModal && (
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              模型（留空使用默认）
            </label>
          )}
          <div className="flex gap-1.5">
            <input
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              list="kimo-ai-model-list"
              placeholder={isModal ? "gpt-4o-mini" : "模型（留空用默认）"}
              className={inputCls}
            />
            <button
              type="button"
              onClick={fetchModels}
              disabled={modelFetchState === "loading"}
              title="调用 /models 接口自动拉取该服务商可用模型"
              className="shrink-0 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition hover:border-gray-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500"
            >
              {modelFetchState === "loading" ? (
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              ) : (
                "自动搜索"
              )}
            </button>
          </div>
          {/* 模型候选：预设 + 自动搜索合并（datalist，不强制） */}
          {modelOptions.length > 0 && (
            <datalist id="kimo-ai-model-list">
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
          {/* 自动搜索结果 */}
          {fetchResult && (
            <p
              className={`mt-1 flex items-center gap-1.5 text-[11px] leading-relaxed ${
                fetchResult.ok
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-500 dark:text-red-400"
              }`}
            >
              {fetchResult.ok ? "✓" : "✗"}
              <span className="min-w-0 flex-1">{fetchResult.message}</span>
            </p>
          )}
          {fetchedModels.length > 0 && (
            <div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto pr-1">
              <div className="flex flex-wrap gap-1">
                {fetchedModels.map((m) => {
                  const chosen = cfg.model === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setCfg({ ...cfg, model: m })}
                      title={m}
                      className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] transition active:scale-95 ${
                        chosen
                          ? "border-indigo-500 bg-indigo-500 text-white"
                          : "border-gray-200 bg-gray-50 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-indigo-500 dark:hover:text-indigo-300"
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 测试结果（保存后自动测试） */}
      {testResult && (
        <p
          className={`flex items-center gap-1.5 text-[11px] leading-relaxed ${
            testResult.ok
              ? "text-green-600 dark:text-green-400"
              : "text-red-500 dark:text-red-400"
          }`}
        >
          {testResult.ok ? "✓" : "✗"}
          <span className="min-w-0 flex-1">
            {testResult.message}
            {testResult.latencyMs != null &&
              ` · ${formatLatency(testResult.latencyMs)}`}
          </span>
        </p>
      )}

      {isModal ? (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <button
            onClick={clear}
            className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400"
          >
            清除本地配置
          </button>
          <button
            onClick={saveAndTest}
            disabled={testState === "loading"}
            className="rounded-xl bg-gray-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            {testState === "loading" ? (
              <span className="inline-flex items-center gap-1.5">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                测试中…
              </span>
            ) : (
              "测试并保存"
            )}
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={saveAndTest}
            disabled={testState === "loading"}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            {testState === "loading" ? (
              <span className="inline-flex items-center gap-1.5">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                测试中…
              </span>
            ) : (
              "测试并保存"
            )}
          </button>
          {showEnabledHint && (
            <p className="text-[11px] text-indigo-500 dark:text-indigo-400">
              自定义 API 已启用（次数/冷却限制已解除）
            </p>
          )}
        </>
      )}
    </>
  );
}
