// Shape checks for invoicing records (issuer profiles, numbering series, settings, invoices).
// Shared by the sync server and the app's backup reader, so a damaged record is never stored.
const isStr = (v, max = 2000) => typeof v === 'string' && v.length <= max
const optStr = (v, max = 2000) => v === undefined || v === null || isStr(v, max)
const isDate = (v) => isStr(v, 40) && Number.isFinite(Date.parse(v))
const optDate = (v) => v === undefined || v === null || isDate(v)
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))
const optDay = (v) => v === undefined || v === null || isDay(v)
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max
const optBool = (v) => v === undefined || typeof v === 'boolean'
const RATE = 10000
const MONEY = 1e12

function validParty(p) {
  return !!p && typeof p === 'object' && isStr(p.name, 300) && isStr(p.taxId, 40) && isStr(p.address, 600)
    && optStr(p.postalCode, 20) && optStr(p.city, 120) && optStr(p.province, 120) && optStr(p.country, 80) && optStr(p.email, 200) && optStr(p.phone, 60)
}

export function validInvoicing(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !isStr(r.id, 120) || !r.id) return false
  if (!isDate(r.createdAt) || !isDate(r.updatedAt) || !optDate(r.deletedAt)) return false
  if (r.kind === 'issuer') {
    return isStr(r.label, 120) && validParty(r) && optStr(r.iban, 40)
      && (r.logo === undefined || r.logo === null || (isStr(r.logo, 400000) && /^data:image\/(png|jpeg);base64,/.test(r.logo))) && optBool(r.isDefault)
  }
  if (r.kind === 'series') {
    return isStr(r.name, 80) && isStr(r.prefix, 20) && int(r.digits, 1, 10) && int(r.next, 1, 1e9)
      && optBool(r.rectifying) && optBool(r.isDefault) && optStr(r.issuerDeviceId, 120)
  }
  if (r.kind === 'settings') {
    return int(r.vatRate, 0, RATE) && int(r.irpfRate, 0, RATE) && typeof r.applyIrpf === 'boolean' && int(r.dueDays, 0, 365)
  }
  if (r.kind === 'invoice') {
    if (!['draft', 'issued', 'paid', 'void'].includes(r.status) || !isStr(r.seriesId, 120) || !isDay(r.issueDate) || !optDay(r.dueDate)) return false
    if (r.currency !== 'EUR' || !int(r.vatRate, 0, RATE) || !int(r.irpfRate, 0, RATE)) return false
    if (!optStr(r.issuerId, 120) || !optStr(r.clientId, 120) || !optStr(r.vatNote, 600) || !optStr(r.iban, 40) || !optStr(r.notes, 4000)) return false
    if (!optDate(r.issuedAt) || !optDate(r.paidAt) || !optDate(r.voidedAt) || !optStr(r.voidReason, 600) || !optStr(r.paymentOperationId, 120) || !optStr(r.rectifiesId, 120)) return false
    if (!Array.isArray(r.lines) || r.lines.length > 200) return false
    if (!r.lines.every((l) => l && isStr(l.id, 120) && isStr(l.description, 1000) && int(l.quantity, -1e9, 1e9) && int(l.unitPrice, -MONEY, MONEY))) return false
    const issuedLike = r.status !== 'draft'
    // a number exists exactly when the invoice was issued; drafts never hold one
    if (issuedLike !== (r.number !== null && r.number !== undefined)) return false
    if (issuedLike && (!int(r.number, 1, 1e9) || !isStr(r.code, 40) || !r.code || !isDate(r.issuedAt) || !validParty(r.issuer) || !validParty(r.client) || !r.totals)) return false
    if (!issuedLike && r.code !== null && r.code !== undefined) return false
    if (r.requestedNumber !== undefined && r.requestedNumber !== null && (issuedLike || !int(r.requestedNumber, 1, 1e9))) return false
    if (r.issuer != null && (!validParty(r.issuer) || !optStr(r.issuer.iban, 40))) return false
    if (r.client != null && !validParty(r.client)) return false
    if (r.totals != null && !['base', 'vat', 'irpf', 'total'].every((k) => int(r.totals[k], -MONEY, MONEY))) return false
    return true
  }
  return false
}

/** Two different live invoices must never share a series + number. */
export function numberClash(records, invoice) {
  if (!invoice || invoice.kind !== 'invoice' || invoice.number == null || invoice.deletedAt) return null
  return records.find((r) => r && r.kind === 'invoice' && r.id !== invoice.id && !r.deletedAt && r.seriesId === invoice.seriesId && r.number === invoice.number) ?? null
}
