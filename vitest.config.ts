import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000/'
      }
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // vitest 4 + jsdom 30: localStorage 需 setup polyfill（沿用 lumia-frontend 方案）
    setupFiles: ['src/renderer/src/test-setup.ts']
  }
})
