import type { Operation } from './types'
import type { PlanningRecord } from './planning-types'
import { isEuro } from './format'

export interface BalancePoint { time: number; value: number }
export interface FreeBalanceSeries { start: number; end: number; points: BalancePoint[] }

/** Replays current records, in local calendar time, without writing or inventing an opening balance. */
export function freeBalanceSeries(operations: Operation[], planning: PlanningRecord[], period: Date, now = new Date()): FreeBalanceSeries {
  const start = +new Date(period.getFullYear(), period.getMonth(), 1)
  const end = Math.min(+new Date(period.getFullYear(), period.getMonth() + 1, 1) - 1, +now)
  if (end < start) return { start, end: start, points: [] }
  type Event = { time: number; order: number; id: string; created?: number; balance?: number; cash?: number; reserve?: [string, number][] }
  const events: Event[] = []
  for (const operation of operations) {
    const time = Date.parse(operation.date)
    if (operation.deletedAt || !isEuro(operation) || time > end) continue
    const payment = operation.type === 'expense' ? operation.planningPayment : undefined
    events.push({ time, order: 0, id: operation.id, cash: operation.type === 'income' ? operation.amount : -operation.amount,
      reserve: payment ? [[payment.envelopeId, -Math.min(operation.amount, payment.reserved)]] : [] })
  }
  for (const record of planning) {
    if (record.deletedAt) continue
    if (record.kind === 'balance' && Date.parse(record.at!) <= end) events.push({ time: Date.parse(record.at!), order: 2, id: record.id, created: Date.parse(record.createdAt), balance: record.amount })
    if (record.kind === 'movement' && record.status === 'confirmed') {
      // The immutable command time preserves offline chronology. A confirmed command
      // with a fast client clock is known now, never plotted in the future.
      const time = Math.min(Date.parse(record.createdAt), +now)
      if (time <= end) events.push({ time, order: 1, id: record.id, reserve: [
        ...(record.from ? [[record.from, -record.amount!] as [string, number]] : []),
        ...(record.to ? [[record.to, record.amount!] as [string, number]] : []),
      ] })
    }
  }
  // Daily carry-forward points keep inactive days flat, including across DST changes.
  for (const day = new Date(start); +day <= end; day.setDate(day.getDate() + 1)) events.push({ time: +day, order: 3, id: '' })
  events.push({ time: end, order: 3, id: '' })
  events.sort((a, b) => a.time - b.time || a.order - b.order || (a.created ?? 0) - (b.created ?? 0) || a.id.localeCompare(b.id))
  let balance: number | null = null, reserved = 0
  const reserves = new Map<string, number>(), points: BalancePoint[] = []
  for (let i = 0; i < events.length;) {
    const time = events[i].time
    // A checkpoint includes all operations at its exact timestamp, just like financials().
    do {
      const event = events[i++]
      if (event.cash && balance !== null) balance += event.cash
      if (event.balance !== undefined) balance = event.balance
      for (const [id, change] of event.reserve ?? []) {
        const before = reserves.get(id) ?? 0, after = before + change
        reserves.set(id, after); reserved += Math.max(0, after) - Math.max(0, before)
      }
    } while (i < events.length && events[i].time === time)
    if (time >= start && balance !== null) points.push({ time, value: balance - reserved })
  }
  return { start, end, points }
}

/** Keep actual extrema and their order in each time bucket; bound SVG work on large histories. */
export function sampleBalancePoints(points: BalancePoint[], limit = 600): BalancePoint[] {
  if (points.length <= limit) return points
  const first = points[0], last = points[points.length - 1], buckets = Math.max(1, Math.floor((limit - 2) / 2))
  const groups = new Map<number, { min: number; max: number }>()
  points.forEach((point, index) => {
    const key = Math.min(buckets - 1, Math.floor((point.time - first.time) / Math.max(1, last.time - first.time) * buckets))
    const group = groups.get(key) ?? { min: index, max: index }
    if (point.value < points[group.min].value) group.min = index
    if (point.value > points[group.max].value) group.max = index
    groups.set(key, group)
  })
  const indices = new Set([0, points.length - 1])
  groups.forEach(({ min, max }) => { indices.add(min); indices.add(max) })
  return [...indices].sort((a, b) => a - b).map((index) => points[index])
}
