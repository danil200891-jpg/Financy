export interface PlanningRecord {
  id: string
  kind: 'balance' | 'envelope' | 'movement' | 'settings'
  currency: 'EUR'
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  name?: string
  amount?: number
  at?: string
  target?: number
  mode?: 'goal' | 'obligation'
  frequency?: 'once' | 'monthly' | 'quarterly' | 'yearly'
  due?: string
  priority?: number
  categoryId?: string | null
  state?: 'active' | 'paused' | 'closed'
  icon?: string
  cushion?: boolean
  from?: string | null
  to?: string | null
  status?: 'pending' | 'confirmed' | 'rejected'
  reason?: string
  auto?: boolean
  order?: 'obligations-first' | 'priority'
}

export interface PlanningPayment { envelopeId: string; reserved: number; period?: string }
