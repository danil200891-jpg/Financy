import type { Operation, Period } from './types'

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })
const moneyShort = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

export const fmt = (cents: number) => money.format(cents / 100)
export const fmtShort = (cents: number) => moneyShort.format(Math.round(cents / 100))

/** Splits "1 234,50 €" into integer and fraction parts for hero display. */
export function splitMoney(cents: number) {
  const abs = Math.abs(cents)
  const int = new Intl.NumberFormat('ru-RU').format(Math.floor(abs / 100))
  const frac = String(abs % 100).padStart(2, '0')
  return { sign: cents < 0 ? '−' : '', int, frac }
}

export const signed = (op: Pick<Operation, 'type' | 'amount'>) =>
  (op.type === 'income' ? '+' : '−') + fmt(op.amount).replace('-', '')

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

export const monthName = (d: Date) => MONTHS[d.getMonth()]
export const monthShort = (m: number) => MONTHS_SHORT[m]
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(now) - start(d)) / 86400000)
  if (diff === 0) return 'Сегодня'
  if (diff === 1) return 'Вчера'
  const base = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function inPeriod(iso: string, period: Period, now = new Date()) {
  if (period === 'all') return true
  const d = new Date(iso)
  if (period === 'year') return d.getFullYear() === now.getFullYear()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

export const periodLabel: Record<Period, string> = { month: 'Месяц', year: 'Год', all: 'Всё время' }

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

export const toDateInput = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
