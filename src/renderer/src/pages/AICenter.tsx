import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { pageApi } from "../lib/api";
import { AI_CHAT_MARKER, decodeKey, type AIChatConfig } from "../lib/types";
import { useAuth } from "../lib/auth";
import { useSite } from "../lib/site";
import { TypeWriter } from "../components/Spinner";
import { AIChat, type BotItem } from "../components/AIChat";

/** 解析 AI 页面 → BotItem */
function parseBot(p: {
  id: number;
  name: string;
  content: string | null;
  type: string;
}): BotItem | null {
  if (p.type !== "html" || !p.content?.startsWith(AI_CHAT_MARKER)) return null;
  try {
    const raw = JSON.parse(
      p.content.slice(AI_CHAT_MARKER.length),
    ) as AIChatConfig;
    const config: AIChatConfig = { ...raw, apiKey: decodeKey(raw.apiKey) };
    return { id: p.id, name: p.name, config, page: p as BotItem["page"] };
  } catch {
    return null;
  }
}

export function AICenter() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { settings } = useSite();
  const [bots, setBots] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadBots = useCallback(async () => {
    try {
      const pages = await pageApi.list();
      const items = pages.map(parseBot).filter((b): b is BotItem => !!b);
      setBots(items);
      // 写入 AI 机器人注册表（后台「AI 改写」选择）与首个配置缓存
      try {
        localStorage.setItem(
          "kimo_ai_bots",
          JSON.stringify(
            items.map((b) => ({
              id: b.id,
              endpoint: b.config.endpoint,
              apiKey: b.config.apiKey,
              model: b.config.model,
            })),
          ),
        );
        localStorage.setItem(
          "kimo_ai_bot_config",
          JSON.stringify({
            endpoint: items[0]?.config.endpoint,
            apiKey: items[0]?.config.apiKey,
            model: items[0]?.config.model,
            enabled: true,
          }),
        );
      } catch {
        /* 忽略 */
      }
    } catch {
      setBots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBots();
  }, [loadBots]);

  const active = bots.find((b) => b.id === Number(botId)) || bots[0];

  const switchBot = useCallback(
    (id: number) => navigate(`/ai/${id}`),
    [navigate],
  );

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-white dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <TypeWriter
            text="Think Different"
            className="text-xl font-medium tracking-[0.2em] text-gray-500 dark:text-gray-400"
          />
          <p className="font-mono text-xs text-gray-300 dark:text-gray-600">
            $ loading ...
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {active ? (
        <AIChat
          key={active.id}
          center
          config={active.config}
          pageId={active.id}
          bots={bots}
          onSwitchBot={switchBot}
          canManage={isAdmin}
          onManage={() => navigate("/dashboard/ai")}
          enableArticles={settings.enable_ai_articles === "1"}
          enableCustomApi={settings.enable_custom_api !== "0"}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-white p-8 text-center dark:bg-gray-900">
          <span className="grid h-16 w-16 place-content-center rounded-full bg-gray-100 text-2xl font-bold text-gray-400 dark:bg-gray-800">
            AI
          </span>
          <p className="text-base font-medium text-gray-700 dark:text-gray-300">
            还没有配置 AI 助手
          </p>
          <p className="max-w-sm text-sm text-gray-400">
            管理员可以到后台「AI 管理」创建 AI
            助手；普通访客请等待管理员配置，或在自己的浏览器中配置模型 API。
          </p>
          {isAdmin && (
            <Link
              to="/dashboard/ai"
              className="mt-2 rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
            >
              管理 AI 助手
            </Link>
          )}
        </div>
      )}
    </>
  );
}
