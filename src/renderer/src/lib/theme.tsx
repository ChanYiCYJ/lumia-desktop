import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "auto" | "light" | "dark";
type Theme = "light" | "dark";

interface ThemeContextValue {
  /** 生效主题（auto 时跟随系统） */
  theme: Theme;
  /** 用户选择：auto=跟随系统(默认) / light / dark */
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  mode: "auto",
  setMode: () => {},
  toggle: () => {},
});

// 三态主题存储 key（独立于旧 kimo_theme 亮/暗开关；无此 key 时默认 auto 跟随系统）
const STORAGE_KEY = "kimo_theme_mode";

function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "auto" || v === "light" || v === "dark") return v;
  } catch {}
  return "auto";
}

function systemDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(systemDark);

  // auto 模式：监听系统主题变化，实时跟随
  useEffect(() => {
    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => setSystemIsDark(mq.matches);
      onChange();
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    } catch {
      return;
    }
  }, []);

  const theme: Theme =
    mode === "auto" ? (systemIsDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {}
  }, [theme, mode]);

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggle = useCallback(() => {
    setModeState((m) => {
      const effective: Theme =
        m === "auto" ? (systemIsDark ? "dark" : "light") : m;
      return effective === "dark" ? "light" : "dark";
    });
  }, [systemIsDark]);

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
