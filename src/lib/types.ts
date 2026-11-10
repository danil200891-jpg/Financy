export type OpType = 'income' | 'expense'
export type OpSource = 'manual' | 'camera' | 'upload' | 'import'

/**
 * Amounts are stored in cents to avoid float errors.
 * Records are never hard-deleted right away: `deletedAt` is a tombstone, which keeps
 * "recently deleted" restorable and makes future cloud sync (last-write-wins by updatedAt) simple.
 */
export interface Operation {
  id: string
  type: OpType
  amount: number
  currency: string
  title: string
  categoryId: string | null
  clientId: string | null
  date: string // ISO date-time
  note?: string
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
  updatedAt?: string
  deletedAt?: string | null
}

export interface Client {
  id: string
  name: string
  aliases: string[]
  color: string
  note?: string
  createdAt: string
  updatedAt?: string
  deletedAt?: string | null
}

export type HistoryAction = 'create' | 'update' | 'delete' | 'restore'
export type EntityKind = 'operation' | 'client' | 'category'

/** Append-only change log. */
export interface HistoryEntry {
  id: string
  entity: EntityKind
  entityId: string
  action: HistoryAction
  at: string
  before?: unknown
  after?: unknown
}

export type Period = 'month' | 'year' | 'all'
