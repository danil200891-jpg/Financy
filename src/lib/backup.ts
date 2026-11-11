import type { PlanningRecord } from './planning-types'
import { validPlanning } from '../../sync-server/lib/planning.mjs'
import { validInvoicing } from '../../sync-server/lib/invoicing.mjs'
import type { InvoicingRecord } from './invoice-types'
import { lastIssued } from './invoicing'
import type { Category, Client, HistoryEntry, Operation, FinancialRecord } from './types'
import * as DB from './db'
import { actions, fingerprint, getState, waitForWrites } from './store'
import type { EntityKind } from './types'
import { canonical } from './sync/canonical'
import { isPaired } from './sync'

export const BACKUP_APP = 'finance-pwa'
export const BACKUP_VERSION = 3

export interface Backup {
  app: typeof BACKUP_APP
  version: number
  exportedAt: string
  operations: Operation[]
  clients: Client[]
  categories: Category[]
  planning?: PlanningRecord[]
  /** version 3+: issuer profiles, numbering series, invoice settings and invoices */
  invoicing?: InvoicingRecord[]
  history: HistoryEntry[]
}

const stamp = () => new Date().toISOString().slice(0, 10)

/**
 * Issued invoices are a legal journal: a restore may bring back missing ones but never deletes,
 * un-issues or edits one that exists here, and a numbering series never moves backwards
 * (otherwise the same number could be handed out twice).
 */
const isIssued = (r: InvoicingRecord | undefined) => !!r && r.kind === 'invoice' && r.status !== 'draft'
function protectSeries(record: InvoicingRecord, invoices: InvoicingRecord[]): InvoicingRecord {
  if (record.kind !== 'series') return record
  const current = getState().all.invoicing.find((r) => r.id === record.id)
  const used = lastIssued(invoices.filter((r) => r.kind === 'invoice') as never, record.id)
  const next = Math.max(record.next, current?.kind === 'series' ? current.next : 1, used + 1)
  return next === record.next ? record : { ...record, next }
}
/** Full replacement list: the backup's invoicing records plus every issued invoice it lacks or would change. */
function replaceInvoicing(list: InvoicingRecord[]) {
  const byId = new Map(list.map((r) => [r.id, r]))
  for (const cur of getState().all.invoicing) if (isIssued(cur) || (cur.kind === 'series' && !byId.has(cur.id))) byId.set(cur.id, cur)
  const merged = [...byId.values()]
  return merged.map((r) => protectSeries(r, merged))
}

function safePlanningRestore(record: PlanningRecord): PlanningRecord {
  const current = getState().all.planning.find((r) => r.id === record.id)
  if (record.kind !== 'movement' || (current?.status === 'confirmed' && canonical(current) === canonical(record))) return record
  return { ...record, status: 'pending', reason: undefined }
}

/** iOS PWAs handle the share sheet better than <a download>; fall back to a download link. */
export async function deliver(blob: Blob, name: string) {
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
  await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history, ...(b.planning ? { planning: b.planning } : {}), ...(b.invoicing ? { invoicing: replaceInvoicing(b.invoicing) } : {}) })
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
    && (!o.planningPayment || (isStr(o.planningPayment.envelopeId) && Number.isSafeInteger(o.planningPayment.reserved) && o.planningPayment.reserved >= 0))
    && (o.invoiceId == null || isStr(o.invoiceId))
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
  if (raw.planning !== undefined && (!Array.isArray(raw.planning) || raw.planning.some((r) => !validPlanning(r)) || new Set(raw.planning.map((r) => r.id)).size !== raw.planning.length)) throw new Error('Планирование в копии повреждено. Данные не изменены.')
  if (raw.invoicing !== undefined && (!Array.isArray(raw.invoicing) || raw.invoicing.some((r) => !validInvoicing(r)) || new Set(raw.invoicing.map((r) => r.id)).size !== raw.invoicing.length)) throw new Error('Фактуры в копии повреждены. Данные не изменены.')
  const bad = raw.operations.filter((o) => !validOp(o)).length
  if (bad) throw new Error(`В копии ${bad} повреждённых операций. Восстановление отменено, данные не изменены.`)
  if ([raw.clients, raw.categories, raw.history].some((records) => records !== undefined && !Array.isArray(records))) throw new Error('В копии повреждён список записей. Восстановление отменено.')
  const clients = Array.isArray(raw.clients) ? raw.clients : []
  const categories = Array.isArray(raw.categories) ? raw.categories : []
  const history = Array.isArray(raw.history) ? raw.history : []
  const badClient = clients.some((c) => !c || !isStr(c.id) || !isStr(c.name) || (c.aliases !== undefined && (!Array.isArray(c.aliases) || c.aliases.some((alias) => !isStr(alias)))))
  const badCategory = categories.some((c) => !c || !isStr(c.id) || !isStr(c.name) || !['income', 'expense'].includes(c.type))
  const badHistory = history.some((h) => !h || !isStr(h.id) || !isStr(h.entityId) || !['operation', 'client', 'category', 'planning', 'invoicing'].includes(h.entity) || !['create', 'update', 'delete', 'restore'].includes(h.action) || !isStr(h.at) || !Number.isFinite(Date.parse(h.at)))
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
    await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history, ...(b.planning ? { planning: b.planning.map(safePlanningRestore) } : {}), ...(b.invoicing ? { invoicing: replaceInvoicing(b.invoicing) } : {}) }, { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString() })
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

  const planning = (b.planning ?? []).filter((r) => newer(r, all.planning.find((p) => p.id === r.id)))
  const invoicing = (b.invoicing ?? []).filter((r) => { const cur = all.invoicing.find((x) => x.id === r.id); return !isIssued(cur) && newer(r, cur) })
  const allInvoicing = [...all.invoicing, ...invoicing]
  await DB.commit([
    ...invoicing.map((value) => ({ store: 'invoicing' as const, value: protectSeries(value, allInvoicing) })),
    ...planning.map((value) => ({ store: 'planning' as const, value: safePlanningRestore(value) })),
    ...ops.map((value) => ({ store: 'operations' as const, value })),
    ...clients.map((value) => ({ store: 'clients' as const, value })),
    ...categories.map((value) => ({ store: 'categories' as const, value })),
  ], b.history)
  await actions.reload()
  return sum
}

/* ---------------- restore as edits (sync-safe) ---------------- */

const LIST: [EntityKind, 'operations' | 'clients' | 'categories' | 'planning' | 'invoicing'][] = [['operation', 'operations'], ['client', 'clients'], ['category', 'categories'], ['planning', 'planning'], ['invoicing', 'invoicing']]
const content = (r: object) => canonical({ ...r, updatedAt: undefined })

export interface RestorePlan {
  /** missing on this device or deleted here — will come back */
  restored: number
  /** exist here with different content — will return to the backup's version */
  changed: number
  unchanged: number
  /** added after the backup — kept (or, for undo/replace, moved to «Недавно удалённые») */
  newer: number
  items: { entity: EntityKind; data: FinancialRecord; action: 'update' | 'restore' | 'delete' }[]
}

/** What restoring `b` would do. Nothing is written. */
export function planRestore(b: Pick<Backup, 'operations' | 'clients' | 'categories' | 'planning' | 'invoicing'>, removeExtra = false): RestorePlan {
  const { all } = getState()
  const plan: RestorePlan = { restored: 0, changed: 0, unchanged: 0, newer: 0, items: [] }
  for (const [entity, list] of LIST) {
    if (list === 'planning' && b.planning === undefined) continue
    if (list === 'invoicing' && b.invoicing === undefined) continue
    const local = new Map<string, FinancialRecord>(all[list].map((r) => [r.id, r]))
    const inBackup = new Set<string>()
    for (const r of b[list] as (FinancialRecord)[]) {
      inBackup.add(r.id)
      const cur = local.get(r.id)
      if (cur && content(cur) === content(r)) { plan.unchanged++; continue }
      if (list === 'invoicing' && isIssued(cur as InvoicingRecord)) { plan.unchanged++; continue }
      const back = !cur || (!!cur.deletedAt && !r.deletedAt)
      if (back) plan.restored++; else plan.changed++
      const data = entity === 'planning' ? safePlanningRestore(r as PlanningRecord) : entity === 'invoicing' ? protectSeries(r as InvoicingRecord, [...all.invoicing, ...(b.invoicing ?? [])]) : r
      plan.items.push({ entity, data, action: back && cur ? 'restore' : 'update' })
    }
    for (const cur of all[list]) {
      // Balance checkpoints and reserve commands are an immutable financial journal.
      if (list === 'planning' && ['balance', 'movement'].includes((cur as PlanningRecord).kind)) continue
      // issued invoices and numbering series are never removed by a restore
      if (list === 'invoicing' && (isIssued(cur as InvoicingRecord) || (cur as InvoicingRecord).kind === 'series')) continue
      if (inBackup.has(cur.id) || cur.deletedAt) continue
      plan.newer++
      if (list === 'planning' && (cur as PlanningRecord).kind === 'envelope' && removeExtra) {
        plan.items.push({ entity, data: { ...cur, state: 'closed' } as PlanningRecord, action: 'update' })
        continue
      }
      if (removeExtra) plan.items.push({ entity, data: { ...cur, deletedAt: new Date().toISOString() }, action: 'delete' })
    }
  }
  return plan
}

/** Writes the plan as ordinary edits: history is kept, nothing is hard-deleted, the PC receives it on the next sync. */
export async function applyAsEdits(b: Pick<Backup, 'operations' | 'clients' | 'categories' | 'planning' | 'invoicing'>, removeExtra = false) {
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
