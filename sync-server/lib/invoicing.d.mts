import type { Invoice, InvoicingRecord } from '../../src/lib/invoice-types'
export function validInvoicing(record: unknown): record is InvoicingRecord
export function numberClash(records: unknown[], invoice: Invoice): Invoice | null
