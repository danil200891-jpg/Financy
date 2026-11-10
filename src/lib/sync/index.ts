// Automatic iPhone ↔ PC sync over the home Wi-Fi.
//
// The phone is the main device and always works on its own: every change is saved to IndexedDB
// first. When the paired PC is reachable, changes are pushed and the PC's newer records pulled —
// on app start, when the app comes to the foreground, when the network returns, a few seconds after
// each change, and every 2 minutes while open. iOS does not run closed web apps in the background,
// so nothing syncs while Financy is closed.
//
// Per record the phone remembers the last server revision and hash it agreed on (`syncBase`).
// A record whose current hash differs from that base is a local change waiting to be sent.
import { useSyncExternalStore } from 'react'
import * as DB from '../db'
import { actions, getState, waitForWrites } from '../store'
import type { EntityKind, FinancialRecord } from '../types'
import { hashRecord, sha256, canonical } from './canonical'
import { HttpError, cleanHost, getDevice, pairWith, ping, saveDevice, signed, validHost, type PairedDevice } from './device'

type AnyRecord = FinancialRecord
interface Base { [key: string]: { rev: number; hash: string } }
interface RemoteRecord { entity: EntityKind; id: string; rev: number; hash: string; data: AnyRecord }
interface PushResult { key: string; status: 'accepted' | 'same' | 'merged' | 'conflict' | 'rejected'; rev?: number; hash?: string; data?: AnyRecord; reason?: string }
export interface Conflict { id: string; entity: EntityKind; recordId: string; at: string; fields: string[]; kept: { data: AnyRecord }; other: { data: AnyRecord } }
export interface ServerBackup { file: string; kind: 'weekly' | 'manual' | 'pre-restore'; createdAt: string | null; counts: { operations: number; clients: number; categories: number; deleted?: number } | null; valid: boolean; size: number }

export interface SyncStatus {
  paired: boolean
  planningSupported?: boolean
  serverName: string | null
  phase: 'idle' | 'syncing' | 'offline' | 'error'
  reachable: boolean | null
  lastSyncAt: string | null
  lastBackupAt: string | null
  pending: number
  error: string | null
  conflicts: Conflict[]
  rejected: number
}

const LISTS: Record<EntityKind, 'operations' | 'clients' | 'categories' | 'planning'> = { operation: 'operations', client: 'clients', category: 'categories', planning: 'planning' }
const keyOf = (entity: EntityKind, id: string) => `${entity}:${id}`
const BATCH = 400
const BACKOFF = [10e3, 30e3, 60e3, 120e3, 300e3]

let status: SyncStatus = { paired: false, serverName: null, phase: 'idle', reachable: null, lastSyncAt: null, lastBackupAt: null, pending: 0, error: null, conflicts: [], rejected: 0 }
const listeners = new Set<() => void>()
function setStatus(patch: Partial<SyncStatus>) { status = { ...status, ...patch }; listeners.forEach((l) => l()) }
export function useSyncStatus() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => status)
}
export const getSyncStatus = () => status
export const isPaired = () => status.paired

/* ---------------- local bookkeeping ---------------- */

const loadBase = async () => (await DB.getMeta<Base>('syncBase')) ?? {}

function localRecords() {
  const { all } = getState()
  const out: { entity: EntityKind; data: AnyRecord }[] = []
  for (const entity of Object.keys(LISTS) as EntityKind[]) for (const data of all[LISTS[entity]]) out.push({ entity, data })
  return out
}

async function dirtyRecords(base: Base) {
  const out: { entity: EntityKind; id: string; baseRev: number; hash: string; data: AnyRecord }[] = []
  for (const { entity, data } of localRecords()) {
    const hash = await hashRecord(data)
    const b = base[keyOf(entity, data.id)]
    if (!b || b.hash !== hash) out.push({ entity, id: data.id, baseRev: b?.rev ?? 0, hash, data })
  }
  return out
}

export async function countPending() {
  if (!status.paired) return 0
  const n = (await dirtyRecords(await loadBase())).filter((r) => !(r.entity === 'planning' && 'kind' in r.data && r.data.kind === 'movement' && (r.data.status === 'rejected' || r.data.deletedAt))).length
  setStatus({ pending: n })
  return n
}

/* ---------------- talking to the PC ---------------- */

/** Finds the PC: last working address first, then its .local name and other known IPs. */
async function discover(device: PairedDevice) {
  const candidates = [...new Set([device.lastHost, ...device.hosts].filter(Boolean) as string[])]
  const found = await Promise.any(candidates.map(async (host) => {
    const info = await ping(host)
    if (info.app !== 'financy-sync' || info.serverId !== device.serverId) throw new Error('other server')
    return { host, info }
  })).catch(() => null)
  if (!found) return null
  const hosts = [...new Set([found.host, ...found.info.hosts, ...device.hosts])].slice(0, 8)
  if (found.host !== device.lastHost || hosts.join() !== device.hosts.join() || found.info.name !== device.serverName) {
    Object.assign(device, { lastHost: found.host, hosts, serverName: found.info.name })
    await saveDevice(device)
  }
  return found.host
}

function explain(e: unknown) {
  if (e instanceof HttpError) {
    if (e.code === 'unknown-device') return 'Компьютер больше не узнаёт этот iPhone. Подключите его заново.'
    if (e.code === 'clock') return 'Время на iPhone и компьютере отличается больше чем на 5 минут. Проверьте дату и время.'
    if (e.code === 'storage') return 'Компьютер не смог сохранить данные (возможно, нет места на диске). Повторим позже.'
    return `Компьютер ответил ошибкой (${e.code}). Повторим позже.`
  }
  if ((e as Error)?.message === 'integrity') return 'Данные пришли повреждёнными и не применены. Повторим позже.'
  if ((e as Error)?.message?.startsWith('Не удалось сохранить')) return (e as Error).message
  return 'Не удалось синхронизировать. Повторим позже.'
}

let applying = false
let planningSupported = false

async function confirmMovements(device: PairedDevice, host: string) {
  const candidates = getState().planning.filter((r) => r.kind === 'movement' && r.status !== 'rejected').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
  for (const event of candidates) {
    const base = await loadBase()
    if (base[keyOf('planning', event.id)]?.hash === await hashRecord(event)) continue
    const current = await signed<{ seq: number }>(device, host, 'GET', '/sync/status?planning=2')
    try {
      const result = await signed<{ record: RemoteRecord }>(device, host, 'POST', '/planning/commit', { event, baseSeq: current.seq })
      await applyRecords([{ entity: 'planning', data: result.record.data, sentHash: await hashRecord(event) }])
      base[keyOf('planning', event.id)] = { rev: result.record.rev, hash: result.record.hash }
      await DB.setMeta('syncBase', base)
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error
      actions.savePlanning({ ...event, status: 'rejected', reason: 'Данные изменились или денег недостаточно. Проверьте и подтвердите заново.', updatedAt: new Date().toISOString() })
      await waitForWrites()
    }
  }
}

async function push(device: PairedDevice, host: string) {
  const base = await loadBase()
  const dirty = (await dirtyRecords(base)).filter((r) => r.entity !== 'planning' || (planningSupported && !('kind' in r.data && r.data.kind === 'movement')))
  let rejected = 0
  for (let i = 0; i < dirty.length; i += BATCH) {
    const batch = dirty.slice(i, i + BATCH)
    const res = await signed<{ results: PushResult[] }>(device, host, 'POST', '/sync/push', { changes: batch }, 30000)
    const sent = new Map(batch.map((c) => [keyOf(c.entity, c.id), c]))
    const toApply: { entity: EntityKind; data: AnyRecord; sentHash: string }[] = []
    for (const r of res.results) {
      const c = sent.get(r.key)
      if (!c) continue
      if (r.status === 'rejected' || r.rev == null || !r.hash) { rejected++; continue }
      base[r.key] = { rev: r.rev, hash: r.hash }
      if (r.data && r.hash !== c.hash) {
        if ((await sha256(canonical(r.data))) !== r.hash) throw new Error('integrity')
        toApply.push({ entity: c.entity, data: r.data, sentHash: c.hash })
      }
    }
    await applyRecords(toApply)
    await DB.setMeta('syncBase', base)
  }
  return rejected
}

/** Applies server versions unless the local record changed again meanwhile (then the next push handles it). */
async function applyRecords(items: { entity: EntityKind; data: AnyRecord; sentHash?: string; baseHash?: string }[]) {
  if (!items.length) return
  await waitForWrites()
  // snapshot the exact local objects we compare against; any edit replaces the object
  const seen = new Map<string, { obj: AnyRecord | undefined; hash: string | undefined }>()
  for (const { entity, data } of items) {
    const obj = getState().all[LISTS[entity]].find((r) => r.id === data.id)
    seen.set(keyOf(entity, data.id), { obj, hash: obj ? await hashRecord(obj) : undefined })
  }
  const want = new Map(items.map((i) => [keyOf(i.entity, i.data.id), i.sentHash ?? i.baseHash]))
  applying = true
  try {
    actions.applyRemote(items, (entity, data, current) => {
      const key = keyOf(entity, data.id)
      const s = seen.get(key)
      return !!s && current === s.obj && s.hash === want.get(key)
    })
    await waitForWrites()
  } finally {
    applying = false
  }
}

async function pull(device: PairedDevice, host: string) {
  let cursor = (await DB.getMeta<number>(planningSupported ? 'syncPlanningCursor' : 'syncCursor')) ?? 0
  for (let page = 0; page < 1000; page++) {
    const res = await signed<{ records: RemoteRecord[]; cursor: number; more: boolean; serverId: string }>(device, host, 'GET', `/sync/pull?since=${cursor}&limit=500${planningSupported ? '&planning=2' : ''}`, undefined, 30000)
    if (res.serverId !== device.serverId) throw new HttpError(409, 'other-server')
    const base = await loadBase()
    const toApply: { entity: EntityKind; data: AnyRecord; baseHash?: string }[] = []
    for (const r of res.records) {
      if ((await sha256(canonical(r.data))) !== r.hash || r.data.id !== r.id) throw new Error('integrity')
      const key = keyOf(r.entity, r.id)
      const b = base[key]
      const cur = getState().all[LISTS[r.entity]].find((x) => x.id === r.id)
      const curHash = cur ? await hashRecord(cur) : undefined
      if (curHash === r.hash) { base[key] = { rev: r.rev, hash: r.hash }; continue }
      // local copy untouched since the last agreed version (or absent) → take the server's
      if (!cur || (b && curHash === b.hash) || (r.entity === 'planning' && 'kind' in r.data && r.data.kind === 'movement')) {
        toApply.push({ entity: r.entity, data: r.data, baseHash: curHash })
        base[key] = { rev: r.rev, hash: r.hash }
      }
      // else: changed on this phone too — the next push merges it on the server
    }
    await applyRecords(toApply)
    // only records that really landed get their base moved
    for (const t of toApply) {
      const cur = getState().all[LISTS[t.entity]].find((x) => x.id === t.data.id)
      if (!cur || (await hashRecord(cur)) !== (await sha256(canonical(t.data)))) delete base[keyOf(t.entity, t.data.id)]
    }
    cursor = res.cursor
    await DB.setMeta('syncBase', base)
    await DB.setMeta(planningSupported ? 'syncPlanningCursor' : 'syncCursor', cursor)
    if (!res.more) break
  }
}

/* ---------------- one round ---------------- */

let running: Promise<void> | null = null
let rerun: Promise<void> | null = null
let failures = 0
let timer: ReturnType<typeof setTimeout> | undefined

/** Runs a sync round. If one is already running, one more round follows it (so nothing is missed). */
export function syncNow(): Promise<void> {
  if (running) return (rerun ??= running.then(() => { rerun = null; return syncNow() }))
  running = (async () => {
    const device = await getDevice()
    if (!device) { setStatus({ paired: false, phase: 'idle' }); return }
    setStatus({ paired: true, serverName: device.serverName, phase: 'syncing' })
    try {
      const host = await discover(device)
      if (!host) {
        failures++
        setStatus({ phase: 'offline', reachable: false, error: null })
        return
      }
      const info = await ping(host)
      planningSupported = !!info.capabilities?.includes('planning-v2')
      setStatus({ planningSupported })
      await waitForWrites()
      const rejected = await push(device, host)
      await pull(device, host)
      if (planningSupported) await confirmMovements(device, host)
      const st = await signed<{ lastBackupAt: string | null; conflicts: Conflict[] }>(device, host, 'GET', planningSupported ? '/sync/status?planning=2' : '/sync/status')
      const now = new Date().toISOString()
      await DB.setMeta('syncLastAt', now)
      await DB.setMeta('syncServerBackupAt', st.lastBackupAt)
      failures = 0
      setStatus({ phase: 'idle', reachable: true, lastSyncAt: now, lastBackupAt: st.lastBackupAt, conflicts: st.conflicts ?? [], rejected,
        error: rejected ? `${rejected} записей не прошли проверку на компьютере и остались только на iPhone.` : null })
    } catch (e) {
      failures++
      setStatus({ phase: 'error', reachable: !(e instanceof TypeError), error: explain(e) })
    } finally {
      await countPending().catch(() => {})
    }
  })().finally(() => {
    running = null
    if (status.paired) schedule(failures ? BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)] : 120e3)
  })
  return running
}

function schedule(ms: number) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    if (document.visibilityState === 'hidden') return // resumes on the next visibilitychange
    const go = () => syncNow()
    const locks = (navigator as Navigator & { locks?: { request: (n: string, o: object, cb: (l: unknown) => Promise<void>) => Promise<void> } }).locks
    if (locks) void locks.request('financy-sync', { ifAvailable: true }, async (lock) => { if (lock) await go() })
    else void go()
  }, ms)
}

/** Called once after the store is ready. */
export async function initSync() {
  const device = await getDevice()
  const [lastSyncAt, lastBackupAt] = await Promise.all([DB.getMeta<string>('syncLastAt'), DB.getMeta<string>('syncServerBackupAt')])
  setStatus({ paired: !!device, serverName: device?.serverName ?? null, lastSyncAt: lastSyncAt ?? null, lastBackupAt: lastBackupAt ?? null })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && status.paired) schedule(600) })
  window.addEventListener('online', () => { if (status.paired) schedule(800) })
  let debounce: ReturnType<typeof setTimeout> | undefined
  DB.onDataChanged(() => {
    if (applying || !status.paired) return
    clearTimeout(debounce)
    debounce = setTimeout(() => { void countPending(); schedule(3000) }, 400)
  })
  if (device) { void countPending(); schedule(300) }
}

/* ---------------- pairing ---------------- */

export async function pair(address: string, code: string) {
  const host = cleanHost(address)
  if (!validHost(host)) throw new Error('Введите адрес компьютера, например 192.168.1.20 или имя-компьютера.local')
  if (!/^\d{6}$/.test(code.replace(/\D/g, ''))) throw new Error('Код состоит из 6 цифр — он показан на странице Financy Sync на компьютере.')
  try {
    await pairWith(host, code)
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.code === 'wrong') throw new Error('Неверный код. Проверьте цифры на компьютере.')
      if (e.code === 'locked' || e.code === 'expired') throw new Error('Код больше не действует. Получите новый на компьютере.')
      throw new Error('Компьютер отклонил подключение. Получите новый код и попробуйте снова.')
    }
    if ((e as Error)?.name === 'DataCloneError') throw new Error('Этот браузер не может безопасно хранить ключ подключения.')
    throw new Error('Не удалось связаться с компьютером. Проверьте: компьютер включён и в той же Wi-Fi, сервер Financy Sync запущен, сертификат установлен и включено доверие к нему.')
  }
  // fresh start: every local record is offered to the PC; nothing is replaced
  await DB.deleteMeta('syncBase'); await DB.deleteMeta('syncCursor'); await DB.deleteMeta('syncPlanningCursor')
  failures = 0
  setStatus({ paired: true, error: null })
  await syncNow()
}

/** Forgets the PC on this device only. All financial data stays on the phone and on the PC. */
export async function unpair() {
  clearTimeout(timer)
  for (const k of ['syncDevice', 'syncBase', 'syncCursor', 'syncPlanningCursor', 'syncLastAt', 'syncServerBackupAt']) await DB.deleteMeta(k)
  setStatus({ paired: false, serverName: null, phase: 'idle', reachable: null, lastSyncAt: null, lastBackupAt: null, pending: 0, error: null, conflicts: [] })
}

/* ---------------- backups on the PC ---------------- */

async function withServer<T>(fn: (d: PairedDevice, host: string) => Promise<T>) {
  const device = await getDevice()
  if (!device) throw new Error('Компьютер не подключён.')
  const host = await discover(device)
  if (!host) throw new Error('Компьютер недоступен. Проверьте, что он включён и в той же Wi-Fi.')
  return fn(device, host)
}

export const listServerBackups = () => withServer(async (d, h) => (await signed<{ backups: ServerBackup[] }>(d, h, 'GET', '/backups')).backups)

export async function fetchServerBackup(file: string) {
  const b = await withServer((d, h) => signed<Record<string, unknown> & { integrity?: { hash: string } }>(d, h, 'GET', `/backups/file?name=${encodeURIComponent(file)}${planningSupported ? '&planning=2' : ''}`, undefined, 60000))
  const { integrity, ...body } = b
  if (!integrity || (await sha256(canonical(body))) !== integrity.hash) throw new Error('Копия повреждена при передаче. Попробуйте ещё раз.')
  return b
}

export const createServerBackup = (kind: 'pre-restore' | 'manual') => withServer((d, h) => signed<{ file: string }>(d, h, 'POST', '/backups', { kind }, 60000))

export async function resolveConflict(c: Conflict, choice: 'kept' | 'other') {
  if (choice === 'other') {
    actions.putAsEdits([{ entity: c.entity, data: c.other.data }])
    await waitForWrites()
  }
  await withServer((d, h) => signed(d, h, 'POST', '/sync/conflicts/resolve', { id: c.id }))
  setStatus({ conflicts: status.conflicts.filter((x) => x.id !== c.id) })
  if (choice === 'other') void syncNow()
}
