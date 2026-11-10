import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPush, emptyDb, pull, openConflicts, resolveConflict } from '../lib/engine.mjs'
import { hashRecord, canonical } from '../lib/canonical.mjs'

const op = (id, over = {}) => ({ id, type: 'income', amount: 1000, currency: 'EUR', title: 'MVP', categoryId: 'c-work', clientId: null, date: '2026-11-01T10:00:00.000Z', source: 'manual', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', deletedAt: null, ...over })
const ch = (data, baseRev = 0, entity = 'operation') => ({ entity, id: data.id, baseRev, hash: hashRecord(data), data })

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonical({ b: 1, a: { d: undefined, c: [1, null] } }), '{"a":{"c":[1,null]},"b":1}')
})

test('new record accepted, resend is an idempotent no-op', () => {
  let db = emptyDb('s')
  const a = op('a')
  let r = applyPush(db, 'phone', [ch(a)]); db = r.db
  assert.equal(r.results[0].status, 'accepted'); assert.equal(db.seq, 1)
  r = applyPush(db, 'phone', [ch(a)])
  assert.equal(r.results[0].status, 'same'); assert.equal(r.changed, false); assert.equal(r.db.seq, 1)
})

test('integrity and shape checks reject bad records without storing them', () => {
  const a = op('a')
  const r = applyPush(emptyDb('s'), 'phone', [{ ...ch(a), hash: 'x' }, ch({ ...op('b'), amount: -5 }), ch(op('c'), 0, 'secret')])
  assert.deepEqual(r.results.map((x) => x.status), ['rejected', 'rejected', 'rejected'])
  assert.equal(Object.keys(r.db.records).length, 0)
})

test('fast-forward edit on the latest revision', () => {
  let db = applyPush(emptyDb('s'), 'phone', [ch(op('a'))]).db
  const edited = op('a', { amount: 2000, updatedAt: '2026-11-02T00:00:00.000Z' })
  const r = applyPush(db, 'phone', [ch(edited, 1)]); db = r.db
  assert.equal(r.results[0].status, 'accepted'); assert.equal(db.records['operation:a'].data.amount, 2000)
})

test('different fields edited on two devices merge without conflict', () => {
  let db = applyPush(emptyDb('s'), 'phone', [ch(op('a'))]).db
  db = applyPush(db, 'pc', [ch(op('a', { amount: 2000, updatedAt: '2026-11-02T00:00:00.000Z' }), 1)]).db
  const r = applyPush(db, 'phone', [ch(op('a', { note: 'аванс', updatedAt: '2026-11-03T00:00:00.000Z' }), 1)])
  assert.equal(r.results[0].status, 'merged')
  const m = r.db.records['operation:a'].data
  assert.equal(m.amount, 2000); assert.equal(m.note, 'аванс'); assert.equal(m.updatedAt, '2026-11-03T00:00:00.000Z')
  assert.equal(openConflicts(r.db).length, 0)
})

test('same field edited on two devices keeps the newer and saves both versions', () => {
  let db = applyPush(emptyDb('s'), 'phone', [ch(op('a'))]).db
  db = applyPush(db, 'pc', [ch(op('a', { amount: 2000, updatedAt: '2026-11-02T00:00:00.000Z' }), 1)]).db
  const r = applyPush(db, 'phone', [ch(op('a', { amount: 3000, updatedAt: '2026-11-03T00:00:00.000Z' }), 1)])
  assert.equal(r.results[0].status, 'conflict')
  assert.equal(r.db.records['operation:a'].data.amount, 3000)
  const [c] = openConflicts(r.db)
  assert.equal(c.kept.data.amount, 3000); assert.equal(c.other.data.amount, 2000); assert.deepEqual(c.fields, ['amount'])
  // an older stale edit never overwrites a newer one
  const r2 = applyPush(db, 'phone', [ch(op('a', { amount: 999, updatedAt: '2026-11-01T12:00:00.000Z' }), 1)])
  assert.equal(r2.db.records['operation:a'].data.amount, 2000)
  assert.equal(openConflicts(resolveConflict(r.db, c.id).db).length, 0)
})

test('edit beats a concurrent deletion; double deletion is not a conflict', () => {
  let db = applyPush(emptyDb('s'), 'phone', [ch(op('a'))]).db
  db = applyPush(db, 'pc', [ch(op('a', { deletedAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }), 1)]).db
  const r = applyPush(db, 'phone', [ch(op('a', { title: 'MVP аванс', updatedAt: '2026-11-04T00:00:00.000Z' }), 1)])
  assert.equal(r.db.records['operation:a'].data.deletedAt, null)
  assert.equal(r.db.records['operation:a'].data.title, 'MVP аванс')
  assert.equal(openConflicts(r.db).length, 1)
  const r3 = applyPush(db, 'phone', [ch(op('a', { deletedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' }), 1)])
  assert.ok(r3.db.records['operation:a'].data.deletedAt); assert.equal(openConflicts(r3.db).length, 0)
})

test('first sync of the same default category on two devices merges silently', () => {
  const cat = (t) => ({ id: 'c-work', name: 'Работа', type: 'income', icon: 'briefcase', color: '#3fe0c5', updatedAt: t, deletedAt: null })
  let db = applyPush(emptyDb('s'), 'phone', [ch(cat('2026-01-01T00:00:00.000Z'), 0, 'category')]).db
  const r = applyPush(db, 'pc', [ch(cat('2026-02-01T00:00:00.000Z'), 0, 'category')])
  assert.notEqual(r.results[0].status, 'conflict'); assert.equal(openConflicts(r.db).length, 0)
})

test('pull pages in revision order', () => {
  let db = emptyDb('s')
  db = applyPush(db, 'phone', Array.from({ length: 5 }, (_, i) => ch(op(`o${i}`)))).db
  const p1 = pull(db, 0, 2); assert.equal(p1.records.length, 2); assert.equal(p1.more, true)
  const p2 = pull(db, p1.cursor, 10); assert.equal(p2.records.length, 3); assert.equal(p2.more, false)
  assert.deepEqual(p2.records.map((r) => r.rev), [3, 4, 5])
})
