import { financials, movementError, validPlanning } from '../../sync-server/lib/planning.mjs'
import { actions, getState, uid, waitForWrites } from './store'
import { getSyncStatus, syncNow } from './sync'
import type { PlanningRecord } from './planning-types'
export { financials, obligations, distribution, localDay, nextPaymentPeriod } from '../../sync-server/lib/planning.mjs'

export function projectedPlanning() {
  return getState().planning.map((r) => r.kind === 'movement' && r.status === 'pending' ? { ...r, status: 'confirmed' as const } : r)
}

export async function savePlan(input: Partial<PlanningRecord> & Pick<PlanningRecord, 'kind'>) {
  const now = new Date().toISOString()
  const previous = getState().all.planning.find((r) => r.id === input.id)
  const record: PlanningRecord = { id: uid('plan'), currency: 'EUR', createdAt: now, updatedAt: now, ...previous, ...input }
  record.updatedAt = now
  if (!validPlanning(record)) throw new Error('Проверьте поля планирования: сумму, дату и обязательные значения.')
  actions.savePlanning(record)
  await waitForWrites()
  return record
}

/** A reserve remains provisional until the serial server command acknowledges it. */
export async function reserve(amount: number, from: string | null, to: string | null) {
  const now = new Date().toISOString()
  const event: PlanningRecord = { id: uid('reserve'), kind: 'movement', currency: 'EUR', createdAt: now, updatedAt: now, amount, from, to, status: 'pending' }
  const error = movementError(getState().operations, projectedPlanning(), event)
  if (error) throw new Error(error)
  actions.savePlanning(event)
  await waitForWrites()
  if (getSyncStatus().paired) void syncNow()
}

export function reserveAvailable(envelopeId: string) {
  const { operations, planning } = getState()
  return financials(operations, planning).reserves[envelopeId] ?? 0
}
