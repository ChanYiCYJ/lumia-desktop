import { useState } from "react";
import {
  SEARCH_API_PROVIDERS,
  loadSearchApiCfg,
  saveSearchApiCfg,
  hasSearchApi,
  testSearchApi,
  type SearchApiCfg,
  type SearchApiProvider,
} from "../lib/searchApi";

/**
 * 搜索 API 平台配置表单（共享组件）。
 * 用户可自由选择搜索平台并填写自己的 Key（Tavily / Brave Search / SearXNG 实例），
 * 配置存 localStorage（kimo_search_api_cfg），搜索时由 searchBackend 随请求传给 Worker 代理执行。
 *
 * 被网络拦截/失败时自动降级到免费引擎，不硬刚。
 */
export interface SearchApiFormProps {
  /** 保存/清除后回调（可选，供外层刷新） */
  onSaved?: () => void;
}

const inputCls =
  "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800";

export function SearchApiForm({ onSaved }: SearchApiFormProps) {
  const [cfg, setCfg] = useState<SearchApiCfg>(() => loadSearchApiCfg());
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "loading" | "done">(
    "idle",
  );
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);

  const meta = SEARCH_API_PROVIDERS.find((p) => p.value === cfg.provider);
  const configured = hasSearchApi(cfg);

  /** 测试并保存：先保存配置，再自动发起连接测试（校验 key/实例是否可用） */
  const saveAndTest = async () => {
    const target = {
      ...cfg,
      apiKey: cfg.apiKey.trim(),
      instance: cfg.instance.trim(),
    };
    saveSearchApiCfg(target);
    onSaved?.();
    setTestState("loading");
    setTestResult(null);
    const r = await testSearchApi(target);
    setTestResult(r);
    setTestState("done");
  };

  const setProvider = (p: SearchApiProvider) => {
    setCfg((prev) => ({ ...prev, provider: p }));
    setTestResult(null);
  };

  return (
    <div className="space-y-2.5">
      {/* 平台选择（分段单选，同搜索模式卡片样式） */}
      <div className="flex gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
        {SEARCH_API_PROVIDERS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setProvider(p.value)}
            className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition ${
              cfg.provider === p.value
                ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {meta?.desc && (
        <p className="text-[11px] leading-relaxed text-gray-400">{meta.desc}</p>
      )}

      {/* 条件字段：API Key / SearXNG 实例地址 */}
      {meta?.needKey && (
        <div>
          <div className="relative">
            <input
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              type={showKey ? "text" : "password"}
              placeholder={
                cfg.provider === "tavily"
                  ? "tvly-..."
                  : "API Key（仅保存在当前浏览器）"
              }
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
      )}
      {meta?.needInstance && (
        <input
          value={cfg.instance}
          onChange={(e) => setCfg({ ...cfg, instance: e.target.value })}
          placeholder="SearXNG 实例地址，如 https://searx.be"
          className={inputCls}
        />
      )}

      {/* 保存（保存后自动测试连接）；自动模式无需配置，不显示 */}
      {cfg.provider !== "auto" && (
        <>
          <button
            type="button"
            onClick={saveAndTest}
            disabled={testState === "loading"}
            className="w-full rounded-xl border border-gray-900 bg-gray-900 px-3 py-2 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60 dark:border-gray-200 dark:bg-gray-200 dark:text-gray-900"
          >
            {testState === "loading" ? "测试中…" : "测试并保存"}
          </button>
          {testResult && (
            <p
              className={`text-[11px] leading-relaxed ${testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
            >
              {testResult.ok ? "✓ " : "✗ "}
              {testResult.message}
              {typeof testResult.latencyMs === "number"
                ? ` · ${testResult.latencyMs < 1000 ? `${testResult.latencyMs}ms` : `${(testResult.latencyMs / 1000).toFixed(1)}s`}`
                : ""}
            </p>
          )}
        </>
      )}
      {configured && (
        <p className="text-[11px] text-gray-400">
          已启用，未命中自动降级到免费引擎
        </p>
      )}
    </div>
  );
}
