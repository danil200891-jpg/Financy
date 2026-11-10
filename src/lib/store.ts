import { useSyncExternalStore } from 'react'
import type { Category, Client, EntityKind, HistoryAction, HistoryEntry, Operation } from './types'
import { buildDemoOperations, demoCategories, demoClients } from './demo'
import { normalize } from './parse'
import * as DB from './db'
import { toast } from './toast'
import { toDateInput } from './format'

/**
 * In-memory cache over IndexedDB: reads are synchronous for the UI,
 * every write updates memory first and is persisted (with a history entry) in one IDB transaction.
 * A future sync adapter can hook into `commit` and use updatedAt / deletedAt.
 */
export interface State {
  ready: boolean
  operations: Operation[] // live, sorted by date desc
  deleted: Operation[] // tombstoned, newest deletion first
  clients: Client[]
  categories: Category[]
  /** every record including tombstones — used for backup */
  all: { operations: Operation[]; clients: Client[]; categories: Category[] }
}

const live = <T extends { deletedAt?: string | null }>(xs: T[]) => xs.filter((x) => !x.deletedAt)
const byDate = (a: Operation, b: Operation) => Date.parse(b.date) - Date.parse(a.date)

function derive(all: State['all']): State {
  return {
    ready: true,
    all,
    operations: live(all.operations).sort(byDate),
    deleted: all.operations.filter((o) => o.deletedAt).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
    clients: live(all.clients),
    categories: live(all.categories).sort((a, b) => catRank(a) - catRank(b) || (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '')),
  }
}

const DEFAULT_ORDER = demoCategories.map((c) => c.id)
const catRank = (c: Category) => {
  const i = DEFAULT_ORDER.indexOf(c.id)
  return i < 0 ? 1000 : i
}

let state: State = { ready: false, operations: [], deleted: [], clients: [], categories: [], all: { operations: [], clients: [], categories: [] } }

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const setAll = (all: State['all']) => {
  state = derive(all)
  emit()
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(state),
  )
}

export const getState = () => state

export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const nowIso = () => new Date().toISOString()

const STORE: Record<EntityKind, DB.StoreName> = { operation: 'operations', client: 'clients', category: 'categories' }

function hist(entity: EntityKind, entityId: string, action: HistoryAction, before?: unknown, after?: unknown): HistoryEntry {
  return { id: uid('h'), entity, entityId, action, at: nowIso(), before, after }
}

const pendingWrites = new Set<Promise<void>>()
type Put = { store: DB.StoreName; value: Operation | Client | Category }

/** Let forms acknowledge success only after their IndexedDB transactions finish. */
export async function waitForWrites() {
  while (pendingWrites.size) await Promise.all([...pendingWrites])
}

function writeBatch(puts: Put[], history: HistoryEntry[]) {
  const before = state.all
  const maps = new Map<DB.StoreName, Map<string, Put['value']>>()
  for (const put of puts) {
    if (!maps.has(put.store)) maps.set(put.store, new Map(before[put.store].map((value) => [value.id, value])))
    maps.get(put.store)!.set(put.value.id, put.value)
  }
  let next = { ...before }
  for (const [store, records] of maps) next = { ...next, [store]: [...records.values()] }
  setAll(next)
  const saved = DB.commit(puts, history).catch(() => {
    // Revert this failed write without overwriting a later edit to the same record.
    let rolledBack = { ...state.all }
    for (const store of maps.keys()) {
      const records = new Map<string, Put['value']>(state.all[store].map((value) => [value.id, value]))
      for (const put of puts.filter((item) => item.store === store)) {
        if (records.get(put.value.id) !== put.value) continue
        const previous = before[store].find((value) => value.id === put.value.id)
        if (previous) records.set(previous.id, previous)
        else records.delete(put.value.id)
      }
      rolledBack = { ...rolledBack, [store]: [...records.values()] }
    }
    setAll(rolledBack)
    const error = new Error('Не удалось сохранить на устройстве. Проверьте свободное место и повторите.')
    toast(error.message)
    throw error
  })
  pendingWrites.add(saved)
  void saved.then(() => { pendingWrites.delete(saved) }, () => { pendingWrites.delete(saved) })
}

/** Preserve the synchronous action API and track its durable completion separately. */
function write<T extends Operation | Client | Category>(entity: EntityKind, records: T[], history: HistoryEntry[]) {
  writeBatch(records.map((value) => ({ store: STORE[entity], value })), history)
}

export async function initStore() {
  // never block startup on persist(): on some iOS versions its promise settles late or never
  void DB.requestPersistence()
  const data = await DB.loadAll()
  if (!data.initialized) {
    const t = nowIso()
    const cats = demoCategories.filter((category) => !data.categories.some((existing) => existing.id === category.id)).map((c) => ({ ...c, updatedAt: t }))
    await DB.commit(cats.map((value) => ({ store: 'categories' as const, value })))
    await DB.setMeta('initialized', t)
    data.categories = [...data.categories, ...cats]
  }
  setAll({ operations: data.operations, clients: data.clients, categories: data.categories })
  await migrateIncomeCategories().catch(() => { /* retried on the next start; nothing is lost */ })
}

const INCOME_CATEGORIES = ['c-work', 'c-other-in', 'c-oneoff']

/**
 * One-time, non-destructive switch to the three income categories (Работа, Прочие доходы, Разовый клиент).
 * Other income categories are only hidden (`archived`) — never deleted — so older operations keep
 * showing them, and they can be brought back in Настройки → Категории.
 */
async function migrateIncomeCategories() {
  const d = await DB.db()
  if (await d.get('meta', 'incomeCategoriesV2')) return
  const t = nowIso()
  const puts: Category[] = []
  const history: HistoryEntry[] = []
  const change = (before: Category | undefined, after: Category) => {
    puts.push(after)
    history.push(hist('category', after.id, before ? 'update' : 'create', before, after))
  }
  for (const c of state.all.categories) {
    if (c.type !== 'income' || c.deletedAt) continue
    if (!INCOME_CATEGORIES.includes(c.id) && !c.archived) change(c, { ...c, archived: true, updatedAt: t })
    else if (c.id === 'c-other-in' && c.name === 'Прочий доход') change(c, { ...c, name: 'Прочие доходы', updatedAt: t })
  }
  for (const id of INCOME_CATEGORIES) {
    if (state.all.categories.some((c) => c.id === id)) continue
    const def = demoCategories.find((c) => c.id === id)
    if (def) change(undefined, { ...def, updatedAt: t, deletedAt: null })
  }
  if (puts.length) write('category', puts, history)
  await waitForWrites()
  await DB.setMeta('incomeCategoriesV2', t)
}

/** Client names compare without case, «ё» and extra spaces — «  mvp » and «MVP» are the same client. */
export function findClientByName(name: string) {
  const key = normalize(name)
  if (!key) return undefined
  return state.clients.find((c) => normalize(c.name) === key || c.aliases?.some((a) => normalize(a) === key))
}

export type OperationDraft = Omit<Operation, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

/** Fingerprint used for duplicate detection: same day, type, amount and title. */
export const fingerprint = (o: Pick<Operation, 'date' | 'type' | 'amount' | 'title'> & Partial<Pick<Operation, 'currency'>>) =>
  `${toDateInput(o.date)}|${o.type}|${o.amount}|${(o.currency ?? 'EUR').toUpperCase()}|${normalize(o.title)}`

export function findDuplicate(d: OperationDraft, ignoreId?: string) {
  const fp = fingerprint(d)
  return state.operations.find((o) => o.id !== ignoreId && fingerprint(o) === fp)
}

export const actions = {
  addOperation(d: OperationDraft) {
    const t = nowIso()
    const op: Operation = { ...d, id: uid('op'), createdAt: t, updatedAt: t, deletedAt: null }
    write('operation', [op], [hist('operation', op.id, 'create', undefined, op)])
    return op
  },
  updateOperation(id: string, patch: Partial<OperationDraft>) {
    const before = state.all.operations.find((o) => o.id === id)
    if (!before) return
    const after = { ...before, ...patch, updatedAt: nowIso() }
    write('operation', [after], [hist('operation', id, 'update', before, after)])
  },
  removeOperation(id: string) {
    const before = state.all.operations.find((o) => o.id === id)
    if (!before) return
    const t = nowIso()
    const after = { ...before, deletedAt: t, updatedAt: t }
    write('operation', [after], [hist('operation', id, 'delete', before, after)])
    toast(`«${before.title}» удалена`, { label: 'Вернуть', run: () => actions.restoreOperation(id) })
  },
  restoreOperation(id: string) {
    const before = state.all.operations.find((o) => o.id === id)
    if (!before) return
    const after = { ...before, deletedAt: null, updatedAt: nowIso() }
    write('operation', [after], [hist('operation', id, 'restore', before, after)])
  },
  async purgeDeleted() {
    const ids = state.deleted.map((o) => o.id)
    await DB.hardDelete('operations', ids)
    setAll({ ...state.all, operations: state.all.operations.filter((o) => !ids.includes(o.id) || !o.deletedAt) })
  },

  /** Returns the existing client instead of creating a duplicate that differs only in case or spaces. */
  addClient(name: string, color: string) {
    const existing = findClientByName(name)
    if (existing) return existing
    const t = nowIso()
    const c: Client = { id: uid('cl'), name: name.trim().replace(/\s+/g, ' '), aliases: [], color, createdAt: t, updatedAt: t, deletedAt: null }
    write('client', [c], [hist('client', c.id, 'create', undefined, c)])
    return c
  },
  updateClient(id: string, patch: Partial<Client>) {
    const before = state.all.clients.find((c) => c.id === id)
    if (!before) return
    const after = { ...before, ...patch, updatedAt: nowIso() }
    write('client', [after], [hist('client', id, 'update', before, after)])
  },
  /** Client goes away; its operations stay as one-off income. */
  removeClient(id: string) {
    const before = state.all.clients.find((c) => c.id === id)
    if (!before) return
    const t = nowIso()
    const after = { ...before, deletedAt: t, updatedAt: t }
    const ops = state.all.operations.filter((o) => o.clientId === id)
    const opsAfter = ops.map((o) => ({ ...o, clientId: null, updatedAt: t }))
    writeBatch([
      { store: 'clients', value: after },
      ...opsAfter.map((value) => ({ store: 'operations' as const, value })),
    ], [hist('client', id, 'delete', before, after), ...ops.map((o, i) => hist('operation', o.id, 'update', o, opsAfter[i]))])
  },

  addCategory(c: Omit<Category, 'id'>) {
    const cat: Category = { ...c, id: uid('c'), updatedAt: nowIso(), deletedAt: null }
    write('category', [cat], [hist('category', cat.id, 'create', undefined, cat)])
    return cat
  },
  updateCategory(id: string, patch: Partial<Omit<Category, 'id'>>) {
    const before = state.all.categories.find((c) => c.id === id)
    if (!before) return
    const after = { ...before, ...patch, updatedAt: nowIso() }
    write('category', [after], [hist('category', id, 'update', before, after)])
  },
  removeCategory(id: string) {
    const before = state.all.categories.find((c) => c.id === id)
    if (!before) return
    const t = nowIso()
    const after = { ...before, deletedAt: t, updatedAt: t }
    const ops = state.all.operations.filter((o) => o.categoryId === id)
    const opsAfter = ops.map((o) => ({ ...o, categoryId: null, updatedAt: t }))
    writeBatch([
      { store: 'categories', value: after },
      ...opsAfter.map((value) => ({ store: 'operations' as const, value })),
    ], [hist('category', id, 'delete', before, after), ...ops.map((o, i) => hist('operation', o.id, 'update', o, opsAfter[i]))])
  },

  /** Adds demo clients and operations so the app can be explored. */
  loadDemo() {
    const t = nowIso()
    const clients = demoClients.filter((c) => !state.all.clients.some((x) => x.id === c.id)).map((c) => ({ ...c, updatedAt: t, deletedAt: null }))
    const cats = demoCategories.filter((c) => !state.categories.some((x) => x.id === c.id)).map((c) => ({ ...c, updatedAt: t, deletedAt: null }))
    const ops = buildDemoOperations().filter((o) => !findDuplicate(o)).map((o) => ({ ...o, source: 'import' as const, deletedAt: null }))
    if (cats.length) write('category', cats, [])
    if (clients.length) write('client', clients, [])
    write('operation', ops, [])
    return ops.length
  },

  async wipeAll() {
    await waitForWrites()
    const t = nowIso()
    const cats = demoCategories.map((c) => ({ ...c, updatedAt: t, deletedAt: null }))
    await DB.replaceAll({ operations: [], clients: [], categories: cats, history: [] })
    setAll({ operations: [], clients: [], categories: cats })
  },

  /** Used by backup restore after the DB was rewritten. */
  async reload() {
    const data = await DB.loadAll()
    setAll({ operations: data.operations, clients: data.clients, categories: data.categories })
  },
}
