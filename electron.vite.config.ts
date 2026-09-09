import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    // dev 代理（与 lumia-frontend vite.config.ts 一致）：
    // 后端未启动时 /api 返回 502 → 前端按“网络错误”回退 mock，避免 404 被当成真实错误
    server: {
      proxy: {
        '/api': { target: 'http://localhost:8000', changeOrigin: true },
        '/static': { target: 'http://localhost:8000', changeOrigin: true }
      }
    }
  }
})
