import type { Category, Client, HistoryEntry, Operation } from './types'
import * as DB from './db'
import { actions, fingerprint, getState, waitForWrites } from './store'
import type { EntityKind } from './types'
import { canonical } from './sync/canonical'
import { isPaired } from './sync'

export const BACKUP_APP = 'finance-pwa'
export const BACKUP_VERSION = 1

export interface Backup {
  app: typeof BACKUP_APP
  version: number
  exportedAt: string
  operations: Operation[]
  clients: Client[]
  categories: Category[]
  history: HistoryEntry[]
}

const stamp = () => new Date().toISOString().slice(0, 10)

/** iOS PWAs handle the share sheet better than <a download>; fall back to a download link. */
async function deliver(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return 'downloaded'
}

export async function buildBackup(): Promise<Backup> {
  await waitForWrites()
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ...await DB.backupSnapshot(),
  }
}

export async function exportJSON() {
  const b = await buildBackup()
  const r = await deliver(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }), `finance-backup-${stamp()}.json`)
  if (r !== 'cancelled') await DB.setMeta('lastBackup', b.exportedAt)
  return r
}

export async function getLastBackup() {
  return (await (await DB.db()).get('meta', 'lastBackup')) as string | undefined
}

const csvCell = (v: string, column: number) => {
  const safe = column >= 5 && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function buildCSV() {
  const { operations, categories, clients } = getState()
  const head = ['Дата', 'Время', 'Тип', 'Сумма', 'Валюта', 'Название', 'Категория', 'Клиент', 'Заметка']
  const rows = operations.map((o) => {
    const d = new Date(o.date)
    const p = (n: number) => String(n).padStart(2, '0')
    return [
      `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`,
      `${p(d.getHours())}:${p(d.getMinutes())}`,
      o.type === 'income' ? 'Доход' : 'Расход',
      ((o.type === 'income' ? 1 : -1) * o.amount / 100).toFixed(2).replace('.', ','),
      o.currency,
      o.title,
      categories.find((c) => c.id === o.categoryId)?.name ?? '',
      clients.find((c) => c.id === o.clientId)?.name ?? '',
      o.note ?? '',
    ].map(csvCell).join(';')
  })
  // BOM so Excel / Numbers detect UTF-8; ";" separator suits comma-decimal locales
  return '﻿' + [head.join(';'), ...rows].join('\r\n')
}

export async function exportCSV() {
  await waitForWrites()
  return deliver(new Blob([buildCSV()], { type: 'text/csv;charset=utf-8' }), `finance-operations-${stamp()}.csv`)
}

/* ---------------- restore ---------------- */

export async function getPreRestore() {
  return (await (await DB.db()).get('meta', 'preRestore')) as Backup | undefined
}

export async function undoRestore() {
  const b = await getPreRestore()
  if (!b) return false
  if (isPaired()) {
    // with a PC connected the undo must travel as normal edits, otherwise the next sync would bring the restored state back
    await applyAsEdits(b, true)
    await (await DB.db()).delete('meta', 'preRestore')
    return true
  }
  await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history })
  await (await DB.db()).delete('meta', 'preRestore')
  await actions.reload()
  return true
}

const isStr = (v: unknown): v is string => typeof v === 'string'

function validOp(o: Operation) {
  const optionalDate = (value: unknown) => value == null || (isStr(value) && Number.isFinite(Date.parse(value)))
  return o && isStr(o.id) && o.id.length > 0 && (o.type === 'income' || o.type === 'expense')
    && Number.isSafeInteger(o.amount) && o.amount > 0 && isStr(o.title) && isStr(o.date) && Number.isFinite(Date.parse(o.date))
    && (o.note === undefined || isStr(o.note)) && (o.clientId == null || isStr(o.clientId)) && (o.categoryId == null || isStr(o.categoryId))
    && (o.source === undefined || ['manual', 'camera', 'upload', 'import'].includes(o.source))
    && (o.incomeKind === undefined || ['work', 'shoot', 'oneoff'].includes(o.incomeKind))
    && optionalDate(o.createdAt) && optionalDate(o.updatedAt) && optionalDate(o.deletedAt)
}

export function parseBackup(text: string): Backup {
  let raw: Backup
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Файл не похож на JSON. Выберите файл finance-backup-….json')
  }
  if (raw?.app !== BACKUP_APP || !Array.isArray(raw.operations)) throw new Error('Это не резервная копия Finance.')
  if (raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version < 1)) throw new Error('Некорректная версия резервной копии.')
  if (raw.version > BACKUP_VERSION) throw new Error('Копия создана более новой версией приложения. Обновите приложение.')
  const bad = raw.operations.filter((o) => !validOp(o)).length
  if (bad) throw new Error(`В копии ${bad} повреждённых операций. Восстановление отменено, данные не изменены.`)
  if ([raw.clients, raw.categories, raw.history].some((records) => records !== undefined && !Array.isArray(records))) throw new Error('В копии повреждён список записей. Восстановление отменено.')
  const clients = Array.isArray(raw.clients) ? raw.clients : []
  const categories = Array.isArray(raw.categories) ? raw.categories : []
  const history = Array.isArray(raw.history) ? raw.history : []
  const badClient = clients.some((c) => !c || !isStr(c.id) || !isStr(c.name) || (c.aliases !== undefined && (!Array.isArray(c.aliases) || c.aliases.some((alias) => !isStr(alias)))))
  const badCategory = categories.some((c) => !c || !isStr(c.id) || !isStr(c.name) || !['income', 'expense'].includes(c.type))
  const badHistory = history.some((h) => !h || !isStr(h.id) || !isStr(h.entityId) || !['operation', 'client', 'category'].includes(h.entity) || !['create', 'update', 'delete', 'restore'].includes(h.action) || !isStr(h.at) || !Number.isFinite(Date.parse(h.at)))
  const duplicateIds = [raw.operations, clients, categories, history].some((records) => new Set(records.map((record) => record?.id)).size !== records.length)
  if (badClient || badCategory || badHistory || duplicateIds) throw new Error('В копии повреждены записи или повторяются ID. Восстановление отменено, данные не изменены.')
  if (raw.operations.some((o) => o.currency !== undefined && (!isStr(o.currency) || !/^[A-Za-z]{3}$/.test(o.currency)))) throw new Error('В копии указана некорректная валюта.')
  return {
    ...raw,
    version: raw.version ?? 1,
    operations: raw.operations.map((o) => ({ ...o, currency: o.currency ?? 'EUR', source: o.source ?? 'import', createdAt: o.createdAt ?? o.date, updatedAt: o.updatedAt ?? o.createdAt ?? o.date })),
    clients: clients.map((c) => ({ ...c, aliases: c.aliases ?? [], color: c.color ?? '#7c8cff' })),
    categories,
    history,
  }
}

export interface RestoreSummary {
  added: number
  updated: number
  skippedDuplicates: number
  clients: number
  categories: number
}

const newer = <T extends { updatedAt?: string }>(a: T, b?: T) => !b || (a.updatedAt ?? '') > (b.updatedAt ?? '')

/** Merge: by id, newer updatedAt wins; records with a new id but the same fingerprint are skipped as duplicates. */
export async function restore(b: Backup, mode: 'merge' | 'replace'): Promise<RestoreSummary> {
  await waitForWrites()
  if (mode === 'replace' && isPaired()) {
    await DB.setMeta('preRestore', await buildBackup())
    const r = await applyAsEdits(b, true)
    return { added: r.restored, updated: r.changed, skippedDuplicates: 0, clients: b.clients.filter((c) => !c.deletedAt).length, categories: b.categories.filter((c) => !c.deletedAt).length }
  }
  if (mode === 'replace') {
    await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history }, { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString() })
    await actions.reload()
    return {
      added: b.operations.filter((o) => !o.deletedAt).length, updated: 0, skippedDuplicates: 0,
      clients: b.clients.filter((c) => !c.deletedAt).length, categories: b.categories.filter((c) => !c.deletedAt).length,
    }
  }

  await DB.setMeta('preRestore', await buildBackup())

  const { all } = getState()
  const opById = new Map(all.operations.map((o) => [o.id, o]))
  // Only compare with records already on this device. Distinct IDs in one backup
  // may represent intentional identical payments and must survive the transfer.
  const fps = new Set(all.operations.filter((o) => !o.deletedAt).map(fingerprint))
  const sum: RestoreSummary = { added: 0, updated: 0, skippedDuplicates: 0, clients: 0, categories: 0 }
  const ops: Operation[] = []
  for (const o of b.operations) {
    const cur = opById.get(o.id)
    if (cur) {
      if (newer(o, cur)) { ops.push(o); sum.updated++ }
    } else if (!o.deletedAt && fps.has(fingerprint(o))) {
      sum.skippedDuplicates++
    } else {
      ops.push(o)
      sum.added++
    }
  }
  const clById = new Map(all.clients.map((c) => [c.id, c]))
  const clients = b.clients.filter((c) => newer(c, clById.get(c.id)))
  const catById = new Map(all.categories.map((c) => [c.id, c]))
  const categories = b.categories.filter((c) => newer(c, catById.get(c.id)))
  sum.clients = clients.length
  sum.categories = categories.length

  await DB.commit([
    ...ops.map((value) => ({ store: 'operations' as const, value })),
    ...clients.map((value) => ({ store: 'clients' as const, value })),
    ...categories.map((value) => ({ store: 'categories' as const, value })),
  ], b.history)
  await actions.reload()
  return sum
}

/* ---------------- restore as edits (sync-safe) ---------------- */

const LIST: [EntityKind, 'operations' | 'clients' | 'categories'][] = [['operation', 'operations'], ['client', 'clients'], ['category', 'categories']]
const content = (r: object) => canonical({ ...r, updatedAt: undefined })

export interface RestorePlan {
  /** missing on this device or deleted here — will come back */
  restored: number
  /** exist here with different content — will return to the backup's version */
  changed: number
  unchanged: number
  /** added after the backup — kept (or, for undo/replace, moved to «Недавно удалённые») */
  newer: number
  items: { entity: EntityKind; data: Operation | Client | Category; action: 'update' | 'restore' | 'delete' }[]
}

/** What restoring `b` would do. Nothing is written. */
export function planRestore(b: Pick<Backup, 'operations' | 'clients' | 'categories'>, removeExtra = false): RestorePlan {
  const { all } = getState()
  const plan: RestorePlan = { restored: 0, changed: 0, unchanged: 0, newer: 0, items: [] }
  for (const [entity, list] of LIST) {
    const local = new Map<string, Operation | Client | Category>(all[list].map((r) => [r.id, r]))
    const inBackup = new Set<string>()
    for (const r of b[list] as (Operation | Client | Category)[]) {
      inBackup.add(r.id)
      const cur = local.get(r.id)
      if (cur && content(cur) === content(r)) { plan.unchanged++; continue }
      const back = !cur || (!!cur.deletedAt && !r.deletedAt)
      if (back) plan.restored++; else plan.changed++
      plan.items.push({ entity, data: r, action: back && cur ? 'restore' : 'update' })
    }
    for (const cur of all[list]) {
      if (inBackup.has(cur.id) || cur.deletedAt) continue
      plan.newer++
      if (removeExtra) plan.items.push({ entity, data: { ...cur, deletedAt: new Date().toISOString() }, action: 'delete' })
    }
  }
  return plan
}

/** Writes the plan as ordinary edits: history is kept, nothing is hard-deleted, the PC receives it on the next sync. */
export async function applyAsEdits(b: Pick<Backup, 'operations' | 'clients' | 'categories'>, removeExtra = false) {
  await waitForWrites()
  const plan = planRestore(b, removeExtra)
  actions.putAsEdits(plan.items)
  await waitForWrites()
  return plan
}

/** Restore from a PC backup: local safety snapshot first, then the backup is applied as edits; newer records are kept. */
export async function restoreFromBackup(b: Backup) {
  await waitForWrites()
  await DB.setMeta('preRestore', await buildBackup())
  return applyAsEdits(b, false)
}
