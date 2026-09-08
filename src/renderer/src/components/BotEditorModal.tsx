import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pageApi } from "../lib/api";
import { AI_CHAT_MARKER, encodeKey, type AIChatConfig } from "../lib/types";
import {
  PROMPT_PRESETS,
  fillPrompt,
  defaultSystemPrompt,
} from "../lib/promptPresets";
import type { BotItem } from "./AIChat";

interface BotEditorModalProps {
  open: boolean;
  onClose: () => void;
  bot: BotItem | null;
  onSaved: () => void;
  /** bot 为 null（新建）时的默认页面名 */
  defaultName?: string;
}

const inputCls =
  "w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800";

export function BotEditorModal({
  open,
  onClose,
  bot,
  onSaved,
  defaultName = "",
}: BotEditorModalProps) {
  const [name, setName] = useState("");
  const [botName, setBotName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxMessages, setMaxMessages] = useState("");
  const [cooldown, setCooldown] = useState("");
  const [autoTTS, setAutoTTS] = useState(false);
  const [adminOnly, setAdminOnly] = useState(false);
  const [dailyLimit, setDailyLimit] = useState("");
  const [prompts, setPrompts] = useState<
    { name: string; systemPrompt: string }[]
  >([]);
  const [presetId, setPresetId] = useState("");
  const importMdRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setShowKey(false);
    setPresetId("");
    if (bot) {
      const c = bot.config;
      setName(bot.name);
      setBotName(c.botName || "");
      setAvatar(c.avatar || "");
      setModel(c.model || "");
      setEndpoint(c.endpoint || "");
      setApiKey(c.apiKey || "");
      setSystemPrompt(c.systemPrompt || "");
      setMaxMessages(c.maxMessages ? String(c.maxMessages) : "");
      setCooldown(c.cooldown ? String(c.cooldown) : "");
      setAutoTTS(!!c.autoTTS);
      setAdminOnly(!!c.adminOnly);
      setDailyLimit(c.dailyLimit ? String(c.dailyLimit) : "");
      setPrompts(c.prompts ? [...c.prompts] : []);
    } else {
      setName(defaultName);
      setBotName("");
      setAvatar("");
      setModel("gpt-4o-mini");
      setEndpoint("https://api.openai.com/v1");
      setApiKey("");
      setSystemPrompt("你是一个友好、专业的 AI 助手，请用简体中文回答。");
      setMaxMessages("");
      setCooldown("");
      setAutoTTS(false);
      setAdminOnly(false);
      setDailyLimit("");
      setPrompts([]);
    }
  }, [open, bot, defaultName]);

  // 应用提示词模板预设（自我进化 AI / 通用助手）
  const applyPreset = (id: string) => {
    const preset = PROMPT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const next = fillPrompt(preset.systemPrompt, {
      botName: botName.trim() || "AI",
      ownerName: "站长",
    });
    if (
      systemPrompt.trim() &&
      !window.confirm("应用该模板将替换当前系统提示词，继续？")
    ) {
      setPresetId("");
      return;
    }
    setSystemPrompt(next);
    setPresetId(id);
  };

  // 导入 .md 文件作为系统提示词（追加到末尾，不覆盖已有内容）
  const onImportMd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result || "").trim();
      if (!text) return;
      setSystemPrompt((prev) =>
        prev.trim() ? prev + "\n\n---\n\n" + text : text,
      );
      setPresetId("");
    };
    r.readAsText(f);
    e.target.value = "";
  };

  const save = async () => {
    if (
      !name.trim() ||
      !botName.trim() ||
      !endpoint.trim() ||
      !apiKey.trim() ||
      !model.trim()
    ) {
      setError("请填写：页面名、AI 名称、接口地址、API Key、模型");
      return;
    }
    setSaving(true);
    setError("");
    const cfg: AIChatConfig = {
      endpoint: endpoint.trim(),
      apiKey: encodeKey(apiKey.trim()),
      model: model.trim(),
      botName: botName.trim(),
      avatar: avatar.trim() || undefined,
      systemPrompt: systemPrompt.trim()
        ? systemPrompt
        : defaultSystemPrompt(botName.trim()),
      maxMessages: maxMessages ? Number(maxMessages) || undefined : undefined,
      cooldown: cooldown ? Number(cooldown) || undefined : undefined,
      autoTTS,
      adminOnly,
      dailyLimit: dailyLimit ? Number(dailyLimit) || undefined : undefined,
      prompts: prompts.length ? prompts : undefined,
    };
    const content = AI_CHAT_MARKER + JSON.stringify(cfg);
    try {
      if (bot) {
        await pageApi.update(bot.id, {
          name: name.trim(),
          content,
          type: "html",
        });
      } else {
        await pageApi.create({
          name: name.trim(),
          content,
          type: "html",
          status: 0,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {bot ? "编辑 AI 助手" : "新建 AI 助手"}
          </h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
            aria-label="关闭"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                页面名（网址用）
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ai-assistant"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                AI 名称
              </label>
              <input
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder="Lumia AI"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              头像 URL（可选）
            </label>
            <input
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="https://..."
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              接口地址
            </label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                模型
              </label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                冷却（秒，可选）
              </label>
              <input
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
                placeholder="0"
                type="number"
                min={0}
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              API Key
            </label>
            <div className="relative">
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type={showKey ? "text" : "password"}
                placeholder="sk-..."
                className={inputCls}
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 transition hover:text-gray-600"
                aria-label="显示/隐藏"
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
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                系统提示词
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <select
                  value={presetId}
                  onChange={(e) => applyPreset(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                >
                  <option value="">自定义模板</option>
                  {PROMPT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.description}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => importMdRef.current?.click()}
                  className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                  title="导入 .md 文件作为系统提示词（追加到末尾）"
                >
                  导入 .md
                </button>
                <input
                  ref={importMdRef}
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  onChange={onImportMd}
                  className="hidden"
                />
              </div>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setPresetId("");
              }}
              rows={5}
              placeholder="选择上方模板快速套用，或导入 .md 文件；留空保存时自动使用「自我进化 AI」模板"
              className={`${inputCls} resize-none`}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              模板下拉可快速套用「通用助手 / 自我进化 AI」；导入的 Markdown
              会追加到提示词末尾。
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              最大消息数（可选，超出需新建会话）
            </label>
            <input
              value={maxMessages}
              onChange={(e) => setMaxMessages(e.target.value)}
              type="number"
              min={0}
              placeholder="不限"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              每日额度（0=不限，用户每天可发消息数）
            </label>
            <input
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              type="number"
              min={0}
              placeholder="不限"
              className={inputCls}
            />
          </div>
          <div className="space-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                多提示词模板
              </p>
              <button
                onClick={() =>
                  setPrompts([
                    ...prompts,
                    { name: "新模板" + (prompts.length + 1), systemPrompt: "" },
                  ])
                }
                className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-gray-700"
              >
                + 添加
              </button>
            </div>
            {prompts.map((p, i) => (
              <div
                key={i}
                className="rounded-lg border border-gray-100 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-800/50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <input
                    value={p.name}
                    onChange={(e) => {
                      const n = [...prompts];
                      n[i] = { ...n[i], name: e.target.value };
                      setPrompts(n);
                    }}
                    placeholder="模板名称"
                    className="flex-1 min-w-0 rounded border border-gray-200 bg-white px-2 py-0.5 text-xs outline-none dark:border-gray-700 dark:bg-gray-800"
                  />
                  <button
                    onClick={() =>
                      setPrompts(prompts.filter((_, j) => j !== i))
                    }
                    className="shrink-0 text-xs text-red-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  value={p.systemPrompt}
                  onChange={(e) => {
                    const n = [...prompts];
                    n[i] = { ...n[i], systemPrompt: e.target.value };
                    setPrompts(n);
                  }}
                  rows={3}
                  placeholder="该模板的系统提示词"
                  className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs outline-none resize-none dark:border-gray-700 dark:bg-gray-800"
                />
              </div>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoTTS}
              onChange={(e) => setAutoTTS(e.target.checked)}
              className="h-4 w-4 accent-gray-900"
            />
            自动朗读回复
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={adminOnly}
              onChange={(e) => setAdminOnly(e.target.checked)}
              className="h-4 w-4 accent-gray-900"
            />
            仅管理员可使用（普通访客将无法访问此助手）
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
