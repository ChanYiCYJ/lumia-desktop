/**
 * Windows/远程桌面白屏自愈（借鉴 CherryHQ/cherry-studio 处理 GPU 的成熟做法）：
 * Chromium GPU 进程初始化失败时，部分环境（Windows VM / RDP / 老显卡 / 无 GPU 驱动）
 * 不会干净地回退到软件渲染，窗口会停留全白/全黑 —— 用户反馈「安装完界面没显示」。
 *
 * 策略（默认硬件加速，仅异常时降级，健康机器零影响）：
 *  - 启动时若持久化标记为 soft（上次 GPU 异常）→ 强制软件渲染（app.disableHardwareAcceleration）。
 *  - 本次以 GPU 模式启动时，监听 GPU 子进程：启动 20s 内异常退出 → 写标记并带软渲重启一次。
 *  - 手动覆盖：`--disable-gpu` 或环境变量 `LUMIA_DISABLE_GPU=1` 强制软件；`--gpu` 强制硬件并清标记。
 * ponytail: 用「异常退出一次即重启」的朴素启发式标记坏环境，天花板=个别自恢复环境会多重启一次；
 * 升级路径=后续加设置项让用户手动切（Cherry 即为设置项+relaunch）。
 */
import { app } from 'electron'
import { storageGet, storageSet } from './core/store'

const COMPAT_KEY = 'window-gpu-compat' // 'gpu' | 'soft'
const STARTUP_WINDOW_MS = 20_000

function storedMode(): string {
  return storageGet(COMPAT_KEY) === 'soft' ? 'soft' : 'gpu'
}

/** 本次是否强制软件渲染（须在 app ready 前调用以生效） */
export function shouldForceSoftware(): boolean {
  if (process.env.LUMIA_DISABLE_GPU === '1') return true
  if (process.argv.includes('--disable-gpu')) return true
  if (process.argv.includes('--gpu')) {
    storageSet(COMPAT_KEY, 'gpu') // 显式要求硬件 → 清标记
    return false
  }
  return storedMode() === 'soft'
}

/** 须在 app.whenReady() 之前调用：按需关闭硬件加速 */
export function applyGpuCompat(): void {
  if (shouldForceSoftware()) {
    app.disableHardwareAcceleration()
    console.log('[lumia] 软件渲染模式（硬件加速已关闭）')
  }
}

/** 在 app ready、窗口创建前调用：GPU 启动异常时自动软渲重启 */
export function watchGpuCompat(): void {
  if (shouldForceSoftware()) return // 已是软渲，无需再观察
  const since = Date.now()
  let relaunched = false
  app.on('child-process-gone', (_event, details) => {
    if (relaunched || details.type !== 'GPU' || details.reason === 'clean-exit') return
    if (Date.now() - since > STARTUP_WINDOW_MS) return
    relaunched = true
    storageSet(COMPAT_KEY, 'soft')
    console.warn(`[lumia] GPU 进程异常退出（${details.reason}），切换到软件渲染并重启`)
    app.relaunch()
    app.exit(0)
  })
}
