import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { settingApi } from './api'
import { useLocation } from 'react-router-dom'
import type { SiteSettings } from './types'

interface SiteContextValue {
  settings: SiteSettings
  loaded: boolean
  refresh: () => Promise<void>
}

const DEFAULT_SETTINGS: SiteSettings = {
  title: 'Lumia',
  ltitle: '记录技术、生活与思考',
  avatar: '/favicon.svg',
  background: 'https://api.1314.cool/bingimg',
  footer: '© Lumia · Powered by FastAPI + React',
  allow_register: '1',
  show_dashboard: '1',
  show_pages: '1',
  show_ai: '1',
  enable_ai_articles: '0',
  enable_custom_api: '1',
  live2d_enable: '1',
  live2d_model: '001_casual',
  default_route: '',
  route_map: ''
}

// ---- 站点设置本地缓存 ----
// 落地页路由判定依赖 route_map/default_route，而设置需要网络请求才能拿到。
// 把设置缓存到 localStorage，再次访问时可在 React 挂载前同步决定去向，
// 避免每次访问都要先显示"加载中"再跳转。后台保存设置后 refresh() 会更新缓存。
const CACHE_KEY = 'kimo:site_settings:v1'

function loadCached(): SiteSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    // 容错：localStorage 里若被写入字面值 null（JSON.parse("null") → null），
    // 后续 cached.route_map 会抛 TypeError → main.tsx 顶层崩溃 → 整页白屏
    return parsed && typeof parsed === 'object' ? (parsed as SiteSettings) : {}
  } catch {
    return {}
  }
}

function saveCache(s: SiteSettings | null | undefined) {
  if (!s || typeof s !== 'object') return // 不写 null 进缓存
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s))
  } catch {
    /* 忽略：存储满 / 隐私模式 */
  }
}

// 域名 → 落地页路由判定（与 Layout 首页重定向逻辑保持一致）
export function resolveLandingRoute(
  host: string,
  routeMap: string | undefined,
  defaultRoute: string | undefined
): string {
  let route = ''
  // 1) 域名 → 落地页映射表（精确匹配优先，再子域名后缀匹配）
  //    避免 v2.yogofor.top 被父域 yogofor.top 的后缀匹配抢先导致跳到 '/'
  try {
    const map = JSON.parse(routeMap || '{}') as Record<string, string>
    const keys = Object.keys(map)
    const key = keys.find((k) => host === k) || keys.find((k) => host.endsWith('.' + k))
    if (key && map[key]) route = map[key]
  } catch {
    /* route_map 解析失败则跳过 */
  }
  // 2) 回退：默认落地页
  if (!route) route = defaultRoute || ''
  return route
}

// 用本地缓存同步解析当前域名的落地页（供 main.tsx 在 React 挂载前调用）
export function getCachedLandingRoute(host: string): string {
  const cached = loadCached()
  return resolveLandingRoute(host, cached.route_map, cached.default_route)
}

const SiteContext = createContext<SiteContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  refresh: async () => {}
})

export function SiteProvider({ children }: { children: ReactNode }) {
  // 初始值优先用本地缓存，未命中缓存时才会显示"加载中"，避免每次访问都等待网络
  const cached = loadCached()
  const [settings, setSettings] = useState<SiteSettings>({
    ...DEFAULT_SETTINGS,
    ...cached
  })
  const [loaded, setLoaded] = useState<boolean>(Object.keys(cached).length > 0)

  const refresh = useCallback(async () => {
    try {
      const s = await settingApi.all()
      if (s && typeof s === 'object') {
        setSettings({ ...DEFAULT_SETTINGS, ...s })
        saveCache(s)
      }
    } catch {
      /* 忽略，使用默认 */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 同步文档标题（AI 对话页/中心由 AIChat 接管 bot 名称/头像，不覆盖）
  const location = useLocation()
  useEffect(() => {
    if (location.pathname.startsWith('/ai')) return
    document.title = settings.title || 'Kimo'
  }, [settings.title, location.pathname])

  const value = useMemo(() => ({ settings, loaded, refresh }), [settings, loaded, refresh])

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>
}

export function useSite(): SiteContextValue {
  return useContext(SiteContext)
}
