// Invoicing actions on top of the store. Every write goes through store.ts (history + sync).
import type { Invoice, InvoiceLine, InvoiceSeries, InvoicingRecord, InvoicingSettings, IssuerProfile, PartySnapshot } from './invoice-types'
import type { Client, Operation } from './types'
import { actions, getDeviceId, getState, uid, waitForWrites } from './store'
import { computeTotals, formatCode, lastIssued, localDay, parseNumberExample, taxIdKind } from './invoicing'

const now = () => new Date().toISOString()
export const SETTINGS_ID = 'invoicing-settings'
export const DEFAULT_SETTINGS: Omit<InvoicingSettings, 'createdAt' | 'updatedAt'> = { id: SETTINGS_ID, kind: 'settings', vatRate: 2100, irpfRate: 0, applyIrpf: false, dueDays: 0 }

/* ---------------- selectors (pure, take the live list) ---------------- */

export const issuersOf = (list: InvoicingRecord[]) => list.filter((r): r is IssuerProfile => r.kind === 'issuer')
export const seriesOf = (list: InvoicingRecord[]) => list.filter((r): r is InvoiceSeries => r.kind === 'series')
export const invoicesOf = (list: InvoicingRecord[]) => list.filter((r): r is Invoice => r.kind === 'invoice')
export const settingsOf = (list: InvoicingRecord[]): InvoicingSettings =>
  (list.find((r) => r.kind === 'settings') as InvoicingSettings | undefined) ?? { ...DEFAULT_SETTINGS, createdAt: '', updatedAt: '' }
export const defaultIssuer = (list: InvoicingRecord[]) => { const all = issuersOf(list); return all.find((i) => i.isDefault) ?? all[0] }
export const defaultSeries = (list: InvoicingRecord[]) => { const all = seriesOf(list).filter((s) => !s.rectifying); return all.find((s) => s.isDefault) ?? all[0] }

const live = () => getState().invoicing
const allInvoices = () => invoicesOf(getState().all.invoicing)
const find = <T extends InvoicingRecord>(id: string) => getState().invoicing.find((r) => r.id === id) as T | undefined

/* ---------------- settings, issuers, series ---------------- */

export function saveSettings(patch: Partial<Pick<InvoicingSettings, 'vatRate' | 'irpfRate' | 'applyIrpf' | 'dueDays'>>) {
  const cur = live().find((r) => r.kind === 'settings') as InvoicingSettings | undefined
  const t = now()
  actions.saveInvoicing({ ...DEFAULT_SETTINGS, ...cur, ...patch, createdAt: cur?.createdAt ?? t, updatedAt: t })
}

export function saveIssuer(data: Omit<IssuerProfile, 'id' | 'kind' | 'createdAt' | 'updatedAt'> & { id?: string }) {
  const t = now()
  const cur = data.id ? find<IssuerProfile>(data.id) : undefined
  const first = !issuersOf(live()).length
  const rec: IssuerProfile = { ...cur, ...data, id: cur?.id ?? uid('iss'), kind: 'issuer', createdAt: cur?.createdAt ?? t, updatedAt: t, deletedAt: null, isDefault: data.isDefault ?? cur?.isDefault ?? first }
  if (rec.isDefault) for (const other of issuersOf(live())) if (other.id !== rec.id && other.isDefault) actions.saveInvoicing({ ...other, isDefault: false, updatedAt: t })
  actions.saveInvoicing(rec)
  return rec
}

/** Issued invoices keep their own frozen copy of the issuer, so a profile can be removed safely. */
export function removeIssuer(id: string) {
  const cur = find<IssuerProfile>(id)
  if (!cur) return
  const t = now()
  actions.saveInvoicing({ ...cur, deletedAt: t, updatedAt: t })
}

export function createSeries(name: string, example: string, rectifying = false) {
  const parsed = parseNumberExample(example)
  if (!parsed) throw new Error('Укажите номер с цифрами в конце, например F-0026.')
  const prefix = parsed.prefix.trim() ? parsed.prefix : parsed.prefix
  if (seriesOf(live()).some((s) => s.prefix.toUpperCase() === prefix.toUpperCase()))
    throw new Error(`Серия с префиксом «${prefix || 'без префикса'}» уже есть. Номера двух серий не должны совпадать.`)
  const t = now()
  const first = !seriesOf(live()).some((s) => !s.rectifying)
  const rec: InvoiceSeries = { id: uid('ser'), kind: 'series', name: name.trim() || (rectifying ? 'Исправленные' : 'Фактуры'), ...parsed, prefix, rectifying, isDefault: !rectifying && first, issuerDeviceId: getDeviceId(), createdAt: t, updatedAt: t, deletedAt: null }
  actions.saveInvoicing(rec)
  return rec
}

export const seriesUsed = (seriesId: string) => lastIssued(allInvoices(), seriesId)

/**
 * The starting number can be set while nothing was issued in the series. After the first issued
 * invoice the sequence continues automatically and is never renumbered — use a new series instead.
 */
export function setSeriesStart(id: string, example: string) {
  const cur = find<InvoiceSeries>(id)
  if (!cur) return
  if (seriesUsed(id)) throw new Error('В этой серии уже есть выставленные фактуры. Нумерация продолжается автоматически; для другой нумерации создайте новую серию.')
  const parsed = parseNumberExample(example)
  if (!parsed) throw new Error('Укажите номер с цифрами в конце, например F-0026.')
  if (seriesOf(live()).some((s) => s.id !== id && s.prefix.toUpperCase() === parsed.prefix.toUpperCase())) throw new Error('Такой префикс уже используется другой серией.')
  actions.saveInvoicing({ ...cur, ...parsed, updatedAt: now() })
}

export function renameSeries(id: string, name: string, isDefault?: boolean) {
  const cur = find<InvoiceSeries>(id)
  if (!cur) return
  const t = now()
  if (isDefault) for (const s of seriesOf(live())) if (s.id !== id && s.isDefault) actions.saveInvoicing({ ...s, isDefault: false, updatedAt: t })
  actions.saveInvoicing({ ...cur, name: name.trim() || cur.name, ...(isDefault !== undefined ? { isDefault } : {}), updatedAt: t })
}

export const seriesOwnedHere = (s: InvoiceSeries) => !s.issuerDeviceId || s.issuerDeviceId === getDeviceId()

/** Make this device the one that issues numbers in the series (the user confirms it in the UI). */
export function takeOverSeries(id: string) {
  const cur = find<InvoiceSeries>(id)
  if (cur) actions.saveInvoicing({ ...cur, issuerDeviceId: getDeviceId(), updatedAt: now() })
}

/* ---------------- drafts ---------------- */

export const newLine = (): InvoiceLine => ({ id: uid('ln'), description: '', quantity: 100, unitPrice: 0 })

export function newDraft(opts: { clientId?: string | null; issuerId?: string | null; seriesId?: string | null } = {}): Invoice {
  const list = live()
  const st = settingsOf(list)
  const issuer = (opts.issuerId && find<IssuerProfile>(opts.issuerId)) || defaultIssuer(list)
  const series = (opts.seriesId && find<InvoiceSeries>(opts.seriesId)) || defaultSeries(list)
  const t = now()
  const today = localDay()
  return {
    id: uid('inv'), kind: 'invoice', status: 'draft', seriesId: series?.id ?? '', number: null, code: null,
    // invoices carry no payment due date
    issueDate: today, dueDate: null,
    issuerId: issuer?.id ?? null, clientId: opts.clientId ?? null, lines: [newLine()],
    // IRPF always starts at 0 %; the user sets a retention per invoice when needed
    vatRate: st.vatRate, irpfRate: 0, iban: issuer?.iban ?? '', notes: '', currency: 'EUR',
    createdAt: t, updatedAt: t, deletedAt: null,
  }
}

export function saveDraft(inv: Invoice) {
  const cur = find<Invoice>(inv.id)
  if (cur && cur.status !== 'draft') throw new Error('Выставленную фактуру изменить нельзя.')
  actions.saveInvoicing({ ...inv, status: 'draft', number: null, code: null, updatedAt: now() })
  return waitForWrites()
}

export function deleteDraft(id: string) {
  const cur = find<Invoice>(id)
  if (!cur || cur.status !== 'draft') throw new Error('Удалить можно только черновик. Выставленную фактуру можно аннулировать.')
  const t = now()
  actions.saveInvoicing({ ...cur, deletedAt: t, updatedAt: t })
}

/* ---------------- issuing ---------------- */

export const issuerSnapshot = (i: IssuerProfile, iban?: string) => ({
  name: i.name.trim(), taxId: i.taxId.trim(), address: i.address.trim(), postalCode: i.postalCode?.trim() || undefined, city: i.city?.trim() || undefined,
  country: i.country?.trim() || undefined, email: i.email?.trim() || undefined, phone: i.phone?.trim() || undefined, iban: (iban ?? i.iban)?.trim() || undefined, logo: i.logo ?? null,
})
export const clientSnapshot = (c: Client): PartySnapshot => ({
  name: (c.legalName || c.name).trim(), taxId: (c.taxId ?? '').trim(), address: (c.address ?? '').trim(), postalCode: c.postalCode?.trim() || undefined,
  city: c.city?.trim() || undefined, country: c.country?.trim() || undefined, email: c.email?.trim() || undefined, phone: c.phone?.trim() || undefined,
})

/** Everything that blocks issuing, in plain words. Empty list = ready. */
export function issueProblems(inv: Invoice): string[] {
  const out: string[] = []
  const series = find<InvoiceSeries>(inv.seriesId)
  const issuer = inv.issuerId ? find<IssuerProfile>(inv.issuerId) : undefined
  const client = getState().clients.find((c) => c.id === inv.clientId)
  if (!series) out.push('Выберите серию нумерации (Настройки → Фактуры).')
  else if (!seriesOwnedHere(series)) out.push(`Серия «${series.name}» выпускается на другом устройстве.`)
  if (!issuer) out.push('Заполните «Мои реквизиты».')
  else {
    if (!issuer.name.trim()) out.push('В реквизитах нет имени или названия.')
    if (!taxIdKind(issuer.taxId)) out.push('В реквизитах нет корректного NIF/NIE/CIF.')
    if (!issuer.address.trim()) out.push('В реквизитах нет адреса.')
  }
  if (!client) out.push('Выберите клиента.')
  else {
    if (!client.taxId?.trim()) out.push('У клиента нет NIF/NIE/CIF.')
    else if (!taxIdKind(client.taxId)) out.push('NIF/NIE/CIF клиента не проходит проверку.')
    if (!client.address?.trim()) out.push('У клиента нет адреса.')
  }
  const lines = inv.lines.filter((l) => l.description.trim() || l.unitPrice)
  if (!lines.length) out.push('Добавьте хотя бы одну услугу.')
  if (lines.some((l) => !l.description.trim())) out.push('У каждой строки должно быть описание.')
  if (lines.some((l) => !l.quantity)) out.push('Количество не может быть нулевым.')
  if (!inv.vatRate && !inv.vatNote?.trim()) out.push('IVA 0 %: укажите основание (exención или inversión del sujeto pasivo).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.issueDate)) out.push('Укажите дату выставления.')
  return out
}

/**
 * Final issue: takes the next number of the series, freezes issuer and client data and totals,
 * and moves the series counter — all in one transaction. Drafts never consume numbers.
 */
export async function issueInvoice(id: string) {
  await waitForWrites()
  const inv = find<Invoice>(id)
  if (!inv || inv.status !== 'draft') throw new Error('Фактура уже выставлена.')
  const problems = issueProblems(inv)
  if (problems.length) throw new Error(problems[0])
  const series = find<InvoiceSeries>(inv.seriesId)!
  const issuer = find<IssuerProfile>(inv.issuerId!)!
  const client = getState().clients.find((c) => c.id === inv.clientId)!
  const number = Math.max(series.next, seriesUsed(series.id) + 1)
  if (allInvoices().some((o) => o.id !== id && !o.deletedAt && o.seriesId === series.id && o.number === number)) throw new Error('Этот номер уже занят. Обновите приложение и попробуйте ещё раз.')
  const lines = inv.lines.filter((l) => l.description.trim() || l.unitPrice).map((l) => ({ ...l, description: l.description.trim() }))
  const t = now()
  const issued: Invoice = {
    ...inv, status: 'issued', number, code: formatCode(series, number), lines, issuedAt: t, dueDate: null,
    issuer: issuerSnapshot(issuer, inv.iban), client: clientSnapshot(client),
    totals: computeTotals(lines, inv.vatRate, inv.irpfRate), iban: (inv.iban ?? issuer.iban ?? '').trim(),
  }
  actions.putAsEdits([
    { entity: 'invoicing', data: { ...series, next: number + 1 } },
    { entity: 'invoicing', data: issued },
  ])
  await waitForWrites()
  return find<Invoice>(id)!
}

/* ---------------- payment, void, rectifying ---------------- */

/** Income operations of this client that are not yet linked to another invoice. */
export function linkableOperations(inv: Invoice): Operation[] {
  return getState().operations.filter((o) => o.type === 'income' && (!o.invoiceId || o.invoiceId === inv.id) && (!inv.clientId || o.clientId === inv.clientId))
}

/**
 * Marks the invoice paid. The money is recorded once: either an existing income operation is linked,
 * or one new income operation is created. Issuing alone never adds income.
 */
export async function markPaid(id: string, link: { operationId: string } | { create: { date: string; categoryId: string | null } }) {
  await waitForWrites()
  const inv = find<Invoice>(id)
  if (!inv || (inv.status !== 'issued')) throw new Error('Оплаченной можно отметить только выставленную фактуру.')
  if (!inv.totals || inv.totals.total <= 0) throw new Error('Сумма фактуры не положительная (исправленная фактура). Возврат денег добавьте как расход.')
  const t = now()
  if ('operationId' in link) {
    const op = getState().operations.find((o) => o.id === link.operationId)
    if (!op || op.type !== 'income') throw new Error('Операция не найдена.')
    if (op.invoiceId && op.invoiceId !== id) throw new Error('Эта операция уже связана с другой фактурой.')
    actions.putAsEdits([
      { entity: 'operation', data: { ...op, invoiceId: id } },
      { entity: 'invoicing', data: { ...inv, status: 'paid', paidAt: op.date, paymentOperationId: op.id } },
    ])
  } else {
    const op: Operation = {
      id: uid('op'), type: 'income', amount: inv.totals!.total, currency: 'EUR', title: `Фактура ${inv.code}`,
      categoryId: link.create.categoryId, clientId: inv.clientId, date: link.create.date, note: '', incomeKind: 'work', source: 'manual',
      invoiceId: id, createdAt: t, updatedAt: t, deletedAt: null,
    }
    actions.putAsEdits([
      { entity: 'operation', data: op, action: 'create' },
      { entity: 'invoicing', data: { ...inv, status: 'paid', paidAt: op.date, paymentOperationId: op.id } },
    ])
  }
  await waitForWrites()
}

/** Back to «Выставлена». The income operation stays (it is real money); only the link is removed. */
export async function markUnpaid(id: string) {
  await waitForWrites()
  const inv = find<Invoice>(id)
  if (!inv || inv.status !== 'paid') return
  const op = getState().all.operations.find((o) => o.id === inv.paymentOperationId)
  actions.putAsEdits([
    ...(op ? [{ entity: 'operation' as const, data: { ...op, invoiceId: null } }] : []),
    { entity: 'invoicing', data: { ...inv, status: 'issued', paidAt: null, paymentOperationId: null } },
  ])
  await waitForWrites()
}

/** Void keeps the number (it is never reused) and the document; a rectifying invoice can follow. */
export async function voidInvoice(id: string, reason: string) {
  await waitForWrites()
  const inv = find<Invoice>(id)
  if (!inv || inv.status === 'draft' || inv.status === 'void') return
  if (inv.status === 'paid') throw new Error('Сначала снимите отметку об оплате.')
  actions.saveInvoicing({ ...inv, status: 'void', voidedAt: now(), voidReason: reason.trim() || null, updatedAt: now() })
  await waitForWrites()
}

/** Draft of a factura rectificativa in its own series, with the original amounts negated. */
export function rectifyingDraft(id: string): Invoice {
  const orig = find<Invoice>(id)
  if (!orig || orig.status === 'draft') throw new Error('Исправить можно только выставленную фактуру.')
  let series = seriesOf(live()).find((s) => s.rectifying)
  if (!series) series = createSeries('Исправленные', 'R-0001', true)
  const d = newDraft({ clientId: orig.clientId, issuerId: orig.issuerId, seriesId: series.id })
  return {
    ...d, rectifiesId: orig.id, vatRate: orig.vatRate, irpfRate: orig.irpfRate, vatNote: orig.vatNote, iban: orig.iban,
    lines: orig.lines.map((l) => ({ ...l, id: uid('ln'), quantity: -l.quantity })),
    notes: `Factura rectificativa de la factura ${orig.code} de ${orig.issueDate.split('-').reverse().join('/')}.`,
  }
}

export const invoicesForClient = (list: InvoicingRecord[], clientId: string) => invoicesOf(list).filter((i) => i.clientId === clientId)
