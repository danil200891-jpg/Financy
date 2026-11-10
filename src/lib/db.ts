import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Category, Client, HistoryEntry, Operation } from './types'

interface FinanceDB extends DBSchema {
  operations: { key: string; value: Operation; indexes: { date: string } }
  clients: { key: string; value: Client }
  categories: { key: string; value: Category }
  history: { key: string; value: HistoryEntry; indexes: { entityId: string; at: string } }
  meta: { key: string; value: unknown }
}

export type StoreName = 'operations' | 'clients' | 'categories'

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
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))])
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
export const DB_VERSION = 1

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
        // if (oldVersion < 2) { … next migration … }
      },
    })
}

export async function loadAll() {
  const d = await db()
  const [operations, clients, categories, initialized] = await Promise.all([
    d.getAll('operations'),
    d.getAll('clients'),
    d.getAll('categories'),
    d.get('meta', 'initialized'),
  ])
  return { operations, clients, categories, initialized: !!initialized }
}

/** Read one committed snapshot, including its history, in a single transaction. */
export async function backupSnapshot() {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'history'])
  const [operations, clients, categories, history] = await Promise.all([
    tx.objectStore('operations').getAll(),
    tx.objectStore('clients').getAll(),
    tx.objectStore('categories').getAll(),
    tx.objectStore('history').getAll(),
  ])
  await tx.done
  return { operations, clients, categories, history }
}

/** Writes records and their history entries in one transaction so they never diverge. */
export async function commit(
  puts: { store: StoreName; value: Operation | Client | Category }[],
  history: HistoryEntry[] = [],
) {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'history'], 'readwrite')
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
}) {
  const d = await db()
  const tx = d.transaction(['operations', 'clients', 'categories', 'history'], 'readwrite')
  try {
    await Promise.all(['operations', 'clients', 'categories', 'history'].map((s) => tx.objectStore(s as 'history').clear()))
    for (const o of data.operations) await tx.objectStore('operations').put(o)
    for (const c of data.clients) await tx.objectStore('clients').put(c)
    for (const c of data.categories) await tx.objectStore('categories').put(c)
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
