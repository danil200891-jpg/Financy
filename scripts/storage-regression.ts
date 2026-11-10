// Run in an isolated browser origin with seeded test data.
import * as DB from '../src/lib/db'
import type { HistoryEntry } from '../src/lib/types'

export async function verifyStorageRollback() {
  const data = await DB.loadAll()
  const history = await DB.allHistory()
  const before = JSON.stringify({ ...data, history })
  if (!data.operations.length) throw new Error('Seed an operation before testing rollback')

  // Missing keyPath causes a synchronous DataError after earlier writes succeeded.
  const invalidHistory = [{} as HistoryEntry]
  const operation = { ...data.operations[0], id: 'rollback-regression-only' }
  const attempts = [
    () => DB.commit([{ store: 'operations', value: operation }], invalidHistory),
    () => DB.replaceAll({ operations: [], clients: [], categories: [], history: invalidHistory }),
  ]
  for (const attempt of attempts) {
    let failed = false
    try { await attempt() } catch { failed = true }
    const after = JSON.stringify({ ...await DB.loadAll(), history: await DB.allHistory() })
    if (!failed || after !== before) throw new Error('Failed write changed persisted data')
  }
}
