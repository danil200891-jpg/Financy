import type { PlanningRecord } from './planning-types'
import type { FinancialRecord } from './types'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Category, Client, HistoryEntry, Operation } from './types'

interface FinanceDB extends DBSchema {
  planning: { key: string; value: PlanningRecord }
  operations: { key: string; value: Operation; indexes: { date: string } }
  clients: { key: string; value: Client }
  categories: { key: string; value: Category }
  history: { key: string; value: HistoryEntry; indexes: { entityId: string; at: string } }
  meta: { key: string; value: unknown }
}

export type StoreName = 'operations' | 'clients' | 'categories' | 'planning'

let dbp: Promise<IDBPDatabase<FinanceDB>> | null = null
const changeListeners = new Set<() => void>()

/** Only successful financial transactions trigger automatic backups. */
export function onDataChanged(listener: () => void) {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

function dataChanged() {
  changeListeners.forEach((listener) => listener())
}

/**
 * WebKit bug: on a cold start indexedDB.open() can stay pending forever until the IDB
 * backend "wakes up". Poking indexedDB.databases() until it answers wakes it (same idea as
 * Jake Archibald's safari-14-idb-fix). Harmless on other browsers.
 */
async function idbReady() {
  const isSafari = /Safari\//.test(navigator.userAgent) && !/Chrom(e|ium)\/|Edg\//.test(navigator.userAgent)
  if (!isSafari || !indexedDB.databases) return
  let timer: ReturnType<typeof setInterval> | undefined
  await new Promise<void>((resolve) => {
    let tries = 0
    const poke = () => indexedDB.databases().finally(resolve)
    timer = setInterval(() => (++tries > 30 ? resolve() : poke()), 100)
    poke()
  }).finally(() => clearInterval(timer))
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string) {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function db() {
  if (!dbp)
    dbp = withTimeout(idbReady().then(() => open()), 8000, 'IndexedDB не ответила за 8 секунд').catch((e) => {
      dbp = null
      throw e
    })
  return dbp
}

/**
 * Schema version. RULES for future changes (financial data must survive every app update):
 *  - bump DB_VERSION by 1 and add a new `if (oldVersion < N)` block below;
 *  - never delete/recreate an existing store, never clear data in a migration;
 *  - transform records in place via `tx.objectStore(...)` if a shape changes.
 */
export const DB_VERSION = 2

function open() {
  return openDB<FinanceDB>('finance', DB_VERSION, {
      blocking(_cur, _next, ev) {
        // a newer version of the app was opened in another tab — let it upgrade
        ;(ev.target as IDBDatabase).close()
      },
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('operations', { keyPath: 'id' }).createIndex('date', 'date')
          d.createObjectStore('clients', { keyPath: 'id' })
          d.createObjectStore('categories', { keyPath: 'id' })
          const h = d.createObjectStore('history', { keyPath: 'id' })
          h.createIndex('entityId', 'entityId')
          h.createIndex('at', 'at')
          d.createObjectStore('meta')
        }
        if (oldVersion < 2) d.createObjectStore('planning', { keyPath: 'id' })
      },
    })
}

export async function loadAll() {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'planning', 'meta'])
  const [operations, clients, categories, planning, initialized] = await Promise.all([
    tx.objectStore('operations').getAll(),
    tx.objectStore('clients').getAll(),
    tx.objectStore('categories').getAll(),
    tx.objectStore('planning').getAll(),
    tx.objectStore('meta').get('initialized'),
  ])
  await tx.done
  return { operations, clients, categories, planning, initialized: !!initialized }
}

/** Read one committed snapshot, including its history, in a single transaction. */
export async function backupSnapshot() {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'planning', 'history'])
  const [operations, clients, categories, planning, history] = await Promise.all([
    tx.objectStore('operations').getAll(),
    tx.objectStore('clients').getAll(),
    tx.objectStore('categories').getAll(),
    tx.objectStore('planning').getAll(), tx.objectStore('history').getAll(),
  ])
  await tx.done
  return { operations, clients, categories, planning, history }
}

/** Writes records and their history entries in one transaction so they never diverge. */
export async function commit(
  puts: { store: StoreName; value: FinancialRecord }[],
  history: HistoryEntry[] = [],
) {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'planning', 'history'], 'readwrite')
  try {
    for (const p of puts) await tx.objectStore(p.store).put(p.value as never)
    for (const h of history) await tx.objectStore('history').put(h)
    await tx.done
  } catch (error) {
    // A synchronous DataError does not automatically abort the transaction.
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {})
    throw error
  }
  dataChanged()
}

export async function hardDelete(store: StoreName, ids: string[]) {
  const d = await db()
  const tx = d.transaction(store, 'readwrite')
  for (const id of ids) await tx.store.delete(id)
  await tx.done
  dataChanged()
}

export async function setMeta(key: string, value: unknown) {
  await (await db()).put('meta', value, key)
}

export async function getMeta<T>(key: string) {
  return (await (await db()).get('meta', key)) as T | undefined
}

export async function deleteMeta(key: string) {
  await (await db()).delete('meta', key)
}

export async function historyFor(entityId: string) {
  const list = await (await db()).getAllFromIndex('history', 'entityId', entityId)
  return list.sort((a, b) => b.at.localeCompare(a.at))
}

export async function allHistory() {
  return (await db()).getAll('history')
}

export async function replaceAll(data: {
  operations: Operation[]
  clients: Client[]
  categories: Category[]
  history: HistoryEntry[]
  planning?: PlanningRecord[]
}, snapshot?: { app: string; version: number; exportedAt: string }) {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'planning', 'history', 'meta'], 'readwrite')
  try {
    if (snapshot) {
      const [operations, clients, categories, planning, history] = await Promise.all([
        tx.objectStore('operations').getAll(), tx.objectStore('clients').getAll(),
        tx.objectStore('categories').getAll(), tx.objectStore('planning').getAll(), tx.objectStore('history').getAll(),
      ])
      await tx.objectStore('meta').put({ ...snapshot, operations, clients, categories, planning, history }, 'preRestore')
    }
    await Promise.all(['operations', 'clients', 'categories', ...(data.planning ? ['planning'] : []), 'history'].map((s) => tx.objectStore(s as 'history').clear()))
    for (const o of data.operations) await tx.objectStore('operations').put(o)
    for (const c of data.clients) await tx.objectStore('clients').put(c)
    for (const c of data.categories) await tx.objectStore('categories').put(c)
    for (const r of data.planning ?? []) await tx.objectStore('planning').put(r)
    for (const h of data.history) await tx.objectStore('history').put(h)
    await tx.done
  } catch (error) {
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {})
    throw error
  }
  dataChanged()
}

/** Ask iOS/Safari not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await withTimeout(navigator.storage.persisted(), 3000, 'persisted timeout')))
      await withTimeout(navigator.storage.persist(), 3000, 'persist timeout')
  } catch {
    /* not supported */
  }
}
