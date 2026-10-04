import { BAGGAGE_LOAD_KEY, BAGGAGE_TODO_KEY } from './baggage'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
const SCHEMA_KEY = 'airport-ground-ops:schema-version'

// 装载明细、复核待办上线后，老版本缓存里没有这两张表，且旧行李台账字段不同；
// 只重置行李相关三张表完成一次性迁移，其它模块的本地改动保留。
const CURRENT_SCHEMA = 2
const MIGRATED_MODULES = ['baggage', BAGGAGE_LOAD_KEY, BAGGAGE_TODO_KEY]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function migrate(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next = { ...parsed }
  for (const key of MIGRATED_MODULES) {
    next[key] = clone(SEED_ROWS[key] ?? [])
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
    return fallback
  }
  try {
    let parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
    if (version < CURRENT_SCHEMA) {
      parsed = migrate(parsed)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
      window.localStorage.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
    }
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
