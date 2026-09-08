import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { authApi, getToken, setToken } from './api'
import type { User } from './types'

interface AuthContextValue {
  user: User | null
  loading: boolean
  isAdmin: boolean
  login: (userInfo: string, password: string) => Promise<User>
  register: (username: string, email: string, password: string) => Promise<User>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const USER_KEY = 'kimo_user'

function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readStoredUser())
  const [loading, setLoading] = useState(true)

  // 启动时校验令牌
  useEffect(() => {
    let cancelled = false
    async function validate() {
      const token = getToken()
      if (!token) {
        setLoading(false)
        return
      }
      try {
        const me = await authApi.me()
        if (!cancelled) {
          setUser(me)
          localStorage.setItem(USER_KEY, JSON.stringify(me))
        }
      } catch {
        // 令牌无效则清理
        if (!cancelled) {
          setUser(null)
          setToken(null)
          localStorage.removeItem(USER_KEY)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    validate()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback((u: User) => {
    setUser(u)
    localStorage.setItem(USER_KEY, JSON.stringify(u))
  }, [])

  const login = useCallback(
    async (userInfo: string, password: string) => {
      const res = await authApi.login(userInfo, password)
      setToken(res.access_token)
      persist(res.user)
      return res.user
    },
    [persist],
  )

  const register = useCallback(
    async (username: string, email: string, password: string) => {
      const u = await authApi.register(username, email, password)
      persist(u)
      return u
    },
    [persist],
  )

  const logout = useCallback(() => {
    setUser(null)
    setToken(null)
    localStorage.removeItem(USER_KEY)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAdmin: user?.role === 0,
      login,
      register,
      logout,
    }),
    [user, loading, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
