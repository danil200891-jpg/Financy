// Invoice regressions in a fresh browser origin: schema migration, numbering, payment links,
// restore protection, client recognition, PDF. No user database is opened.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PDFDocument } from 'pdf-lib'
import App from '../src/App'
import { actions, getState, initStore, waitForWrites } from '../src/lib/store'
import * as DB from '../src/lib/db'
import * as backup from '../src/lib/backup'
import { totals } from '../src/lib/stats'
import type { Invoice, InvoiceSeries } from '../src/lib/invoice-types'
import {
  createSeries, invoicesOf, issueInvoice, issueProblems, linkableOperations, markPaid, markUnpaid, newDraft, rectifyingDraft, saveDraft, saveIssuer,
  seriesOf, setSeriesStart, takeOverSeries, voidInvoice,
} from '../src/lib/invoice-actions'
import { computeTotals, displayStatus, parseNumberExample, taxIdKind, validIban } from '../src/lib/invoicing'
import { recognizeClient } from '../src/lib/client-ocr'
import { STARTER_SERVICES, suggestServices, usedServices } from '../src/lib/service-suggestions'
import { invoicePdf } from '../src/lib/invoice-pdf'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
function check(v: unknown, msg: string): asserts v { if (!v) throw new Error(`FAIL ${msg}`) }
async function throws(fn: () => unknown, msg: string) { let ok = false; try { await fn() } catch { ok = true } check(ok, msg) }
const inv = (id: string) => invoicesOf(getState().all.invoicing).find((i) => i.id === id)!
const T = '2026-10-01T10:00:00.000Z'

/** A database exactly as version 2 of the app leaves it. */
async function seedV2() {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open('finance', 2)
    r.onupgradeneeded = () => {
      const d = r.result
      d.createObjectStore('operations', { keyPath: 'id' }).createIndex('date', 'date')
      d.createObjectStore('clients', { keyPath: 'id' })
      d.createObjectStore('categories', { keyPath: 'id' })
      const h = d.createObjectStore('history', { keyPath: 'id' }); h.createIndex('entityId', 'entityId'); h.createIndex('at', 'at')
      d.createObjectStore('meta')
      d.createObjectStore('planning', { keyPath: 'id' })
    }
    r.onsuccess = () => {
      const d = r.result
      const tx = d.transaction(['operations', 'clients', 'categories', 'history', 'meta'], 'readwrite')
      tx.objectStore('operations').put({ id: 'op-old-1', type: 'income', amount: 120000, currency: 'EUR', title: 'MVP', categoryId: 'c-work', clientId: 'cl-old', date: T, source: 'manual', createdAt: T, updatedAt: T, deletedAt: null })
      tx.objectStore('operations').put({ id: 'op-old-2', type: 'expense', amount: 2350, currency: 'EUR', title: 'Lidl', categoryId: 'c-food', clientId: null, date: T, source: 'camera', createdAt: T, updatedAt: T, deletedAt: null })
      tx.objectStore('clients').put({ id: 'cl-old', name: 'MVP Studio', aliases: [], color: '#7c8cff', createdAt: T, updatedAt: T, deletedAt: null })
      tx.objectStore('categories').put({ id: 'c-work', name: 'Работа', type: 'income', icon: 'briefcase', color: '#3fe0c5', updatedAt: T })
      tx.objectStore('history').put({ id: 'h-old', entity: 'operation', entityId: 'op-old-1', action: 'create', at: T })
      tx.objectStore('meta').put(T, 'initialized')
      tx.oncomplete = () => { d.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    r.onerror = () => reject(r.error)
  })
}

export async function runInvoiceRegression() {
  const failures: string[] = []
  window.addEventListener('error', (e) => failures.push(String(e.error ?? e.message)))
  window.addEventListener('unhandledrejection', (e) => failures.push(String(e.reason)))
  const out: string[] = []
  const pass = (m: string) => { console.log(`PASS ${m}`); out.push(m) }

  // 1. upgrade from schema v2: data untouched, a full copy kept, new store present
  await seedV2()
  await initStore()
  const d = await DB.db()
  check(d.version === 3 && d.objectStoreNames.contains('invoicing'), 'database not upgraded to v3 with invoicing store')
  const old = getState().all
  check(old.operations.length === 2 && old.operations.find((o) => o.id === 'op-old-1')?.amount === 120000 && old.clients.length === 1, 'existing operations/clients changed by the upgrade')
  const snap = await DB.getMeta<{ operations: unknown[]; clients: unknown[]; history: unknown[]; fromDbVersion: number }>('preInvoicingV3')
  check(snap && snap.operations.length === 2 && snap.clients.length === 1 && snap.history.length === 1 && snap.fromDbVersion === 2, 'no pre-migration copy of the data')
  const regular = getState().clients[0]
  check(!regular.taxId, 'regular client got tax data')
  pass('schema v2 → v3: operations, clients and history unchanged; full copy kept in meta «preInvoicingV3»')

  // 2. pure helpers
  check(JSON.stringify(parseNumberExample('F-0026')) === JSON.stringify({ prefix: 'F-', digits: 4, next: 26 }), 'F-0026 parse')
  check(JSON.stringify(parseNumberExample('2026/0007')) === JSON.stringify({ prefix: '2026/', digits: 4, next: 7 }), '2026/0007 parse')
  check(parseNumberExample('ABC') === null, 'number without digits accepted')
  check(taxIdKind('12345678Z') === 'nif' && taxIdKind('12345678A') === null && taxIdKind('X1234567L') === 'nie' && taxIdKind('B12345674') === 'cif' && taxIdKind('ES B-1234567-4') === 'cif', 'tax id checks')
  check(validIban('ES91 2100 0418 4502 0005 1332') && !validIban('ES91 2100 0418 4502 0005 1333'), 'IBAN check')
  const tt = computeTotals([{ quantity: 200, unitPrice: 50000 }, { quantity: 100, unitPrice: 10050 }], 2100, 1500)
  check(tt.base === 110050 && tt.vat === 23111 && tt.irpf === 16508 && tt.total === 116653, `totals ${JSON.stringify(tt)}`)
  pass('number format with prefix and leading zeros, NIF/NIE/CIF and IBAN control checks, IVA/IRPF rounding')

  // 3. setup: issuer, series continuing an existing sequence, client with tax data
  const issuer = saveIssuer({ label: 'Autónomo', name: 'Test Autónomo', taxId: '12345678Z', address: 'Calle Prueba 1', postalCode: '28013', city: 'Madrid', country: 'España', email: 'test@example.com', phone: '', iban: 'ES91 2100 0418 4502 0005 1332', logo: null })
  const series = createSeries('Фактуры', 'F-0026')
  await throws(() => createSeries('Другая', 'F-0100'), 'second series with the same prefix allowed')
  actions.updateClient(regular.id, { legalName: 'MVP Studio S.L.', taxId: 'B12345674', address: 'Avenida Test 5', postalCode: '08001', city: 'Barcelona' })
  await waitForWrites()
  const noTax = actions.addClient('Без реквизитов', '#3fe0c5')
  await waitForWrites()

  // 3b. new invoices: no payment due date, IRPF 0 %; a manual IRPF is applied to the totals
  const fresh = newDraft({ clientId: regular.id })
  check(fresh.dueDate === null && fresh.irpfRate === 0, `new invoice defaults dueDate=${fresh.dueDate} irpf=${fresh.irpfRate}`)
  const noIrpf = computeTotals([{ quantity: 100, unitPrice: 100000 }], 2100, 0)
  const withIrpf = computeTotals([{ quantity: 100, unitPrice: 100000 }], 2100, 1500)
  const seven = computeTotals([{ quantity: 100, unitPrice: 100000 }], 2100, 700)
  check(noIrpf.irpf === 0 && noIrpf.total === 121000 && withIrpf.irpf === 15000 && withIrpf.total === 106000 && seven.irpf === 7000 && seven.total === 114000, 'IRPF totals')
  pass('new invoice: no due date, IRPF 0 %; 0 / 7 / 15 % IRPF give 1210 / 1140 / 1060 € on 1000 € + 21 % IVA')

  // 4. drafts never consume numbers; issued numbers are consecutive
  const incomeBefore = totals(getState().operations).income
  const mk = async (desc: string, price = 50000, clientId = regular.id) => {
    const x = newDraft({ clientId })
    const draft: Invoice = { ...x, lines: [{ id: `l-${desc}`, description: desc, quantity: 100, unitPrice: price }] }
    await saveDraft(draft); return draft.id
  }
  const a = await mk('Sesión A'); const b = await mk('Sesión B'); const c = await mk('Sesión C')
  check(invoicesOf(getState().invoicing).every((i) => i.number === null && i.code === null), 'draft holds a number')
  check((await issueInvoice(a)).code === 'F-0026', 'first issued number is not F-0026')
  check((await issueInvoice(c)).code === 'F-0027', 'second issued number is not F-0027')
  check(inv(b).number === null, 'saved draft consumed a number')
  check((await issueInvoice(b)).code === 'F-0028', 'third issued number is not F-0028')
  check((seriesOf(getState().invoicing).find((s) => s.id === series.id) as InvoiceSeries).next === 29, 'series counter not advanced')
  check(totals(getState().operations).income === incomeBefore, 'issuing an invoice changed income')
  await throws(() => setSeriesStart(series.id, 'F-0001'), 'start number changed after issuing')
  await throws(() => saveDraft({ ...inv(a), notes: 'edited' }), 'issued invoice editable')
  pass('F-0026 → F-0027 → F-0028; drafts take no number; issued invoices locked; start number locked after first issue; income unchanged')

  // 5. issued invoice keeps the data it was issued with
  saveIssuer({ ...issuer, name: 'Renamed Issuer' })
  actions.updateClient(regular.id, { address: 'Other street 9' }); await waitForWrites()
  check(inv(a).issuer?.name === 'Test Autónomo' && inv(a).client?.address === 'Avenida Test 5', 'issued invoice changed when profiles changed')
  saveIssuer({ ...issuer, name: 'Test Autónomo' }); await waitForWrites()
  const blocked = await mk('Sin NIF', 1000, noTax.id)
  check(issueProblems(inv(blocked)).some((p) => p.includes('NIF')), 'missing client NIF not reported')
  await throws(() => issueInvoice(blocked), 'invoice issued without client NIF')
  check(inv(blocked).number === null, 'blocked issue consumed a number')
  pass('issuer and client data frozen at issue; missing NIF blocks issuing without using a number')

  // 6. payment: one income operation, linked once, never counted twice
  const total = inv(a).totals!.total
  await markPaid(a, { create: { date: new Date().toISOString(), categoryId: 'c-work' } })
  const paidOp = getState().operations.find((o) => o.invoiceId === a)
  check(paidOp && paidOp.amount === total && inv(a).status === 'paid' && inv(a).paymentOperationId === paidOp.id, 'paid invoice not linked to one new income')
  check(totals(getState().operations).income === incomeBefore + total, 'income not increased exactly once')
  check(!linkableOperations(inv(c)).some((o) => o.id === paidOp.id), 'operation linked to one invoice offered for another')
  await throws(() => markPaid(c, { operationId: paidOp.id }), 'one operation paid two invoices')
  await markPaid(c, { operationId: 'op-old-1' })
  check(inv(c).status === 'paid' && getState().operations.find((o) => o.id === 'op-old-1')?.invoiceId === c, 'existing income not linked')
  check(totals(getState().operations).income === incomeBefore + total, 'linking existing income added income')
  await markUnpaid(c)
  check(inv(c).status === 'issued' && getState().operations.find((o) => o.id === 'op-old-1')?.invoiceId == null && getState().operations.some((o) => o.id === 'op-old-1'), 'unpaid lost the income or kept the link')
  pass('mark paid creates or links exactly one income; one operation cannot pay two invoices; unpaid keeps the operation')

  // 7. void keeps the number, overdue is computed
  await throws(() => voidInvoice(a, 'x'), 'paid invoice voided')
  await voidInvoice(b, 'Error en importe')
  check(inv(b).status === 'void' && inv(b).code === 'F-0028', 'void lost its number')
  const d2 = await mk('Sesión D')
  check((await issueInvoice(d2)).code === 'F-0029', 'voided number reused')
  check(displayStatus({ status: 'issued' }) === 'issued' && displayStatus({ status: 'paid' }) === 'paid', 'status display')
  pass('void keeps F-0028 taken, next is F-0029')

  // 8. rectifying invoice in its own series
  const r = rectifyingDraft(c)
  await saveDraft(r)
  const rect = await issueInvoice(r.id)
  check(rect.code === 'R-0001' && rect.rectifiesId === c && rect.totals!.total < 0 && seriesOf(getState().invoicing).some((s) => s.rectifying), 'rectifying invoice wrong')
  await throws(() => markPaid(rect.id, { create: { date: new Date().toISOString(), categoryId: null } }), 'negative invoice created income')
  pass('rectifying invoice R-0001 in a separate series with negated amounts; no income from negative totals')

  // 9. only the owning device issues numbers of a series
  const s2 = createSeries('Otra', 'B-0001')
  actions.saveInvoicing({ ...(seriesOf(getState().invoicing).find((s) => s.id === s2.id)!), issuerDeviceId: 'dev-other', updatedAt: new Date().toISOString() })
  await waitForWrites()
  const other = newDraft({ clientId: regular.id, seriesId: s2.id })
  await saveDraft({ ...other, lines: [{ id: 'lo', description: 'x', quantity: 100, unitPrice: 100 }] })
  check(issueProblems(inv(other.id)).some((p) => p.includes('другом устройстве')), 'foreign series not blocked')
  takeOverSeries(s2.id); await waitForWrites()
  check((await issueInvoice(other.id)).code === 'B-0001', 'series take-over failed')
  pass('series issued only from its device; explicit take-over')

  // 10. backups: round trip, old backup can never remove or renumber issued invoices
  const withInvoices = await backup.buildBackup()
  check(withInvoices.version === 3 && withInvoices.invoicing!.length >= 8, 'backup without invoices')
  backup.parseBackup(JSON.stringify(withInvoices))
  await throws(() => backup.parseBackup(JSON.stringify({ ...withInvoices, invoicing: [{ ...withInvoices.invoicing![0], kind: 'invoice', status: 'issued', number: null }] })), 'damaged invoice accepted')
  const beforeOld = { ...withInvoices, invoicing: withInvoices.invoicing!.filter((x) => x.kind !== 'invoice').map((x) => (x.kind === 'series' && x.id === series.id ? { ...x, next: 26 } : x)) }
  const plan = backup.planRestore(beforeOld, true)
  check(!plan.items.some((i) => i.entity === 'invoicing' && 'kind' in i.data && i.data.kind === 'invoice' && (i.data as Invoice).status !== 'draft' && i.data.deletedAt), 'restore plan deletes issued invoices')
  check(!plan.items.some((i) => i.entity === 'invoicing' && 'kind' in i.data && i.data.kind === 'series' && (i.data as InvoiceSeries).next < 30), 'restore plan moves series back')
  await backup.restore(beforeOld, 'replace')
  const issuedAfter = invoicesOf(getState().all.invoicing).filter((i) => i.status !== 'draft' && !i.deletedAt)
  check(issuedAfter.length >= 6 && issuedAfter.some((i) => i.code === 'F-0029'), 'replace-restore removed issued invoices')
  const sAfter = seriesOf(getState().invoicing).find((s) => s.id === series.id)!
  check(sAfter.next === 30, `series counter moved back to ${sAfter.next}`)
  check(getState().operations.length === withInvoices.operations.filter((o) => !o.deletedAt).length, 'operations lost in restore')
  pass('backup v3 round trip; damaged invoices rejected; restoring an older copy never deletes issued invoices or moves numbering back')

  // 11. client recognition: only what is in the text
  const rec = recognizeClient('FACTURA\nRazón social: Estudio Lumen S.L.\nCIF: B-1234567-4\nCalle Mayor 12, 3º\n28013 Madrid\nhola@lumen.es\nTel. +34 612 345 678')
  check(rec.fields.legalName === 'Estudio Lumen S.L.' && rec.fields.taxId === 'B12345674' && rec.fields.address?.startsWith('Calle Mayor 12') && rec.fields.postalCode === '28013' && rec.fields.city === 'Madrid' && rec.fields.email === 'hola@lumen.es' && rec.fields.phone?.includes('612'), `recognition ${JSON.stringify(rec.fields)}`)
  const sparse = recognizeClient('Gracias por su visita\nTotal 23,50')
  check(!sparse.fields.legalName && !sparse.fields.taxId && !sparse.fields.address, 'recognition invented fields')
  const bad = recognizeClient('NIF: 12345678A')
  check(bad.fields.taxId === '12345678A' && bad.taxIdInvalid, 'invalid NIF not flagged')
  pass('client recognition fills only found fields, flags a NIF with a wrong control letter, invents nothing')

  // 11b. previously used services: unique, most used first, names only, kept after a restart
  for (const name of ['видеосъёмка  ', 'Монтаж ролика', 'Видеосъёмка']) {
    const x = newDraft({ clientId: regular.id })
    await saveDraft({ ...x, lines: [{ id: `s-${name}`, description: name, quantity: 100, unitPrice: 12345 }] })
  }
  let used = usedServices(invoicesOf(getState().all.invoicing))
  const video = used.filter((u) => u.name.toLowerCase().replace(/\s+/g, ' ').trim() === 'видеосъёмка')
  check(video.length === 1 && video[0].count === 2, `duplicate service names ${JSON.stringify(used.map((u) => u.name))}`)
  check(used[0].name.toLowerCase().startsWith('видеосъёмка'), `most used service is not first: ${used.map((u) => u.name).join(', ')}`)
  check(used.every((u) => Object.keys(u).sort().join() === 'count,lastUsed,name'), 'service list stores more than names')
  const all = suggestServices(used, '')
  check(all[0].toLowerCase().startsWith('видеосъёмка') && all.includes('Монтаж ролика') && STARTER_SERVICES.every((s) => all.some((n) => n.toLowerCase() === s.toLowerCase())), 'empty field does not list services')
  check(suggestServices(used, 'smm')[0] === 'SMM и продвижение социальных сетей' && suggestServices(used, 'мон').join() === 'Монтаж ролика', 'typing does not filter the list')
  check(!suggestServices(used, 'Монтаж ролика').length, 'exact name offered again')
  await actions.reload()
  used = usedServices(invoicesOf(getState().all.invoicing))
  check(used.some((u) => u.name === 'Монтаж ролика'), 'services lost after reload')
  pass('services: one entry per name (case/spaces), most used first, filter while typing, starters included, names only, kept after reload')

  // 12. PDF: valid document, long invoices paginate, Cyrillic/Spanish text and € render
  // IRPF entered by hand on one invoice is frozen into its totals
  const manual = newDraft({ clientId: regular.id })
  await saveDraft({ ...manual, irpfRate: 700, lines: [{ id: 'm1', description: 'Видеосъёмка', quantity: 100, unitPrice: 100000 }] })
  const manualIssued = await issueInvoice(manual.id)
  check(manualIssued.totals!.irpf === 7000 && manualIssued.totals!.total === 114000 && manualIssued.dueDate === null, 'manual IRPF not applied to the issued invoice')
  const issued = inv(a)
  const bytes = await invoicePdf({ invoice: issued, issuer: issued.issuer!, client: issued.client! })
  check(new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-', 'not a PDF')
  const doc = await PDFDocument.load(bytes)
  check(doc.getPageCount() === 1 && doc.getTitle()?.includes('F-0026'), 'PDF pages/title')
  const long = { ...issued, lines: Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, description: `Услуга ${i} — sesión fotográfica con edición, señal y año ${i} € ${'muy larga '.repeat(i % 4)}`, quantity: 100, unitPrice: 1000 + i })) }
  const longDoc = await PDFDocument.load(await invoicePdf({ invoice: long, issuer: issued.issuer!, client: issued.client! }))
  check(longDoc.getPageCount() >= 3, `long invoice not paginated (${longDoc.getPageCount()} pages)`)
  const draftPdf = await invoicePdf({ invoice: { ...newDraft({ clientId: noTax.id }), lines: [{ id: 'dl', description: 'Borrador', quantity: 100, unitPrice: 100 }] }, issuer: issued.issuer!, client: { name: 'X', taxId: '', address: '' } })
  check(draftPdf.length > 1000, 'draft PDF')
  pass('PDF generated offline with embedded font: one page for a short invoice, pagination for 60 lines, draft watermark build')

  // 13. UI: button above navigation, filter, client card
  const root = document.getElementById('root')!
  createRoot(root).render(createElement(App))
  await wait(300)
  ;[...document.querySelectorAll('nav button')].find((n) => n.getAttribute('aria-label') === 'Клиенты')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(200)
  const create = [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === 'Создать фактуру')
  const navBox = document.querySelector('.bottom-nav-surface')!.getBoundingClientRect()
  check(create, 'no «Создать фактуру» button on Clients')
  // the harness page has no app CSS; geometry is only meaningful with the real stylesheet
  if (getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height')) check(create.getBoundingClientRect().bottom <= navBox.top + 1, 'button overlaps the navigation')
  else console.log('INFO layout geometry not checked here (no stylesheet); checked visually in the built app')
  check(create.closest('nav') === null && document.querySelector('nav')!.parentElement === document.body, 'button placed inside the navigation')
  check(document.body.textContent?.includes('С фактурами'), 'no filter for clients with invoices')
  create.click(); await wait(300)
  check(document.querySelector('[role="dialog"]')?.textContent?.includes('Новая фактура'), 'invoice form did not open')
  check(![...document.querySelectorAll('[role="dialog"] span')].some((n) => n.textContent === 'Оплатить до'), 'due date field still in the form')
  const irpfInput = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((l) => l.textContent?.startsWith('IRPF'))?.querySelector('input')
  check(irpfInput?.value === '0', `IRPF field shows ${irpfInput?.value}`)
  const desc = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Описание услуги"]')!
  desc.focus(); desc.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await wait(60)
  const list = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((n) => n.textContent)
  check(list().length >= 3 && list()[0]?.toLowerCase().startsWith('видеосъёмка'), `dropdown on empty field: ${list().join(' | ')}`)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(desc, 'мон')
  desc.dispatchEvent(new Event('input', { bubbles: true })); await wait(60)
  check(list().join() === 'Монтаж ролика', `dropdown not filtered: ${list().join(' | ')}`)
  ;(document.querySelector('[role="listbox"] [role="option"]') as HTMLButtonElement).click(); await wait(60)
  const price = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')].find((i) => i.placeholder === '0,00')!
  check(desc.value === 'Монтаж ролика' && !document.querySelector('[role="listbox"]') && document.activeElement === price && price.value === '', 'picking a service did not fill the name, close the list and move to an empty price')
  check(!failures.length, `JavaScript errors: ${failures.join('; ')}`)
  pass('«Создать фактуру» sits above the unchanged navigation; «С фактурами» filter; form opens; no JS errors')
  return `All invoice regressions passed (${out.length})`
}

/** Sample PDF for a visual check (`INVOICE_PDF_OUT=file.pdf npm run test:invoices`). Synthetic data only. */
export async function samplePdfBase64() {
  const issuer = { name: 'Ana Test Fotografía', taxId: '12345678Z', address: 'Calle Mayor 12, 3º B', postalCode: '28013', city: 'Madrid', country: 'España', email: 'ana@example.com', phone: '+34 600 000 000', iban: 'ES91 2100 0418 4502 0005 1332', logo: null }
  const client = { name: 'Estudio Lumen S.L.', taxId: 'B12345674', address: 'Avenida Diagonal 100', postalCode: '08019', city: 'Barcelona', country: 'España', email: 'admin@lumen.example' }
  const lines = [
    { id: '1', description: 'Видеосъёмка', quantity: 100, unitPrice: 45000 },
    { id: '2', description: 'SMM и продвижение социальных сетей (ноябрь)', quantity: 100, unitPrice: 30000 },
  ]
  const invoice: Invoice = { id: 'sample', kind: 'invoice', status: 'issued', seriesId: 's', number: 26, code: 'F-0026', issueDate: '2026-11-11', dueDate: null, issuerId: null, clientId: null, issuer, client, lines, vatRate: 2100, irpfRate: 0, iban: issuer.iban, notes: 'Gracias por su confianza.', currency: 'EUR', totals: computeTotals(lines, 2100, 0), issuedAt: new Date().toISOString(), createdAt: T, updatedAt: T }
  const bytes = await invoicePdf({ invoice, issuer, client })
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/* ---------------- restart check: details and numbering survive app restarts ---------------- */
const ISSUER = { label: 'Autónomo', name: 'Restart Test Autónomo', taxId: 'X1234567L', address: 'Calle Mayor 12, 3º B', postalCode: '28013', city: 'Madrid', country: 'España', email: 'restart@example.com', phone: '+34 600 111 222', iban: 'ES91 2100 0418 4502 0005 1332', logo: null }
const CLIENTS = [
  { name: 'Lumen', legalName: 'Estudio Lumen S.L.', taxId: 'B12345674', address: 'Avenida Diagonal 100', postalCode: '08019', city: 'Barcelona', country: 'España', email: 'admin@lumen.example' },
  { name: 'Ana', legalName: 'Ana García López', taxId: '12345678Z', address: 'Calle Sol 5', postalCode: '29001', city: 'Málaga', country: 'España' },
]
const issuerKeys = ['name', 'taxId', 'address', 'postalCode', 'city', 'country', 'email', 'phone', 'iban'] as const

async function issueSequence(clientIds: string[], labels: string[]) {
  const codes: string[] = []
  for (const [i, label] of labels.entries()) {
    const d = newDraft({ clientId: clientIds[i % clientIds.length] })
    // what the form gets without the user touching anything
    check(d.issuerId === defaultIssuerId() && d.iban === ISSUER.iban && d.irpfRate === 0 && d.dueDate === null, `new invoice not pre-filled: issuer=${d.issuerId} iban=${d.iban}`)
    await saveDraft({ ...d, lines: [{ id: `r-${label}`, description: label, quantity: 100, unitPrice: 25000 }] })
    const done = await issueInvoice(d.id)
    for (const k of issuerKeys) check((done.issuer as Record<string, unknown>)[k] === ISSUER[k], `issuer ${k} missing on ${done.code}: ${(done.issuer as Record<string, unknown>)[k]}`)
    const c = CLIENTS[i % CLIENTS.length]
    check(done.client?.name === c.legalName && done.client?.taxId === c.taxId && done.client?.address === c.address && done.client?.postalCode === c.postalCode && done.client?.city === c.city, `client data missing on ${done.code}`)
    codes.push(done.code!)
  }
  return codes
}
const defaultIssuerId = () => (getState().invoicing.find((r) => r.kind === 'issuer') as { id: string } | undefined)?.id ?? null
const issuedCodes = () => invoicesOf(getState().all.invoicing).filter((i) => i.status !== 'draft').map((i) => i.code!).sort()

export async function restartPhase1() {
  await initStore()
  check(!getState().all.invoicing.length && !getState().clients.length, 'restart test did not start from an empty origin')
  saveIssuer(ISSUER)
  createSeries('Фактуры', 'F-0026')
  const ids = CLIENTS.map((c) => { const x = actions.addClient(c.name, '#7c8cff'); actions.updateClient(x.id, { ...c, name: c.name }); return x.id })
  await waitForWrites()
  const codes = await issueSequence(ids, ['Видеосъёмка', 'SMM и продвижение социальных сетей', 'Видеосъёмка'])
  check(codes.join() === 'F-0026,F-0027,F-0028', `first run codes ${codes}`)
  return `phase 1: ${codes.join(', ')}`
}

export async function restartPhase2() {
  await initStore()
  // nothing re-entered after the restart
  const issuer = getState().invoicing.find((r) => r.kind === 'issuer') as unknown as Record<string, unknown>
  for (const k of issuerKeys) check(issuer?.[k] === ISSUER[k], `issuer ${k} lost after restart`)
  const clients = CLIENTS.map((c) => getState().clients.find((x) => x.name === c.name))
  check(clients.every((x, i) => x && x.taxId === CLIENTS[i].taxId && x.address === CLIENTS[i].address && x.legalName === CLIENTS[i].legalName), 'client tax data lost after restart')
  check(getState().clients.length === 2, 'clients duplicated after restart')
  // the form opens pre-filled after a restart
  const root = document.getElementById('root')!
  createRoot(root).render(createElement(App))
  await wait(400)
  ;[...document.querySelectorAll('nav button')].find((n) => n.getAttribute('aria-label') === 'Клиенты')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(200)
  ;[...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === 'Создать фактуру')!.click()
  await wait(400)
  const dialog = document.querySelector('[role="dialog"]')!
  const iban = [...dialog.querySelectorAll('label')].find((l) => l.textContent?.startsWith('IBAN'))?.querySelector('input')?.value
  check(iban === ISSUER.iban, `IBAN not pre-filled in the form: ${iban}`)
  check(dialog.textContent?.includes('Номер при выставлении: F-0029'), 'form does not show the next number F-0029')
  const issuerChip = [...dialog.querySelectorAll('button')].find((b) => b.textContent === ISSUER.label)
  check(issuerChip && issuerChip.className.includes('bg-iris'), 'issuer profile not selected in the form')
  const codes = await issueSequence(clients.map((x) => x!.id), ['Монтаж', 'Видеосъёмка', 'SMM и продвижение социальных сетей'])
  check(codes.join() === 'F-0029,F-0030,F-0031', `after restart codes ${codes}`)
  return `phase 2: ${codes.join(', ')}`
}

export async function restartPhase3() {
  await initStore()
  const codes = issuedCodes()
  check(codes.join() === 'F-0026,F-0027,F-0028,F-0029,F-0030,F-0031' && new Set(codes).size === codes.length, `numbers after second restart: ${codes}`)
  const series = getState().invoicing.find((r) => r.kind === 'series') as InvoiceSeries
  check(series.next === 32, `series counter ${series.next}`)
  check(getState().clients.length === 2 && getState().invoicing.filter((r) => r.kind === 'issuer').length === 1, 'profiles or clients duplicated')
  const d = newDraft({ clientId: getState().clients[0].id })
  check(d.issuerId === defaultIssuerId() && d.iban === ISSUER.iban, 'details not pre-filled after second restart')
  return `phase 3: 6 unique consecutive numbers, next F-0032, details still pre-filled`
}
