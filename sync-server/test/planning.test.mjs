import { test } from 'node:test'
import assert from 'node:assert/strict'
import { financials, validPlanning, duePeriods, movementError, obligations, distribution } from '../lib/planning.mjs'
import { applyPush, commitPlanning, emptyDb, pull, snapshot } from '../lib/engine.mjs'
import { buildBackup, verifyBackup } from '../lib/backups.mjs'
import { change, op } from './helpers.mjs'

const now = new Date('2026-11-15T12:00:00Z')
const base = { currency: 'EUR', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
const anchor = { ...base, id: 'balance-1', kind: 'balance', amount: 100000, at: '2026-11-01T00:00:00Z' }
const envelope = { ...base, id: 'rent', kind: 'envelope', name: 'Rent', target: 75000, priority: 1, mode: 'obligation', frequency: 'monthly', due: '2026-11-20', state: 'active' }
const event = (id, amount, from = null, to = 'rent', status = 'confirmed') => ({ ...base, id, kind: 'movement', amount, from, to, status })
const payment = { ...op('payment'), type: 'expense', amount: 75000, planningPayment: { envelopeId: 'rent', reserved: 75000, period: '2026-11-20' } }

test('unknown balance is not inferred from historic incomes; future incomes excluded', () => {
  assert.equal(financials([op('old')], [], now).balance, null)
  assert.equal(financials([op('future', { date: '2027-01-01' })], [anchor], now).balance, 100000)
})
test('manual correction is a new checkpoint, not an operation or a monthly income', () => {
  const correction = { ...anchor, id: 'balance-2', amount: 25000, at: '2026-11-10T00:00:00Z' }
  const after = op('after', { amount: 2000, date: '2026-11-11T12:00:00Z' })
  assert.equal(financials([op('before'), after], [anchor, correction], now).balance, 27000)
  assert.equal([anchor, correction].length, 2)
})
test('reserve and transfer leave actual balance unchanged; pending never counted as confirmed', () => {
  const target = { ...envelope, id: 'goal', mode: 'goal' }
  let money = financials([], [anchor, envelope, target, event('a', 75000), event('pending', 1000, null, 'rent', 'pending')], now)
  assert.deepEqual([money.balance, money.reserved, money.free], [100000, 75000, 25000])
  money = financials([], [anchor, envelope, target, event('a', 75000), event('transfer', 15000, 'rent', 'goal')], now)
  assert.equal(money.reserves.rent, 60000); assert.equal(money.reserves.goal, 15000); assert.equal(money.free, 25000)
})
test('pay once from reserve: free balance unchanged; edit/delete recompute without double debit', () => {
  const records = [anchor, envelope, event('reserve', 75000)]
  const result = financials([payment], records, now)
  assert.deepEqual([result.balance, result.reserved, result.free], [25000, 0, 25000])
  const edited = financials([{ ...payment, amount: 50000 }], records, now)
  assert.deepEqual([edited.balance, edited.reserved, edited.free], [50000, 25000, 25000])
  assert.equal(financials([{ ...payment, deletedAt: now.toISOString() }], records, now).reserves.rent, 75000)
})
test('overspending is visible as a deficit; envelopes never go negative', () => {
  const result = financials([{ ...payment, amount: 120000, planningPayment: undefined }], [anchor, envelope, event('r', 75000)], now)
  assert.equal(result.free, -95000)
  assert.equal(financials([payment, { ...payment, id: 'offline-second-payment' }], [anchor, envelope, event('r', 75000)], now).reserves.rent, 0)
})
test('a recovered linked payment does not require reserving the spent money a second time', () => {
  assert.equal(movementError([payment], [anchor, envelope], event('recovered', 75000), now), null)
  assert(movementError([], [anchor, envelope], event('unfunded', 100001), now))
  assert(!validPlanning(event('invalid-id', 1, null, '')))
})
test('recurrence clamps month-end/leap day, preserves original schedule and unpaid history', () => {
  assert.deepEqual(duePeriods({ ...envelope, due: '2024-01-31' }, '2024-03-31'), ['2024-01-31', '2024-02-29', '2024-03-31'])
  assert.deepEqual(duePeriods({ ...envelope, due: '2024-02-29', frequency: 'yearly' }, '2028-02-29'), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'])
  assert.equal(obligations([payment], [envelope], now).length, 0)
})
test('allocation prioritizes obligations then cushion and goals, without using pending income', () => {
  const cushion = { ...envelope, id: 'cushion', mode: 'goal', cushion: true, target: 50000 }
  const goal = { ...cushion, id: 'camera', cushion: false }
  const proposal = distribution([], [anchor, envelope, goal, cushion], now)
  assert.deepEqual(proposal.map((p) => [p.envelopeId, p.amount]), [['rent', 75000], ['cushion', 25000]])
  assert.equal(distribution([], [anchor, envelope, { ...goal, priority: 0 }, { ...base, id: 'rules', kind: 'settings', auto: true, order: 'priority' }], now)[0].envelopeId, 'camera')
  assert(movementError([], [anchor, envelope], event('too-much', 100001), now))
  assert(movementError([], [anchor, envelope], event('overdraft', 1, 'rent', null), now))
  assert(!validPlanning({ ...envelope, target: -1 }))
})
test('new recurring terms do not reopen paid historical periods or change overdue costs', () => {
  const changed = { ...envelope, target: 80000, due: '2026-12-20', terms: [{ due: '2026-11-20', frequency: 'monthly', target: 75000, until: '2026-12-19' }] }
  const december = new Date('2026-12-10T12:00:00Z')
  const paid = obligations([payment], [changed], december)
  assert.deepEqual(paid.map((p) => [p.period, p.missing]), [['2026-12-20', 80000]])
  const unpaid = obligations([], [changed], december)
  assert.deepEqual(unpaid.map((p) => [p.period, p.missing]), [['2026-11-20', 75000], ['2026-12-20', 80000]])
  assert(validPlanning(changed))
})
test('server serializes reservations, rejects stale/insufficient commands and deduplicates retries', () => {
  let db = applyPush(emptyDb('test'), 'phone', [change(anchor, 0, 'planning'), change(envelope, 0, 'planning')], now.toISOString()).db
  const pending = event('command-1', 75000, null, 'rent', 'pending')
  assert.equal(applyPush(db, 'phone', [change(pending, 0, 'planning')]).results[0].status, 'rejected')
  const accepted = commitPlanning(db, 'phone', pending, db.seq, now.toISOString())
  assert.equal(accepted.record.data.status, 'confirmed')
  const seq = db.seq; db = accepted.db
  assert.equal(commitPlanning(db, 'other', event('stale', 50000), seq, now.toISOString()).error, 'planning-stale')
  assert.equal(commitPlanning(db, 'other', event('too-much', 50000), db.seq, now.toISOString()).error, 'planning-funds')
  assert.equal(commitPlanning(db, 'phone', pending, seq, now.toISOString()).db.seq, db.seq)
  assert.equal(commitPlanning(db, 'phone', { ...pending, amount: 10 }, db.seq, now.toISOString()).error, 'planning-id-conflict')
  assert.equal(pull(db, 0, 500, false).records.length, 0)
  assert.equal(pull(db, 0, 500, true).records.length, 3)
  const backup = buildBackup(db, 'manual', now)
  assert.equal(backup.version, 3); assert(verifyBackup(backup)); assert.equal(backup.planning.length, 3)
  assert.equal(snapshot(db).planning.length, 3)
})
