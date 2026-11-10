import type { Category, Client, HistoryEntry, Operation } from './types'
import * as DB from './db'
import { actions, fingerprint, getState } from './store'

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
  const { all } = getState()
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    operations: all.operations,
    clients: all.clients,
    categories: all.categories,
    history: await DB.allHistory(),
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

const csvCell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

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
  return deliver(new Blob([buildCSV()], { type: 'text/csv;charset=utf-8' }), `finance-operations-${stamp()}.csv`)
}

/* ---------------- restore ---------------- */

export async function getPreRestore() {
  return (await (await DB.db()).get('meta', 'preRestore')) as Backup | undefined
}

export async function undoRestore() {
  const b = await getPreRestore()
  if (!b) return false
  await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history })
  await (await DB.db()).delete('meta', 'preRestore')
  await actions.reload()
  return true
}

const isStr = (v: unknown): v is string => typeof v === 'string'

function validOp(o: Operation) {
  return o && isStr(o.id) && (o.type === 'income' || o.type === 'expense') && Number.isInteger(o.amount) && o.amount > 0 && isStr(o.title) && isStr(o.date) && !isNaN(Date.parse(o.date))
}

export function parseBackup(text: string): Backup {
  let raw: Backup
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Файл не похож на JSON. Выберите файл finance-backup-….json')
  }
  if (raw?.app !== BACKUP_APP || !Array.isArray(raw.operations)) throw new Error('Это не резервная копия Finance.')
  if (raw.version > BACKUP_VERSION) throw new Error('Копия создана более новой версией приложения. Обновите приложение.')
  const bad = raw.operations.filter((o) => !validOp(o)).length
  if (bad) throw new Error(`В копии ${bad} повреждённых операций. Восстановление отменено, данные не изменены.`)
  return {
    ...raw,
    clients: Array.isArray(raw.clients) ? raw.clients.filter((c) => c && isStr(c.id) && isStr(c.name)) : [],
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c) => c && isStr(c.id) && isStr(c.name)) : [],
    history: Array.isArray(raw.history) ? raw.history : [],
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
  // safety snapshot so a restore can be undone from Settings
  await DB.setMeta('preRestore', await buildBackup())
  if (mode === 'replace') {
    await DB.replaceAll({ operations: b.operations, clients: b.clients, categories: b.categories, history: b.history })
    await actions.reload()
    return {
      added: b.operations.filter((o) => !o.deletedAt).length, updated: 0, skippedDuplicates: 0,
      clients: b.clients.filter((c) => !c.deletedAt).length, categories: b.categories.filter((c) => !c.deletedAt).length,
    }
  }

  const { all } = getState()
  const opById = new Map(all.operations.map((o) => [o.id, o]))
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
      fps.add(fingerprint(o))
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
