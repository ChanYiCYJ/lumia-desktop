/**
 * 密钥安全存储：Electron safeStorage 加密后以 base64 落盘（userData/data/）。
 * Linux 无 keyring 时 safeStorage 不可用 → 返回 false，调用方降级提示。
 */
import { safeStorage } from 'electron'
import { storageGet, storageSet, storageDelete } from './core/store'

const PREFIX = '_secret_'

export function secretsSet(key: string, value: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const encrypted = safeStorage.encryptString(value).toString('base64')
  storageSet(`${PREFIX}${key}`, encrypted)
  return true
}

export function secretsGet(key: string): string | null {
  const raw = storageGet(`${PREFIX}${key}`)
  if (typeof raw !== 'string' || !raw) return null
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}

export function secretsDelete(key: string): void {
  storageDelete(`${PREFIX}${key}`)
}

/** 同步加密（safeStorage 不可用时返回原文） */
export function safeStorageEncrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.encryptString(value).toString('base64')
  } catch {
    return value
  }
}

/** 同步解密（非密文原样返回，兼容旧数据） */
export function safeStorageDecrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return value
  }
}
