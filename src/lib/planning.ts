import { duePeriods, localDay, financials, movementError, validPlanning } from '../../sync-server/lib/planning.mjs'
import { actions, getState, uid, waitForWrites } from './store'
import { getSyncStatus, syncNow } from './sync'
import type { PlanningRecord } from './planning-types'
export { financials, obligations, distribution, localDay, nextPaymentPeriod } from '../../sync-server/lib/planning.mjs'

export function projectedPlanning() {
  return getState().planning.map((r) => r.kind === 'movement' && r.status === 'pending' ? { ...r, status: 'confirmed' as const } : r)
}

function preparePlan(input: Partial<PlanningRecord> & Pick<PlanningRecord, 'kind'>) {
  const now = new Date().toISOString()
  const previous = getState().all.planning.find((r) => r.id === input.id)
  const record: PlanningRecord = { id: uid('plan'), currency: 'EUR', createdAt: now, updatedAt: now, ...previous, ...input }
  record.updatedAt = now
  if (previous?.kind === 'envelope' && previous.mode === 'obligation' && record.mode === 'obligation' &&
    (previous.target !== record.target || previous.frequency !== record.frequency || previous.due !== record.due)) {
    const today = localDay()
    const changedDate = previous.due !== record.due
    const hasPayment = (day: string) => getState().operations.some((o) => o.type === 'expense' && o.planningPayment?.envelopeId === previous.id && o.planningPayment.period === day && Date.parse(o.date) <= Date.now())
    const next = changedDate ? record.due : duePeriods(previous, localDay(new Date(new Date().getFullYear() + 2, 11, 31))).find((day) => day >= today && !hasPayment(day))
    if (!next || next < today) throw new Error('Новые условия должны начинаться сегодня или позже. Исторические периоды сохраняются.')
    if (hasPayment(next)) throw new Error('В этом периоде уже есть оплата. Выберите следующий период для новых условий.')
    const end = new Date(next + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() - 1)
    // Moving a payment date replaces future occurrences, rather than billing both
    // the old upcoming date and the new date. Already paid/current history stays.
    if (changedDate) {
      const boundary = new Date(today + 'T12:00:00Z')
      if (!hasPayment(today)) boundary.setUTCDate(boundary.getUTCDate() - 1)
      if (end > boundary) end.setTime(+boundary)
    }
    const until = end.toISOString().slice(0, 10)
    record.terms = [...previous.terms ?? [], ...(previous.due! <= until ? [{ due: previous.due!, frequency: previous.frequency!, target: previous.target!, scheduleDay: previous.scheduleDay, until }] : [])]
    record.due = next
    record.scheduleDay = changedDate ? Number(next.slice(-2)) : previous.scheduleDay ?? Number(previous.due!.slice(-2))
  }
  if (!validPlanning(record)) throw new Error('Проверьте поля планирования: сумму, дату и обязательные значения.')
  return record
}

export async function savePlan(input: Partial<PlanningRecord> & Pick<PlanningRecord, 'kind'>) {
  const record = preparePlan(input)
  actions.savePlanning(record)
  await waitForWrites()
  return record
}

/** One durable transaction creates/edits the plan and its provisional reserve request. */
export async function savePlanWithReserve(input: Partial<PlanningRecord> & Pick<PlanningRecord, 'kind'>, desired: number) {
  if (!Number.isSafeInteger(desired) || desired < 0) throw new Error('Проверьте сумму резерва')
  const record = preparePlan(input)
  const projection = projectedPlanning()
  const money = financials(getState().operations, projection)
  const current = money.reserves[record.id] ?? 0
  const difference = desired - current
  const items: { entity: 'planning'; data: PlanningRecord }[] = [{ entity: 'planning', data: record }]
  if (difference) {
    const now = new Date().toISOString()
    const event: PlanningRecord = { id: uid('reserve'), kind: 'movement', currency: 'EUR', createdAt: now, updatedAt: now, amount: Math.abs(difference), from: difference < 0 ? record.id : null, to: difference < 0 ? null : record.id, status: 'pending' }
    const error = movementError(getState().operations, [...projection.filter((r) => r.id !== record.id), record], event)
    if (error) throw new Error(error)
    items.push({ entity: 'planning', data: event })
  }
  actions.putAsEdits(items)
  await waitForWrites()
  if (getSyncStatus().paired) void syncNow()
  return record
}

/** User-confirmed deletion archives the plan; confirmed money is released through normal sync. */
export async function closePlan(record: PlanningRecord) {
  if (getSyncStatus().phase === 'syncing') throw new Error('Дождитесь завершения синхронизации и повторите')
  const now = new Date().toISOString()
  const amount = reserveAvailable(record.id)
  const items: { entity: 'planning'; data: PlanningRecord }[] = [{ entity: 'planning', data: { ...record, state: 'closed' } }]
  for (const event of getState().planning.filter((r) => r.kind === 'movement' && r.status !== 'confirmed' && (r.from === record.id || r.to === record.id))) {
    items.push({ entity: 'planning', data: { ...event, status: 'rejected', deletedAt: now, reason: 'План закрыт пользователем' } })
  }
  if (amount) items.push({ entity: 'planning', data: { id: uid('reserve'), kind: 'movement', currency: 'EUR', createdAt: now, updatedAt: now, amount, from: record.id, to: null, status: 'pending' } })
  actions.putAsEdits(items)
  await waitForWrites()
  if (getSyncStatus().paired) void syncNow()
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
