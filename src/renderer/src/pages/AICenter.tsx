import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { pageApi } from '../lib/api'
import { mockApi } from '../lib/mock'
import { AI_CHAT_MARKER, decodeKey, type AIChatConfig } from '../lib/types'
import { useAuth } from '../lib/auth'
import { useSite } from '../lib/site'
import { getAIConfig, saveAIConfig } from '../lib/ai'
import { getLocalCfg, hasLocalCfg } from '../lib/localCfg'
import { TypeWriter } from '../components/Spinner'
import { LocalApiModal } from '../components/LocalApiModal'
import { AIChat, type BotItem } from '../components/AIChat'

/** 桌面端本地回退：无后端时用本地模型配置（kimo_ai_bots / 自定义模型）构造 bot */
function localBotFallback(): BotItem[] {
  try {
    const cfg = getAIConfig()
    if (cfg.enabled && cfg.endpoint) {
      const name = cfg.model || 'Lumia 助手'
      return [
        {
          id: 0,
          name,
          config: {
            ...(cfg as unknown as AIChatConfig),
            botName: name
          },
          page: {
            id: 0,
            name,
            content: '',
            type: 'html',
            status: 1
          }
        }
      ]
    }
  } catch {
    /* 忽略 */
  }
  return []
}

/** 解析 AI 页面 → BotItem */
function parseBot(p: {
  id: number
  name: string
  content: string | null
  type: string
}): BotItem | null {
  if (p.type !== 'html' || !p.content?.startsWith(AI_CHAT_MARKER)) return null
  try {
    const raw = JSON.parse(p.content.slice(AI_CHAT_MARKER.length)) as AIChatConfig
    const config: AIChatConfig = { ...raw, apiKey: decodeKey(raw.apiKey) }
    return { id: p.id, name: p.name, config, page: p as BotItem['page'] }
  } catch {
    return null
  }
}

export function AICenter() {
  const { botId } = useParams<{ botId: string }>()
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const { settings } = useSite()
  const [bots, setBots] = useState<BotItem[]>([])
  const [loading, setLoading] = useState(true)
  const [apiModalOpen, setApiModalOpen] = useState(false)

  const loadBots = useCallback(async () => {
    let items: BotItem[] = []
    // 1) 后端 AI 页面（真实来源优先；后端不可用时 pageApi.list 抛错 → 空）
    try {
      const pages = await pageApi.list()
      items = pages.map(parseBot).filter((b): b is BotItem => !!b)
    } catch {
      items = []
    }
    // 2) 桌面端：本地模型配置（kimo_ai_bots / 自定义模型）
    if (!items.length) items = localBotFallback()
    // 3) dev 演示回退：仍无配置时用演示数据（与 web dev 一致）；
    //    打包版不注入假 key 演示 bot，走空态引导页让用户配置真实模型
    if (!items.length && import.meta.env.DEV) {
      try {
        const pages = await mockApi.getPages()
        items = pages.map(parseBot).filter((b): b is BotItem => !!b)
      } catch {
        /* 忽略 */
      }
    }
    setBots(items)
    if (items.length) {
      // 写入 AI 机器人注册表（后台「AI 改写」选择）与首个配置缓存；
      // 无条目时不写，避免覆盖用户已有的本地配置
      try {
        localStorage.setItem(
          'kimo_ai_bots',
          JSON.stringify(
            items.map((b) => ({
              id: b.id,
              endpoint: b.config.endpoint,
              apiKey: b.config.apiKey,
              model: b.config.model
            }))
          )
        )
        localStorage.setItem(
          'kimo_ai_bot_config',
          JSON.stringify({
            endpoint: items[0]?.config.endpoint,
            apiKey: items[0]?.config.apiKey,
            model: items[0]?.config.model,
            enabled: true
          })
        )
      } catch {
        /* 忽略 */
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadBots()
  }, [loadBots])

  const active = bots.find((b) => b.id === Number(botId)) || bots[0]

  const switchBot = useCallback((id: number) => navigate(`/ai/${id}`), [navigate])

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-white dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <TypeWriter
            text="Think Different"
            className="text-xl font-medium tracking-[0.2em] text-gray-500 dark:text-gray-400"
          />
          <p className="font-mono text-xs text-gray-300 dark:text-gray-600">$ loading ...</p>
        </div>
      </div>
    )
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
          onManage={() => navigate('/dashboard/ai')}
          enableArticles={settings.enable_ai_articles === '1'}
          enableCustomApi={settings.enable_custom_api !== '0'}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-white p-8 text-center dark:bg-gray-900">
          <LocalApiModal
            open={apiModalOpen}
            onClose={() => setApiModalOpen(false)}
            pageId={0}
            botName="Lumia AI"
            onSaved={() => {
              // 引导页保存：同时写入全局 AI 配置（kimo_ai_config），
              // 使 localBotFallback/getAIConfig 立即读到 → 刷新后直接进入对话（修复 pageId=0 存错不生效）
              try {
                const cfg = getLocalCfg(0)
                if (hasLocalCfg(0)) {
                  saveAIConfig({
                    endpoint: cfg.endpoint,
                    apiKey: cfg.apiKey,
                    model: cfg.model,
                    enabled: true
                  })
                }
              } catch {
                /* 忽略 */
              }
              void loadBots()
            }}
          />
          <span className="grid h-16 w-16 place-content-center rounded-full bg-gray-100 text-2xl font-bold text-gray-400 dark:bg-gray-800">
            AI
          </span>
          <p className="text-base font-medium text-gray-700 dark:text-gray-300">
            还没有配置 AI 模型
          </p>
          <p className="max-w-sm text-sm text-gray-400">
            桌面版可直接使用本机模型（Ollama / LM Studio）或任意 OpenAI
            兼容接口开始对话；也可到「Agent 工具箱 → 设置 → 模型管理」统一配置。
          </p>
          <button
            onClick={() => setApiModalOpen(true)}
            className="mt-2 rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            配置模型 API
          </button>
        </div>
      )}
    </>
  )
}
