// Pure invoicing helpers: numbering, totals, Spanish tax-id and IBAN checks. No I/O here.
import type { Invoice, InvoiceLine, InvoiceSeries, InvoiceTotals } from './invoice-types'

/* ---------------- numbering ---------------- */

/**
 * «F-0026» → prefix «F-», 4 digits, next 26. «2026/0007» → prefix «2026/», 4 digits, next 7.
 * The numeric part is the trailing run of digits; leading zeros define the width.
 */
export function parseNumberExample(example: string): { prefix: string; digits: number; next: number } | null {
  const m = /^(.*?)(\d+)$/.exec(example.trim())
  if (!m) return null
  const next = Number(m[2])
  if (!Number.isSafeInteger(next) || next < 1 || m[2].length > 10) return null
  return { prefix: m[1], digits: m[2].length, next }
}

export const formatCode = (s: Pick<InvoiceSeries, 'prefix' | 'digits'>, n: number) => `${s.prefix}${String(n).padStart(s.digits, '0')}`

/** Highest number already used in a series (issued, paid or void — void numbers are never reused). */
export function lastIssued(invoices: Invoice[], seriesId: string) {
  return invoices.reduce((max, i) => (i.seriesId === seriesId && i.number != null && !i.deletedAt ? Math.max(max, i.number) : max), 0)
}

/* ---------------- money ---------------- */

export const lineAmount = (l: Pick<InvoiceLine, 'quantity' | 'unitPrice'>) => Math.round((l.quantity * l.unitPrice) / 100)

export function computeTotals(lines: Pick<InvoiceLine, 'quantity' | 'unitPrice'>[], vatRate: number, irpfRate: number): InvoiceTotals {
  const base = lines.reduce((s, l) => s + lineAmount(l), 0)
  const vat = Math.round((base * vatRate) / 10000)
  const irpf = Math.round((base * irpfRate) / 10000)
  return { base, vat, irpf, total: base + vat - irpf }
}

/** «21» / «21,5» → 2100 / 2150 (hundredths of a percent). Empty or invalid → null. */
export function parseRate(input: string): number | null {
  const s = input.trim().replace(',', '.').replace('%', '')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null
  const v = Math.round(Number(s) * 100)
  return v <= 10000 ? v : null
}
export const rateLabel = (r: number) => `${(r / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`

/** «1 234,56» / «1234.5» / «-50» → cents. */
export function parseMoney(input: string): number | null {
  let s = input.trim().replace(/[\s €]/g, '')
  if (!s) return null
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  else s = s.replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

/** «1,5» → 150 (hundredths). */
export function parseQuantity(input: string): number | null {
  const s = input.trim().replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  const v = Math.round(Number(s) * 100)
  return v === 0 ? null : v
}
export const quantityLabel = (q: number) => (q / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })
export const moneyInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')

/* ---------------- status ---------------- */

export type DisplayStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void'
export const STATUS_LABEL: Record<DisplayStatus, string> = { draft: 'Черновик', issued: 'Выставлена', paid: 'Оплачена', overdue: 'Просрочена', void: 'Аннулирована' }
export const STATUS_COLOR: Record<DisplayStatus, string> = { draft: 'text-mist', issued: 'text-iris', paid: 'text-income', overdue: 'text-amber', void: 'text-fog' }

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return localDay(d)
}

/** Invoices have no payment due date, so nothing is shown as overdue. */
export function displayStatus(inv: Pick<Invoice, 'status'>): DisplayStatus {
  return inv.status
}

/* ---------------- Spanish tax ids ---------------- */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'
export type TaxIdKind = 'nif' | 'nie' | 'cif' | 'vat'

export const cleanTaxId = (s: string) => s.toUpperCase().replace(/[\s.\-/]/g, '')

/** Checks DNI/NIF, NIE and CIF control characters; EU VAT numbers (two letters + 8–12 chars) are accepted by shape. */
export function taxIdKind(input: string): TaxIdKind | null {
  let s = cleanTaxId(input)
  if (s.startsWith('ES') && s.length === 11) s = s.slice(2)
  if (/^\d{8}[A-Z]$/.test(s)) return DNI_LETTERS[Number(s.slice(0, 8)) % 23] === s[8] ? 'nif' : null
  if (/^[KLM]\d{7}[A-Z]$/.test(s)) return DNI_LETTERS[Number(s.slice(1, 8)) % 23] === s[8] ? 'nif' : null
  if (/^[XYZ]\d{7}[A-Z]$/.test(s)) return DNI_LETTERS[Number('XYZ'.indexOf(s[0]) + s.slice(1, 8)) % 23] === s[8] ? 'nie' : null
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(s)) {
    const digits = s.slice(1, 8)
    let sum = 0
    for (let i = 0; i < 7; i++) {
      const d = Number(digits[i])
      if (i % 2 === 0) { const x = d * 2; sum += Math.floor(x / 10) + (x % 10) } else sum += d
    }
    const c = (10 - (sum % 10)) % 10
    const ctrl = s[8]
    const letter = 'JABCDEFGHI'[c]
    if ('PQRSNW'.includes(s[0]) || s[0] === 'K') return ctrl === letter ? 'cif' : null
    if ('ABEH'.includes(s[0])) return ctrl === String(c) ? 'cif' : null
    return ctrl === String(c) || ctrl === letter ? 'cif' : null
  }
  if (/^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[0-9A-Z]{8,12}$/.test(s)) return 'vat'
  return null
}

export const TAX_ID_LABEL: Record<TaxIdKind, string> = { nif: 'NIF', nie: 'NIE', cif: 'CIF', vat: 'VAT' }

/* ---------------- IBAN ---------------- */

export const cleanIban = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '')

export function validIban(input: string) {
  const s = cleanIban(input)
  if (!/^[A-Z]{2}\d{2}[0-9A-Z]{10,30}$/.test(s)) return false
  if (s.startsWith('ES') && s.length !== 24) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

export const formatIban = (s: string) => cleanIban(s).replace(/(.{4})/g, '$1 ').trim()

export const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim())
