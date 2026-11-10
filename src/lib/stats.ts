import type { Operation, Period } from './types'
import { inPeriod, isEuro } from './format'

export function totals(ops: Operation[]) {
  let income = 0
  let expense = 0
  for (const o of ops.filter(isEuro)) o.type === 'income' ? (income += o.amount) : (expense += o.amount)
  return { income, expense, net: income - expense }
}

export const byPeriod = (ops: Operation[], p: Period, now = new Date()) => ops.filter((o) => inPeriod(o.date, p, now))

/** Last `n` months, oldest first. */
export function monthly(ops: Operation[], n: number, now = new Date()) {
  const out: { y: number; m: number; income: number; expense: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({ y: d.getFullYear(), m: d.getMonth(), income: 0, expense: 0 })
  }
  for (const o of ops) {
    if (!isEuro(o)) continue
    const d = new Date(o.date)
    const b = out.find((x) => x.y === d.getFullYear() && x.m === d.getMonth())
    if (b) b[o.type] += o.amount
  }
  return out
}

/** Cumulative daily net for the current month — powers the hero sparkline. */
export function dailyCumulative(ops: Operation[], now = new Date()) {
  const days = now.getDate()
  const arr = new Array(days).fill(0)
  for (const o of ops) {
    if (!isEuro(o)) continue
    const d = new Date(o.date)
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() <= days)
      arr[d.getDate() - 1] += o.type === 'income' ? o.amount : -o.amount
  }
  let acc = 0
  return arr.map((v) => (acc += v))
}

export function groupSum<K extends string>(ops: Operation[], key: (o: Operation) => K | null) {
  const m = new Map<K, number>()
  for (const o of ops) {
    if (!isEuro(o)) continue
    const k = key(o)
    if (k == null) continue
    m.set(k, (m.get(k) ?? 0) + o.amount)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
