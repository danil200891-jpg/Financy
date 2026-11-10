// Run in an isolated browser origin with seeded test data.
import * as DB from '../src/lib/db'
import type { HistoryEntry } from '../src/lib/types'
import { buildBackup, restore } from '../src/lib/backup'
import { getState } from '../src/lib/store'

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

  const backup = await buildBackup()
  const marker = `merge-regression-${crypto.randomUUID()}`
  const first = { ...data.operations[0], id: `${marker}-1`, title: marker, deletedAt: null }
  const second = { ...first, id: `${marker}-2` }
  const incoming = { ...backup, operations: [first, second], history: [] }
  await restore(incoming, 'merge')
  for (const operation of [first, second]) {
    if (!getState().operations.some((item) => item.id === operation.id)) {
      throw new Error('Merge lost an intentional duplicate from the same backup')
    }
  }
  const count = getState().operations.length
  await restore(incoming, 'merge')
  if (getState().operations.length !== count) throw new Error('Repeated merge added duplicates')
}
