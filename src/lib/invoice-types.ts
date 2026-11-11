/**
 * Invoicing records live in one IndexedDB store (`invoicing`) and sync as entity `invoicing`,
 * discriminated by `kind` (same pattern as planning).
 *
 * Money is in cents. Rates are in hundredths of a percent (2100 = 21 %). Quantities are in
 * hundredths (150 = 1,5). An invoice is a document, not money received: it never counts as income.
 * Income is recorded only when the user marks it paid, by linking (or creating) one income operation.
 */

export interface InvoicingBase {
  id: string
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

/** «Мои реквизиты» — one of possibly several issuer profiles. */
export interface IssuerProfile extends InvoicingBase {
  kind: 'issuer'
  label: string
  name: string
  taxId: string
  address: string
  postalCode?: string
  city?: string
  /** provincia, optional */
  province?: string
  country?: string
  email?: string
  phone?: string
  iban?: string
  /** small PNG/JPEG data URL, resized before saving */
  logo?: string | null
  isDefault?: boolean
}

/**
 * Numbering series. `next` is the number the next ISSUED invoice gets. It can be edited freely only
 * while nothing was issued in the series; afterwards numbering continues automatically.
 */
export interface InvoiceSeries extends InvoicingBase {
  kind: 'series'
  name: string
  prefix: string
  digits: number
  next: number
  /** rectifying invoices (facturas rectificativas) must use their own series */
  rectifying?: boolean
  isDefault?: boolean
  /** only this device issues numbers in the series, so two offline devices never hand out the same one */
  issuerDeviceId?: string | null
}

export interface InvoicingSettings extends InvoicingBase {
  kind: 'settings'
  vatRate: number
  irpfRate: number
  applyIrpf: boolean
  dueDays: number
}

export interface InvoiceLine {
  id: string
  description: string
  quantity: number
  unitPrice: number
}

export interface PartySnapshot {
  name: string
  taxId: string
  address: string
  postalCode?: string
  city?: string
  /** provincia, e.g. Barcelona, Navarra */
  province?: string
  country?: string
  email?: string
  phone?: string
}

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void'

export interface InvoiceTotals {
  base: number
  vat: number
  irpf: number
  /** total of the invoice (base + IVA − IRPF) — what the client pays */
  total: number
}

export interface Invoice extends InvoicingBase {
  kind: 'invoice'
  status: InvoiceStatus
  seriesId: string
  /** assigned only when issued; drafts have null and never consume a number */
  number: number | null
  /**
   * Draft only: number typed by hand (e.g. invoices are also issued in another program). It is a request,
   * not a reservation — checked against the series again when issuing.
   */
  requestedNumber?: number | null
  code: string | null
  issueDate: string
  dueDate?: string | null
  issuerId: string | null
  clientId: string | null
  /** frozen copies taken at issue time: an issued invoice never changes when profiles are edited */
  issuer?: PartySnapshot & { iban?: string; logo?: string | null } | null
  client?: PartySnapshot | null
  lines: InvoiceLine[]
  vatRate: number
  irpfRate: number
  /** legal reason when IVA is 0 (exención / inversión del sujeto pasivo) */
  vatNote?: string
  iban?: string
  notes?: string
  currency: 'EUR'
  totals?: InvoiceTotals | null
  issuedAt?: string | null
  paidAt?: string | null
  paymentOperationId?: string | null
  voidedAt?: string | null
  voidReason?: string | null
  rectifiesId?: string | null
}

export type InvoicingRecord = IssuerProfile | InvoiceSeries | InvoicingSettings | Invoice
