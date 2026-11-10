import { useSyncExternalStore } from 'react'
import type { Category, Client, EntityKind, HistoryAction, HistoryEntry, Operation } from './types'
import { buildDemoOperations, demoCategories, demoClients } from './demo'
import { normalize } from './parse'
import * as DB from './db'
import { toast } from './toast'

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
const byDate = (a: Operation, b: Operation) => b.date.localeCompare(a.date)

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
const KEY: Record<EntityKind, keyof State['all']> = STORE

function hist(entity: EntityKind, entityId: string, action: HistoryAction, before?: unknown, after?: unknown): HistoryEntry {
  return { id: uid('h'), entity, entityId, action, at: nowIso(), before, after }
}

/** Replace-or-insert records in memory, then persist them with history. */
function write<T extends Operation | Client | Category>(entity: EntityKind, records: T[], history: HistoryEntry[]) {
  const key = KEY[entity]
  const map = new Map((state.all[key] as T[]).map((r) => [r.id, r]))
  for (const r of records) map.set(r.id, r)
  setAll({ ...state.all, [key]: [...map.values()] })
  DB.commit(records.map((value) => ({ store: STORE[entity], value })), history).catch((e) => {
    console.error(e)
    toast('Не удалось сохранить на устройстве. Проверьте свободное место.')
  })
}

export async function initStore() {
  // never block startup on persist(): on some iOS versions its promise settles late or never
  void DB.requestPersistence()
  const data = await DB.loadAll()
  if (!data.initialized) {
    const t = nowIso()
    const cats = demoCategories.map((c) => ({ ...c, updatedAt: t }))
    await DB.commit(cats.map((value) => ({ store: 'categories' as const, value })))
    await DB.setMeta('initialized', t)
    data.categories = cats
  }
  setAll({ operations: data.operations, clients: data.clients, categories: data.categories })
}

export type OperationDraft = Omit<Operation, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

/** Fingerprint used for duplicate detection: same day, type, amount and title. */
export const fingerprint = (o: Pick<Operation, 'date' | 'type' | 'amount' | 'title'>) =>
  `${o.date.slice(0, 10)}|${o.type}|${o.amount}|${normalize(o.title)}`

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
    setAll({ ...state.all, operations: state.all.operations.filter((o) => !o.deletedAt) })
    await DB.hardDelete('operations', ids)
  },

  addClient(name: string, color: string) {
    const t = nowIso()
    const c: Client = { id: uid('cl'), name: name.trim(), aliases: [], color, createdAt: t, updatedAt: t, deletedAt: null }
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
    write('client', [after], [hist('client', id, 'delete', before, after)])
    if (ops.length) write('operation', opsAfter, ops.map((o, i) => hist('operation', o.id, 'update', o, opsAfter[i])))
  },

  addCategory(c: Omit<Category, 'id'>) {
    const cat: Category = { ...c, id: uid('c'), updatedAt: nowIso(), deletedAt: null }
    write('category', [cat], [hist('category', cat.id, 'create', undefined, cat)])
    return cat
  },
  removeCategory(id: string) {
    const before = state.all.categories.find((c) => c.id === id)
    if (!before) return
    const t = nowIso()
    const after = { ...before, deletedAt: t, updatedAt: t }
    const ops = state.all.operations.filter((o) => o.categoryId === id)
    const opsAfter = ops.map((o) => ({ ...o, categoryId: null, updatedAt: t }))
    write('category', [after], [hist('category', id, 'delete', before, after)])
    if (ops.length) write('operation', opsAfter, ops.map((o, i) => hist('operation', o.id, 'update', o, opsAfter[i])))
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
    await DB.replaceAll({ operations: [], clients: [], categories: [], history: [] })
    const t = nowIso()
    const cats = demoCategories.map((c) => ({ ...c, updatedAt: t, deletedAt: null }))
    await DB.commit(cats.map((value) => ({ store: 'categories' as const, value })))
    setAll({ operations: [], clients: [], categories: cats })
  },

  /** Used by backup restore after the DB was rewritten. */
  async reload() {
    const data = await DB.loadAll()
    setAll({ operations: data.operations, clients: data.clients, categories: data.categories })
  },
}
