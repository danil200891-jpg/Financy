// «Корректировка фактического баланса». A correction is a balance checkpoint (planning record of
// kind 'balance'): the balance is the latest checkpoint plus every operation dated after it.
// It is not an operation: income, expenses, statistics and existing operations are untouched,
// and new operations move the corrected balance. A checkpoint is an absolute amount, so receiving
// it again through sync or a restore can never apply it twice.
import type { Operation } from './types'
import type { PlanningRecord } from './planning-types'
import { financials, savePlan } from './planning'
import { getState } from './store'

export const currentBalance = (operations: Operation[], planning: PlanningRecord[], now = new Date()) =>
  financials(operations, planning, now).balance as number | null

export interface Adjustment { id: string; at: string; before: number | null; after: number; diff: number | null; reason: string }

/** All corrections, newest first. Older checkpoints without a stored «before» get it recomputed. */
export function adjustments(operations: Operation[], planning: PlanningRecord[]): Adjustment[] {
  const balances = planning.filter((r) => r.kind === 'balance' && !r.deletedAt)
  return balances.map((r) => {
    let before = r.previous
    if (before === undefined) {
      // as the app showed it right before this checkpoint
      const earlier = planning.filter((p) => p.id !== r.id && !(p.kind === 'balance' && (Date.parse(p.at!) > Date.parse(r.at!) || (p.at === r.at && p.createdAt >= r.createdAt))))
      before = currentBalance(operations, earlier, new Date(Date.parse(r.at!)))
    }
    return { id: r.id, at: r.at!, before: before ?? null, after: r.amount!, diff: before == null ? null : r.amount! - before, reason: (r.name ?? '').trim() }
  }).sort((a, b) => b.at.localeCompare(a.at))
}

/** Saves the real balance as of now. Returns the stored checkpoint. */
export async function saveAdjustment(actual: number, reason: string) {
  if (!Number.isSafeInteger(actual)) throw new Error('Проверьте сумму фактического баланса.')
  const { operations, planning } = getState()
  const before = currentBalance(operations, planning)
  return savePlan({ kind: 'balance', amount: actual, at: new Date().toISOString(), name: reason.trim(), previous: before })
}
