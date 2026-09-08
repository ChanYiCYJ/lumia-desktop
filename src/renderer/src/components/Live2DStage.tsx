// Live2D 舞台（Agent 面板 Live2D tab 内容）
// 角色即 AI 化身：动作/表情由 AIChat 通过 live2dCore.setEmotion 驱动（AI 根据对话情境控制）。
// 状态角标只放在对话页；本 tab 仅显示角色 + 一个自然的换角色卡片。
import { useEffect, useRef, useState } from "react";
import { useSite } from "../lib/site";
import { Live2DLoading } from "./Live2DLoading";
import {
  attach,
  detach,
  getState,
  loadModel,
  subscribe,
  type Live2dCoreState,
} from "../lib/live2dCore";
import {
  LIVE2D_CHARACTERS,
  LIVE2D_MODEL_AUTO,
  THIRD_PARTY_DEMO_MODEL,
  addCustomModel,
  characterNameOf,
  loadCustomModels,
  loadLive2dModel,
  randomLive2dModel,
  removeCustomModel,
  requestAutoPick,
  resolveLive2dModel,
  saveLive2dModel,
} from "../lib/live2d";
import { loadLore } from "../lib/live2dLore";

/** Live2D 角色设定详情：分项展示世界观/性格/人物资料/朋友关系（深度思考 + 网络搜索生成） */
function LoreDetail() {
  const { settings } = useSite();
  const [core, setCore] = useState<Live2dCoreState>(() => getState());
  useEffect(() => {
    // 用新对象引用触发重渲染：即使 live2dCore state 对象没变（如档案生成完成后的
    // emitLive2dState 通知），也强制 LoreDetail 重渲染重新读 loadLore 显示新档案
    const unsub = subscribe(() => setCore({ ...getState() }));
    return unsub;
  }, []);
  const model = core.modelName || resolveLive2dModel(settings.live2d_model);
  const lore = loadLore(model);
  const name = characterNameOf(model);
  if (!lore) {
    return (
      <div className="px-3 py-3">
        <div className="flex items-center gap-1.5 pb-1.5">
          <span className="text-[11px] font-semibold text-gray-400">
            角色设定
          </span>
        </div>
        <div className="rounded-xl border border-dashed border-gray-200 p-4 text-center dark:border-gray-700">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-300">
            暂无「{name}」的角色设定档案
          </p>
          <p className="mt-1 text-[11px] text-gray-400">
            首次会结合网络搜索与深度思考，自动生成完整的世界观与人物资料
          </p>
        </div>
      </div>
    );
  }
  const rows = (
    [
      ["世界观", lore.world],
      ["性格", lore.personality],
      ["语气", lore.tone],
      ["背景故事", lore.background],
      ["喜好与擅长", lore.likes],
      ["朋友与关系", lore.relations],
      ["资料要点", lore.notes],
    ] as [string, string][]
  ).filter(([, v]) => v && v.trim());
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-1.5 pb-1.5">
        <svg
          className="h-3.5 w-3.5 text-gray-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
        <span className="text-[11px] font-semibold text-gray-400">
          角色设定
        </span>
        <span className="ml-auto truncate text-[10px] text-gray-400">
          {name}
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map(([label, text]) => (
          <div
            key={label}
            className="rounded-lg bg-gray-50/60 px-2.5 py-2 dark:bg-gray-800/40"
          >
            <p className="text-[10px] font-semibold text-gray-400">{label}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-gray-700 dark:text-gray-300">
              {text}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Live2DStage({ enabled = true }: { enabled?: boolean }) {
  const { settings } = useSite();
  const containerRef = useRef<HTMLDivElement>(null);
  const [core, setCore] = useState<Live2dCoreState>(() => getState());
  /** 角色/资料下拉面板开关 */
  const [panelOpen, setPanelOpen] = useState(false);
  /** 下拉面板内容：char=选择角色 / lore=角色资料 */
  const [panelTab, setPanelTab] = useState<"char" | "lore">("char");
  /** 自定义导入模型（localStorage 持久化） */
  const [customs, setCustoms] = useState(() => loadCustomModels());
  const [importOpen, setImportOpen] = useState(false);
  const [importVal, setImportVal] = useState("");
  const [importErr, setImportErr] = useState("");
  /** auto 模式：每次加载/切换都随机一个角色 */
  const [isAuto, setIsAuto] = useState(
    () => loadLive2dModel() === LIVE2D_MODEL_AUTO,
  );
  /** 乐队手风琴展开状态（默认收起，当前角色所在乐队自动展开） */
  const [expandedBands, setExpandedBands] = useState<string[]>([]);
  /** 导入模型帮助说明 */
  const [helpOpen, setHelpOpen] = useState(false);
  const toggleBand = (band: string) =>
    setExpandedBands((prev) =>
      prev.includes(band) ? prev.filter((b) => b !== band) : [...prev, band],
    );
  // 当前角色所在乐队默认展开（其余收起）
  useEffect(() => {
    const c = LIVE2D_CHARACTERS.find((x) => x.model === core.modelName);
    if (c?.band) {
      setExpandedBands((prev) =>
        prev.includes(c.band!) ? prev : [...prev, c.band!],
      );
    }
  }, [core.modelName]);

  // 订阅核心状态（加载/错误，与 AIChat 共享）
  useEffect(() => {
    const unsub = subscribe(() => setCore(getState()));
    return unsub;
  }, []);

  // 挂载 canvas + 首次加载模型；卸载 detach（单例 app 保留避免重载）
  // 依赖含 enabled：关闭再打开（enabled 切换）时重新 attach，否则 canvas 不会挂回容器导致空白
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.offsetParent === null) return; // 隐藏实例（移动 sheet）不初始化
    attach(el);
    const name = resolveLive2dModel(settings.live2d_model);
    const s = getState();
    if (
      s.status === "idle" ||
      s.status === "error" ||
      (s.status === "ready" && s.modelName !== name)
    ) {
      loadModel(name).catch(() => {});
    }
    return () => detach(el);
  }, [settings.live2d_model, enabled]);

  const retry = () => {
    loadModel(resolveLive2dModel(settings.live2d_model)).catch(() => {});
  };

  const doImport = () => {
    const m = importVal.trim();
    if (!m) return;
    const isUrl = /^https?:\/\//i.test(m);
    if (!isUrl && !/^[A-Za-z0-9_]+$/.test(m)) {
      setImportErr(
        "输入 bestdori 模型名（如 026_casual），或粘贴第三方 model.json 网址",
      );
      return;
    }
    setImportErr("");
    // 第三方 URL 用文件名做显示名；bestdori 模型名用原名
    const list = isUrl
      ? addCustomModel(m, (m.split("/").pop() || m).slice(0, 24))
      : addCustomModel(m);
    setCustoms(list);
    setImportVal("");
    setImportOpen(false);
    saveLive2dModel(m);
    loadModel(m)
      .then(() => setIsAuto(false))
      .catch(() => setImportErr("加载失败：网址无效或不是 Cubism2 model.json"));
    setPanelOpen(false);
  };

  // 未开启 Live2D：空态提示（tab 常显，避免空白突兀）
  if (!enabled) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <svg
          className="h-10 w-10 text-gray-200 dark:text-gray-600"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 21a9 9 0 100-18 9 9 0 000 18z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 10h.01M15 10h.01M9 14.5c.9.8 2.2 1.3 3 1.3s2.1-.5 3-1.3"
          />
        </svg>
        <p className="text-sm text-gray-400 dark:text-gray-500">
          Live2D 未开启
        </p>
        <p className="text-xs leading-relaxed text-gray-300 dark:text-gray-600">
          在对话页按{" "}
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            /
          </span>{" "}
          弹窗开启 Live2D 后，AI 会以虚拟形象与你互动
        </p>
      </div>
    );
  }

  // 按乐队分组（换角色列表更清晰）
  const groups = (() => {
    const map = new Map<string, typeof LIVE2D_CHARACTERS>();
    for (const c of LIVE2D_CHARACTERS) {
      const b = c.band || "其他";
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(c);
    }
    return [...map.entries()].map(([band, items]) => ({ band, items }));
  })();

  const pickChar = (model: string) => {
    if (model === LIVE2D_MODEL_AUTO) {
      saveLive2dModel(LIVE2D_MODEL_AUTO);
      loadModel(randomLive2dModel()).catch(() => {}); // 先随机兜底，随后 AIChat 让 AI 按记忆/知识库重新选角
      setIsAuto(true);
      requestAutoPick();
    } else {
      saveLive2dModel(model);
      loadModel(model).catch(() => {});
      setIsAuto(false);
    }
    setPanelOpen(false);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 角色卡片框：圆角 + 渐变底 + 边框，容纳半身 Live2D（下半无腿也不突兀） */}
      <div
        ref={containerRef}
        className="relative m-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-gray-200/60 bg-gradient-to-b from-gray-50 via-gray-100 to-gray-200/60 dark:border-gray-700/60 dark:from-gray-800 dark:via-gray-900 dark:to-gray-950"
      >
        {core.status === "loading" && (
          <Live2DLoading
            text={isAuto ? "正在随机挑选角色…" : "正在加载角色…"}
          />
        )}
        {core.status === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <button
              onClick={retry}
              className="text-xs text-gray-500 underline underline-offset-2 transition hover:text-gray-700"
            >
              加载失败，点击重试
            </button>
          </div>
        )}
        {/* 换角色：悬浮胶囊叠加在 Live2D 画面上（适配角色画面），下拉面板浮在胶囊上方 */}
        <div className="absolute inset-x-0 bottom-6 z-10 flex flex-col items-center px-3">
          {panelOpen && (
            <div className="mb-2 w-full max-w-xs animate-[kpop_0.25s_ease-out] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 backdrop-blur dark:border-gray-700 dark:bg-gray-800/95">
              {/* 头部：选择角色 / 角色资料 分段切换 */}
              <div className="flex gap-1 border-b border-gray-100 p-1.5 dark:border-gray-800">
                <button
                  onClick={() => setPanelTab("char")}
                  className={
                    "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition " +
                    (panelTab === "char"
                      ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-700/40 dark:hover:text-gray-300")
                  }
                >
                  <svg
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
                    />
                  </svg>
                  选择角色
                </button>
                <button
                  onClick={() => setPanelTab("lore")}
                  className={
                    "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition " +
                    (panelTab === "lore"
                      ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-700/40 dark:hover:text-gray-300")
                  }
                >
                  <svg
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                    />
                  </svg>
                  角色资料
                </button>
              </div>
              {panelTab === "char" && (
                <div className="max-h-56 overflow-y-auto p-2">
                  {/* 自动开关行 */}
                  <div className="mb-1 flex items-center justify-between rounded-lg px-1.5 py-1">
                    <span className="text-[11px] font-semibold text-gray-400">
                      自动选角
                    </span>
                    <button
                      onClick={() => pickChar(LIVE2D_MODEL_AUTO)}
                      title="让 AI 按记忆/知识库选角"
                      className={
                        "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition " +
                        (isAuto
                          ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                          : "bg-gray-50 text-gray-500 hover:bg-gray-100 dark:bg-gray-700/60 dark:text-gray-300")
                      }
                    >
                      <svg
                        className="h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.5 12c0 4.142-3.358 7.5-7.5 7.5S4.5 16.142 4.5 12 7.858 4.5 12 4.5M15 3.5l3 3-3 3M18 6.5h-6"
                        />
                      </svg>
                      自动
                    </button>
                  </div>
                  {/* 按乐队分组的角色列表（手风琴，默认收起；当前角色所在乐队展开） */}
                  {groups.map((g) => {
                    const open = expandedBands.includes(g.band);
                    return (
                      <div key={g.band} className="mb-0.5">
                        <button
                          onClick={() => toggleBand(g.band)}
                          className={
                            "flex w-full items-center justify-between rounded-lg px-2 py-2 text-[11px] font-semibold tracking-wide transition " +
                            (open
                              ? "text-gray-600 dark:text-gray-200"
                              : "text-gray-400 hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-200")
                          }
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={
                                "h-3 w-0.5 shrink-0 rounded-full transition " +
                                (open
                                  ? "bg-gray-400 dark:bg-gray-400"
                                  : "bg-gray-200 dark:bg-gray-700")
                              }
                            />
                            <span className="truncate">{g.band}</span>
                          </span>
                          <svg
                            className={
                              "h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform dark:text-gray-600 " +
                              (open ? "rotate-180" : "")
                            }
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                            />
                          </svg>
                        </button>
                        {open &&
                          g.items.map((c) => {
                            const active =
                              c.model === core.modelName && !isAuto;
                            return (
                              <button
                                key={c.model}
                                onClick={() => pickChar(c.model)}
                                title={c.model}
                                className={
                                  "flex w-full items-center rounded-lg py-1.5 pl-3 pr-1.5 text-left text-[11px] transition " +
                                  (active
                                    ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700")
                                }
                              >
                                <span className="truncate">{c.name}</span>
                              </button>
                            );
                          })}
                      </div>
                    );
                  })}
                  {/* 自定义模型导入 */}
                  <div className="relative mt-1 border-t border-gray-100 pt-1 dark:border-gray-800">
                    <div className="flex items-center justify-between px-1.5 py-1">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-300 dark:text-gray-600">
                        自定义
                      </p>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setHelpOpen((v) => !v)}
                          title="导入模型说明"
                          className="grid h-4 w-4 place-items-center rounded-full border border-gray-200 text-[9px] leading-none text-gray-400 transition hover:border-gray-300 hover:text-gray-600 dark:border-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                          ?
                        </button>
                        <button
                          onClick={() => setImportOpen((v) => !v)}
                          className="text-[11px] text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          {importOpen ? "收起" : "+ 导入模型"}
                        </button>
                      </div>
                    </div>
                    {/* 导入说明：bestdori 模型名 / 第三方 model.json 网址两种方式（fixed 居中弹窗，不受下拉 overflow 裁剪） */}
                    {helpOpen && (
                      <div className="mx-1.5 mb-1.5 rounded-xl border border-gray-200 bg-gray-50 p-3 text-[11px] leading-relaxed text-gray-500 animate-[kfade_0.2s_ease-out] dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                            Live2D 模型 = 模型文件 + 贴图
                          </p>
                          <button
                            onClick={() => setHelpOpen(false)}
                            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
                          >
                            ×
                          </button>
                        </div>
                        <div className="mt-2 space-y-1.5">
                          <p>两种导入方式：</p>
                          <p>
                            ① 输入 bestdori 模型名（如{" "}
                            <code className="rounded bg-white/70 px-1 dark:bg-gray-900/60">
                              026_casual
                            </code>
                            、{" "}
                            <code className="rounded bg-white/70 px-1 dark:bg-gray-900/60">
                              001_summer
                            </code>
                            ），自动从 bestdori 拉取模型与贴图，无需上传图片；
                          </p>
                          <p>
                            ② 粘贴任意第三方 Cubism2{" "}
                            <code className="rounded bg-white/70 px-1 dark:bg-gray-900/60">
                              model.json
                            </code>{" "}
                            网址（https://…），自动加载其模型、贴图与动作。
                          </p>
                          <p className="border-t border-gray-200 pt-1.5 text-gray-400 dark:border-gray-700 dark:text-gray-500">
                            感谢开源项目：{" "}
                            <a
                              href="https://github.com/guansss/pixi-live2d-display"
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline dark:text-blue-400"
                            >
                              pixi-live2d-display
                            </a>
                            （渲染引擎）、{" "}
                            <a
                              href="https://www.live2d.com/"
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline dark:text-blue-400"
                            >
                              Live2D Cubism
                            </a>
                            、{" "}
                            <a
                              href="https://bestdori.com/"
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline dark:text-blue-400"
                            >
                              Bestdori
                            </a>
                            （角色模型）、{" "}
                            <a
                              href="https://github.com/nanlingyin/SoulLink_Live2D"
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:underline dark:text-blue-400"
                            >
                              SoulLink_Live2D
                            </a>
                            （表情动作参考）。
                          </p>
                        </div>
                      </div>
                    )}
                    {importOpen && (
                      <div className="px-1.5 pb-1">
                        <div className="flex gap-1">
                          <input
                            value={importVal}
                            onChange={(e) => setImportVal(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") doImport();
                            }}
                            placeholder="模型名 或 model.json 网址"
                            className="min-w-0 flex-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] outline-none focus:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                          />
                          <button
                            onClick={doImport}
                            className="shrink-0 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-600 transition hover:border-gray-300 hover:text-gray-900 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-gray-100"
                          >
                            导入
                          </button>
                        </div>
                        {importErr && (
                          <p className="mt-1 text-[10px] text-red-400">
                            {importErr}
                          </p>
                        )}
                        {/* 内嵌第三方模型来源：一键导入示例（演示第三方导入） */}
                        <button
                          onClick={() => {
                            setImportVal(THIRD_PARTY_DEMO_MODEL);
                            doImport();
                          }}
                          className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-gray-200 px-2 py-1.5 text-[11px] text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/40"
                          title="导入第三方开源示例模型（shizuku 白无垢）"
                        >
                          <svg
                            className="h-3.5 w-3.5 shrink-0"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-3.3 0-8 1.7-8 5v2h16v-2c0-3.3-4.7-5-8-5z"
                            />
                          </svg>
                          一键导入第三方示例模型（shizuku 白无垢）
                        </button>
                      </div>
                    )}
                    {customs.length > 0 && (
                      <div className="pb-1">
                        {customs.map((c) => {
                          const active = c.model === core.modelName && !isAuto;
                          return (
                            <div
                              key={c.model}
                              className={
                                "flex items-center rounded-lg px-1.5 text-[11px] " +
                                (active
                                  ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700")
                              }
                            >
                              <button
                                onClick={() => pickChar(c.model)}
                                title={c.model}
                                className="min-w-0 flex-1 truncate py-1.5 text-left"
                              >
                                {c.name}
                              </button>
                              <button
                                onClick={() => {
                                  setCustoms(removeCustomModel(c.model));
                                  if (core.modelName === c.model) {
                                    loadModel(
                                      resolveLive2dModel(settings.live2d_model),
                                    ).catch(() => {});
                                  }
                                }}
                                className="shrink-0 px-1 text-gray-300 transition hover:text-red-400 dark:text-gray-600"
                                title="删除自定义模型"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {panelTab === "lore" && (
                <div className="max-h-56 overflow-y-auto">
                  <LoreDetail />
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="group flex max-w-full animate-[kfade_0.3s_ease-out] items-center gap-1.5 rounded-full border border-gray-200/80 bg-white/95 px-3 py-2 text-sm text-gray-600 shadow-sm backdrop-blur transition hover:border-gray-300 hover:bg-white hover:shadow active:scale-[0.98] dark:border-gray-700 dark:bg-gray-800/95 dark:text-gray-300"
            title="切换角色 / 角色资料"
          >
            <svg
              className="h-4 w-4 shrink-0 text-gray-400 transition group-hover:text-gray-600 dark:text-gray-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
              />
            </svg>
            {isAuto && (
              <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] leading-none text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                自动
              </span>
            )}
            <svg
              className={
                "h-4 w-4 shrink-0 text-gray-400 transition-transform group-hover:text-gray-600 dark:text-gray-500 " +
                (panelOpen ? "rotate-180" : "")
              }
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
