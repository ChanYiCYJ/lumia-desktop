import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./lib/theme";
import { aiChat } from "./lib/ai";
import { getCachedLandingRoute } from "./lib/site";
import { enableSecureStorage, migrateLocalSecrets } from "./lib/secureStorage";
import "./index.css";
import App from "./App";

// 桌面端：API Key/Token 透明加密（safeStorage），先注入再迁移
enableSecureStorage();
migrateLocalSecrets();

// 暴露给自定义 HTML 页面的全局 AI 接口
(window as unknown as Record<string, unknown>).kimoAI = {
  chat: async (msg: string, system?: string) => aiChat(msg, system),
};

// 落地页即时跳转：用本地缓存的 route_map/default_route 同步决定首页去向，
// 在 React 挂载前改写 URL，避免每次访问都先显示"加载中"再重定向到落地页。
// 首次访问（无缓存）时跳过，由 Layout 等待设置加载后正常跳转。
const landingRoute = getCachedLandingRoute(window.location.hostname);
if (landingRoute && landingRoute !== "/" && window.location.pathname === "/") {
  window.history.replaceState(null, "", landingRoute);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
