/**
 * localStorage 透明加密层（桌面端）：
 * - 敏感键（API Key / Notion Token / 机器人注册表）写入时经 Electron safeStorage
 *   加密（enc1: 前缀），读取时自动解密 —— 原有代码读取处零改动。
 * - 非 Electron（浏览器/测试）环境不启用，保持明文（与线上站点行为一致）。
 * - 旧明文数据启动时自动迁移（migrateLocalSecrets）。
 */
import { isNative } from './remote'

const ENC_PREFIX = 'enc1:'

const SENSITIVE_EXACT = new Set([
  'kimo_notion_cfg',
  'kimo_ai_bots',
  'kimo_ai_bot_config',
  'kimo_ai_config',
  'kimo_ai_polish_bot',
  'kimo_token'
])

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_EXACT.has(key) ||
    key.startsWith('kimo_ai_local_') ||
    key.startsWith('kimo_ai_custom_')
  )
}

const origGet = Storage.prototype.getItem
const origSet = Storage.prototype.setItem

function decryptValue(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value
  try {
    return window.api.secretDecryptSync(value.slice(ENC_PREFIX.length))
  } catch {
    return value
  }
}

function encryptValue(value: string): string {
  const enc = window.api.secretEncryptSync(value)
  return enc === value || value.startsWith(ENC_PREFIX) ? value : ENC_PREFIX + enc
}

/** 启动时注入（幂等） */
export function enableSecureStorage(): void {
  if (!isNative()) return
  // 防止热更新/重复调用重复包裹
  if ((Storage.prototype as unknown as Record<string, unknown>).__lumiaPatched) return
  ;(Storage.prototype as unknown as Record<string, unknown>).__lumiaPatched = true

  Storage.prototype.getItem = function (this: Storage, key: string): string | null {
    const v = origGet.call(this, key)
    return isSensitiveKey(key) && v ? decryptValue(v) : v
  } as typeof Storage.prototype.getItem

  Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
    origSet.call(this, key, isSensitiveKey(key) ? encryptValue(value) : value)
  } as typeof Storage.prototype.setItem
}

/** 旧明文 → 加密迁移（读取不受影响，仅回写；幂等） */
export function migrateLocalSecrets(): void {
  if (!isNative()) return
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && isSensitiveKey(k)) keys.push(k)
  }
  for (const k of keys) {
    const raw = localStorage.getItem(k)
    if (!raw || raw.startsWith(ENC_PREFIX)) continue
    const enc = window.api.secretEncryptSync(raw)
    if (enc !== raw) origSet.call(localStorage, k, ENC_PREFIX + enc)
  }
}
