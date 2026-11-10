// Page side of the two-device sync regression (driven by scripts/test-sync.mjs).
import { actions, getState, initStore, waitForWrites } from '../src/lib/store'
import * as DB from '../src/lib/db'
import * as backup from '../src/lib/backup'
import * as sync from '../src/lib/sync'
import { getDevice } from '../src/lib/sync/device'

const draft = (title: string, amount: number) => ({
  title, amount, type: 'income' as const, currency: 'EUR', date: new Date().toISOString(), categoryId: 'c-work', clientId: null, source: 'manual' as const,
})

export const api = {
  async init() { await initStore(); await sync.initSync() },
  pair: (host: string, code: string) => sync.pair(host, code),
  sync: async () => { await sync.syncNow(); return sync.getSyncStatus() },
  status: () => sync.getSyncStatus(),
  pending: () => sync.countPending(),
  async add(title: string, amount: number) { const o = actions.addOperation(draft(title, amount)); await waitForWrites(); return o.id },
  async edit(id: string, patch: Record<string, unknown>) { actions.updateOperation(id, patch); await waitForWrites() },
  async remove(id: string) { actions.removeOperation(id); await waitForWrites() },
  op: (id: string) => getState().all.operations.find((o) => o.id === id) ?? null,
  live: () => getState().operations.map((o) => ({ id: o.id, title: o.title, amount: o.amount, note: o.note ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
  allIds: () => getState().all.operations.map((o) => o.id).sort(),
  forgetAcks: () => DB.deleteMeta('syncBase'),
  async keyIsSafe() {
    const d = await getDevice()
    if (!d) return false
    try { await crypto.subtle.exportKey('jwk', d.privateKey); return false } catch { return d.privateKey.extractable === false }
  },
  backups: () => sync.listServerBackups(),
  makeBackup: () => sync.createServerBackup('manual'),
  async restore(file: string) {
    const raw = await sync.fetchServerBackup(file)
    const b = backup.parseBackup(JSON.stringify(raw))
    const plan = backup.planRestore(b)
    await sync.createServerBackup('pre-restore')
    await backup.restoreFromBackup(b)
    return { restored: plan.restored, changed: plan.changed, newer: plan.newer }
  },
  /** next IndexedDB put on operations fails once (simulated full disk) */
  failNextWrite() {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'operations') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic quota', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  },
  conflicts: () => sync.getSyncStatus().conflicts,
  resolve: async (choice: 'kept' | 'other') => { const c = sync.getSyncStatus().conflicts[0]; await sync.resolveConflict(c, choice) },
  history: async (id: string) => (await DB.historyFor(id)).map((h) => ({ action: h.action, via: h.via ?? null })),
}
;(window as unknown as { api: typeof api }).api = api
