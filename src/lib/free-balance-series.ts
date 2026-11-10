import type { Operation } from './types'
import type { PlanningRecord } from './planning-types'
import { isEuro } from './format'

export interface BalancePoint { time: number; value: number }
export interface FreeBalanceSeries { start: number; end: number; points: BalancePoint[] }

/** Replays current records, in local calendar time, without writing; reconstructs opening cash from a known checkpoint and recorded flows. */
export function freeBalanceSeries(operations: Operation[], planning: PlanningRecord[], period: Date, now = new Date()): FreeBalanceSeries {
  const start = +new Date(period.getFullYear(), period.getMonth(), 1)
  const end = Math.min(+new Date(period.getFullYear(), period.getMonth() + 1, 1) - 1, +now)
  if (end < start) return { start, end: start, points: [] }
  type Event = { time: number; order: number; id: string; created?: number; balance?: number; cash?: number; reserve?: [string, number][] }
  const events: Event[] = []
  for (const operation of operations) {
    const time = Date.parse(operation.date)
    if (operation.deletedAt || !isEuro(operation) || !Number.isFinite(time) || time > end) continue
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
  const firstAnchor = planning.filter((r) => !r.deletedAt && r.kind === 'balance' && Date.parse(r.at!) <= +now)
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))[0]
  if (firstAnchor && Date.parse(firstAnchor.at!) > start) {
    // Rewind recorded cash flows from the first observed checkpoint. This is a
    // derived chart sample only, never a new balance record or financial operation.
    const anchorTime = Date.parse(firstAnchor.at!)
    const cashSinceStart = operations.filter((o) => !o.deletedAt && isEuro(o) && Date.parse(o.date) >= start && Date.parse(o.date) <= anchorTime)
      .reduce((sum, o) => sum + (o.type === 'income' ? o.amount : -o.amount), 0)
    events.push({ time: start, order: -1, id: '', balance: firstAnchor.amount! - cashSinceStart })
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

/** The compact sparkline has an event-order axis, not a labelled linear-time axis.
 * Preserve flat runs' ends, then give close events readable horizontal separation.
 * Timestamps/amounts remain untouched; no extra financial fluctuations are created.
 */
export function balanceChartPoints(series: FreeBalanceSeries, width = 300, height = 64): [number, number][] {
  const reduced = series.points.filter((p, i, all) => i === 0 || i === all.length - 1 || p.value !== all[i - 1].value || p.value !== all[i + 1].value)
  const samples = sampleBalancePoints(reduced)
  if (!samples.length) return []
  const values = samples.map((p) => p.value), low = Math.min(...values), high = Math.max(...values)
  if (samples.length === 1) return [[0, height / 2], [width, height / 2]]
  // Leave room for both the glow and spline inside the SVG viewport.
  return samples.map((point, i) => [i / (samples.length - 1) * width,
    high === low ? height / 2 : height * .82 - (point.value - low) / (high - low) * height * .64])
}
