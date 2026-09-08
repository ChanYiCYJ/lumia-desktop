/**
 * 自定义协议：lumia-live2d:// → 主进程代理 bestdori/第三方资源
 * （renderer 无 CORS 限制且 pixi 可直接加载，替代旧 /api/live2d/* 反代）
 */
import { protocol } from 'electron'
import * as engine from './agent/engine.mjs'

export function registerLumiaProtocols(): void {
  protocol.handle('lumia-live2d', async (req) => {
    try {
      const url = new URL(req.url)
      const host = url.hostname // asset | api
      const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const r =
        host === 'proxy'
          ? await engine.live2dProxy(url.searchParams.get('url') || '')
          : await engine.live2dAsset(path, host === 'api')
      if (!r.ok || !r.buffer) {
        return new Response(`lumia-live2d error: ${r.error || 'unknown'}`, {
          status: 502
        })
      }
      return new Response(new Uint8Array(r.buffer), {
        headers: {
          'Content-Type': r.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400'
        }
      })
    } catch (e) {
      return new Response(`lumia-live2d error: ${(e as Error)?.message}`, {
        status: 502
      })
    }
  })
}
