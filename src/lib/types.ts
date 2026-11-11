export type OpType = 'income' | 'expense'
export type OpSource = 'manual' | 'camera' | 'upload' | 'import'
/** Top-level income switch in the income form. Optional: older operations have none. */
export type IncomeKind = 'work' | 'shoot' | 'oneoff'

/**
 * Amounts are stored in cents to avoid float errors.
 * Records are never hard-deleted right away: `deletedAt` is a tombstone, which keeps
 * "recently deleted" restorable and makes future cloud sync (last-write-wins by updatedAt) simple.
 */
export interface Operation {
  planningPayment?: import('./planning-types').PlanningPayment
  id: string
  type: OpType
  amount: number
  currency: string
  title: string
  categoryId: string | null
  clientId: string | null
  date: string // ISO date-time
  note?: string
  incomeKind?: IncomeKind
  /** set when this income is the payment of an invoice (one operation pays at most one invoice) */
  invoiceId?: string | null
  source: OpSource
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export interface Category {
  id: string
  name: string
  type: OpType
  icon: string // key from icon map
  color: string
  /** Hidden from pickers but still shown on older operations that use it. */
  archived?: boolean
  updatedAt?: string
  deletedAt?: string | null
}

export interface Client {
  id: string
  name: string
  aliases: string[]
  color: string
  note?: string
  /** optional tax details, needed only for invoices; regular clients work without them */
  legalName?: string
  taxId?: string
  address?: string
  postalCode?: string
  city?: string
  /** provincia (Barcelona, Navarra, …), optional */
  province?: string
  country?: string
  email?: string
  phone?: string
  createdAt: string
  updatedAt?: string
  deletedAt?: string | null
}

export type HistoryAction = 'create' | 'update' | 'delete' | 'restore'
export type EntityKind = 'operation' | 'client' | 'category' | 'planning' | 'invoicing'
export type FinancialRecord = Operation | Client | Category | import('./planning-types').PlanningRecord | import('./invoice-types').InvoicingRecord

/** Append-only change log. */
export interface HistoryEntry {
  id: string
  entity: EntityKind
  entityId: string
  action: HistoryAction
  at: string
  before?: unknown
  after?: unknown
  /** set when the change came from another device through the PC sync server */
  via?: 'sync'
}

export type Period = 'month' | 'year' | 'all'
