import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validInvoicing, numberClash } from '../lib/invoicing.mjs'
import { applyPush, emptyDb, pull, snapshot } from '../lib/engine.mjs'
import { buildBackup, verifyBackup } from '../lib/backups.mjs'
import { change, op } from './helpers.mjs'

const t = '2026-11-11T10:00:00.000Z'
const party = { name: 'Ana López', taxId: '12345678Z', address: 'Calle Mayor 1', postalCode: '28013', city: 'Madrid' }
const draft = (id, over = {}) => ({ id, kind: 'invoice', status: 'draft', seriesId: 's-f', number: null, code: null, issueDate: '2026-11-11', dueDate: '2026-12-11', issuerId: 'is-1', clientId: 'cl-1', lines: [{ id: 'l1', description: 'Sesión de fotos', quantity: 100, unitPrice: 50000 }], vatRate: 2100, irpfRate: 1500, currency: 'EUR', createdAt: t, updatedAt: t, deletedAt: null, ...over })
const issued = (id, number, over = {}) => draft(id, { status: 'issued', number, code: `F-${String(number).padStart(4, '0')}`, issuedAt: t, issuer: { ...party, iban: 'ES9121000418450200051332' }, client: party, totals: { base: 50000, vat: 10500, irpf: 7500, total: 53000 }, ...over })

test('invoicing record shapes: drafts hold no number, issued invoices hold number, snapshots and totals', () => {
  assert(validInvoicing(draft('i1')))
  assert(validInvoicing(issued('i2', 26)))
  assert(!validInvoicing(draft('i3', { number: 26 })), 'draft with a number')
  assert(!validInvoicing(issued('i4', 26, { client: null })), 'issued without client snapshot')
  assert(!validInvoicing(issued('i5', 26, { totals: null })), 'issued without totals')
  assert(!validInvoicing({ ...draft('i6'), currency: 'USD' }))
  assert(validInvoicing({ id: 's-f', kind: 'series', name: 'Facturas', prefix: 'F-', digits: 4, next: 26, createdAt: t, updatedAt: t }))
  assert(!validInvoicing({ id: 's-x', kind: 'series', name: 'X', prefix: 'F-', digits: 0, next: 1, createdAt: t, updatedAt: t }))
  assert(validInvoicing({ id: 'is-1', kind: 'issuer', label: 'Autónomo', ...party, createdAt: t, updatedAt: t, logo: 'data:image/png;base64,AAAA' }))
  assert(!validInvoicing({ id: 'is-2', kind: 'issuer', label: 'x', ...party, createdAt: t, updatedAt: t, logo: 'https://evil.example/logo.png' }), 'remote logo')
  assert(validInvoicing({ id: 'invoicing-settings', kind: 'settings', vatRate: 2100, irpfRate: 1500, applyIrpf: true, dueDays: 30, createdAt: t, updatedAt: t }))
})

test('server rejects a second live invoice with the same series and number; voided numbers stay taken', () => {
  let db = emptyDb('srv-test')
  let r = applyPush(db, 'phone', [change(issued('a', 26), 0, 'invoicing'), change(draft('b'), 0, 'invoicing')], t)
  assert.deepEqual(r.results.map((x) => x.status), ['accepted', 'accepted'])
  db = r.db
  r = applyPush(db, 'pc', [change(issued('c', 26), 0, 'invoicing')], t)
  assert.equal(r.results[0].status, 'rejected'); assert.equal(r.results[0].reason, 'duplicate-number')
  r = applyPush(db, 'phone', [change(issued('a', 26, { status: 'void', voidedAt: t, voidReason: 'error' }), db.records['invoicing:a'].rev, 'invoicing')], t)
  assert.equal(r.results[0].status, 'accepted'); db = r.db
  r = applyPush(db, 'pc', [change(issued('d', 26), 0, 'invoicing')], t)
  assert.equal(r.results[0].reason, 'duplicate-number', 'number of a voided invoice was reused')
  r = applyPush(db, 'pc', [change(issued('d', 27), 0, 'invoicing')], t)
  assert.equal(r.results[0].status, 'accepted')
  assert(numberClash([issued('a', 26)], issued('z', 26)))
  assert(!numberClash([issued('a', 26)], issued('a', 26)), 'same invoice is not a clash with itself')
})

test('pull hides invoicing from apps that do not ask for it; backups carry invoices and count them', () => {
  let db = emptyDb('srv-test')
  db = applyPush(db, 'phone', [change(op('o1', { invoiceId: 'a' })), change(issued('a', 26), 0, 'invoicing')], t).db
  assert.equal(pull(db, 0, 500, true, false).records.length, 1)
  assert.equal(pull(db, 0, 500, true, true).records.length, 2)
  const b = buildBackup(db, 'manual', new Date(t))
  assert.equal(b.version, 3); assert(verifyBackup(b)); assert.equal(b.invoicing.length, 1); assert.equal(b.counts.invoices, 1)
  assert.equal(snapshot(db).invoicing.length, 1)
  assert.equal(applyPush(db, 'phone', [change(op('o2', { invoiceId: 5 }))], t).results[0].status, 'rejected', 'bad invoiceId type')
})
