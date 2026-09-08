/**
 * 文件 KV 存储（userData/data/*.json）
 * 借鉴 CherryHQ/cherry-studio src/main/data 的「文件化 + 服务化」模式，按本项目
 * 精简为 JSON 文件 KV（每键一文件，便于备份/迁移）。来源：AGPL-3.0
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 键 → 文件名（防路径穿越） */
function fileOf(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(dataDir(), `${safe}.json`)
}

export function storageGet(key: string): unknown {
  const file = fileOf(key)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return undefined
  }
}

export function storageSet(key: string, value: unknown): void {
  const file = fileOf(key)
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
}

export function storageDelete(key: string): void {
  const file = fileOf(key)
  if (existsSync(file)) rmSync(file)
}

/** 返回所有 JSON 键（去扩展名） */
export function storageKeys(): string[] {
  if (!existsSync(dataDir())) return []
  return readdirSync(dataDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
}
