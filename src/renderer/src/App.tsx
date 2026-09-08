import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { SiteProvider } from "./lib/site";
import { ToastProvider } from "./lib/toast";
import { AICenter } from "./pages/AICenter";

// Lumia Desktop：仅保留 Agent 中心（/ai），其余一律重定向
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SiteProvider>
          <ToastProvider>
            <Routes>
              <Route path="/" element={<Navigate to="/ai" replace />} />
              <Route path="/ai" element={<AICenter />} />
              <Route path="/ai/:botId" element={<AICenter />} />
              <Route path="*" element={<Navigate to="/ai" replace />} />
            </Routes>
          </ToastProvider>
        </SiteProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
