// Shared, deterministic financial rules. No I/O or browser/server state.
const live = (record) => !record.deletedAt
const euro = (operation) => !operation.currency || operation.currency.toUpperCase() === 'EUR'
const cents = (n) => Number.isSafeInteger(n)
const date = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s))
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function validPlanning(r) {
  if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 120 || r.currency !== 'EUR' || !date(r.createdAt) || !date(r.updatedAt) || (r.deletedAt != null && !date(r.deletedAt))) return false
  if (r.kind === 'balance') return cents(r.amount) && date(r.at)
  if (r.kind === 'settings') return typeof r.auto === 'boolean' && (r.order === undefined || ['obligations-first', 'priority'].includes(r.order))
  if (r.kind === 'movement') return cents(r.amount) && r.amount > 0 && ['pending', 'confirmed', 'rejected'].includes(r.status) &&
    (r.from === null || (typeof r.from === 'string' && r.from.length > 0 && r.from.length <= 120)) && (r.to === null || (typeof r.to === 'string' && r.to.length > 0 && r.to.length <= 120)) && r.from !== r.to
  if (r.kind === 'envelope') return typeof r.name === 'string' && !!r.name.trim() && r.name.length <= 200 && cents(r.target) && r.target > 0 &&
    ['goal', 'obligation'].includes(r.mode) && ['active', 'paused', 'closed'].includes(r.state) && Number.isInteger(r.priority) && r.priority >= 0 && r.priority <= 999 &&
    ['once', 'monthly', 'quarterly', 'yearly'].includes(r.frequency) && (r.mode !== 'obligation' || !!r.due) &&
    (!r.due || (/^\d{4}-\d{2}-\d{2}$/.test(r.due) && date(r.due) && new Date(r.due).toISOString().slice(0, 10) === r.due))
  return false
}

export function financials(operations, planning, now = new Date()) {
  const records = planning.filter(live)
  const anchors = records.filter((r) => r.kind === 'balance' && Date.parse(r.at) <= +now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
  const anchor = anchors.at(-1)
  const actualOps = operations.filter((o) => live(o) && euro(o) && Date.parse(o.date) <= +now)
  const balance = anchor ? actualOps.filter((o) => Date.parse(o.date) > Date.parse(anchor.at)).reduce((sum, o) => sum + (o.type === 'income' ? o.amount : -o.amount), anchor.amount) : null
  const reserves = Object.fromEntries(records.filter((r) => r.kind === 'envelope').map((r) => [r.id, 0]))
  for (const r of records.filter((r) => r.kind === 'movement' && r.status === 'confirmed')) {
    if (r.from) reserves[r.from] = (reserves[r.from] ?? 0) - r.amount
    if (r.to) reserves[r.to] = (reserves[r.to] ?? 0) + r.amount
  }
  for (const operation of actualOps) {
    if (operation.type !== 'expense' || !operation.planningPayment) continue
    const payment = operation.planningPayment
    reserves[payment.envelopeId] = (reserves[payment.envelopeId] ?? 0) - Math.min(operation.amount, payment.reserved)
  }
  // An offline expense is always real, even when another device already spent the reserve.
  // The uncovered part is paid from free cash; never manufacture a negative envelope.
  for (const id of Object.keys(reserves)) reserves[id] = Math.max(0, reserves[id])
  const reserved = Object.values(reserves).reduce((sum, n) => sum + n, 0)
  const invalid = (balance !== null && !cents(balance)) || !cents(reserved) || Object.values(reserves).some((n) => !cents(n))
  return { balance, reserved, free: balance === null ? null : balance - reserved, reserves, invalid, anchor,
    pending: records.filter((r) => r.kind === 'movement' && r.status === 'pending') }
}

/** Recurrence retains the original day (31st / leap day), clamping only individual occurrences. */
export function duePeriods(envelope, through) {
  if (!envelope.due || envelope.mode !== 'obligation') return []
  const [year, month, day] = envelope.due.split('-').map(Number)
  const step = { once: 0, monthly: 1, quarterly: 3, yearly: 12 }[envelope.frequency]
  const out = []
  for (let i = 0; i < 1200; i++) {
    const d = new Date(Date.UTC(year, month - 1 + i * step, 1, 12))
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
    const key = d.toISOString().slice(0, 10)
    if (key > through) break
    out.push(key)
    if (!step) break
  }
  return out
}

export function obligations(operations, planning, now = new Date()) {
  const end = localDay(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  return planning.filter((r) => live(r) && r.kind === 'envelope' && r.mode === 'obligation' && r.state === 'active').flatMap((envelope) =>
    duePeriods(envelope, end).map((period) => {
      const paid = operations.filter((o) => live(o) && euro(o) && o.type === 'expense' && Date.parse(o.date) <= +now && o.planningPayment?.envelopeId === envelope.id && o.planningPayment.period === period).reduce((sum, o) => sum + o.amount, 0)
      return { envelope, period, paid, missing: Math.max(0, envelope.target - paid) }
    }).filter((p) => p.missing > 0))
}

export function nextPaymentPeriod(envelope, operations, now = new Date()) {
  const through = localDay(new Date(now.getFullYear() + 2, 11, 31))
  const periods = duePeriods(envelope, through)
  return periods.find((period) => operations.filter((o) => live(o) && euro(o) && o.type === 'expense' && Date.parse(o.date) <= +now && o.planningPayment?.envelopeId === envelope.id && o.planningPayment.period === period).reduce((sum, o) => sum + o.amount, 0) < envelope.target)
    ?? (envelope.due > through ? envelope.due : undefined)
}

export function distribution(operations, planning, now = new Date()) {
  const money = financials(operations, planning, now)
  if (money.free === null || money.invalid) return []
  let free = Math.max(0, money.free)
  const needs = obligations(operations, planning, now)
  const priorityOnly = planning.some((r) => live(r) && r.kind === 'settings' && r.order === 'priority')
  const envelopes = planning.filter((r) => live(r) && r.kind === 'envelope' && r.state === 'active').sort((a, b) =>
    (priorityOnly ? 0 : (a.mode === 'obligation' ? 0 : a.cushion ? 1 : 2) - (b.mode === 'obligation' ? 0 : b.cushion ? 1 : 2)) || a.priority - b.priority || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.id.localeCompare(b.id))
  const out = []
  for (const envelope of envelopes) {
    const target = envelope.mode === 'obligation' ? needs.filter((p) => p.envelope.id === envelope.id).reduce((sum, p) => sum + p.missing, 0) || (envelope.frequency === 'once' ? 0 : envelope.target) : envelope.target
    const amount = Math.min(free, Math.max(0, target - (money.reserves[envelope.id] ?? 0)))
    if (amount) { out.push({ envelopeId: envelope.id, name: envelope.name, amount }); free -= amount }
  }
  return out
}

export function movementError(operations, planning, event, now = new Date()) {
  if (!validPlanning(event) || event.kind !== 'movement') return 'Некорректное движение'
  const money = financials(operations, planning, now)
  if (money.balance === null) return 'Сначала задайте фактический баланс'
  if (money.invalid) return 'Резервы требуют проверки'
  const envelope = (id) => planning.find((r) => r.id === id && r.kind === 'envelope' && live(r))
  if ((event.from && !envelope(event.from)) || (event.to && envelope(event.to)?.state !== 'active')) return 'Конверт недоступен'
  if (event.from && (money.reserves[event.from] ?? 0) < event.amount) return 'Недостаточно денег в конверте'
  const after = financials(operations, [...planning, { ...event, status: 'confirmed' }], now)
  // During recovery the linked expense may already be present: only its unspent reserve
  // needs cash today. The original payment must never be charged twice.
  if (!event.from && money.free < after.reserved - money.reserved) return 'Недостаточно свободных денег'
  return null
}
