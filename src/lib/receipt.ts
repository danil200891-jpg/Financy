import type { Client, OpType } from './types'
import { matchClient, normalize } from './parse'

export type Kind = 'receipt' | 'screenshot'
export type FieldFlag = 'type' | 'amount' | 'title' | 'date'

export interface Recognized {
  type: OpType
  amount: number | null // cents
  title: string
  clientId: string | null
  date: string | null // yyyy-mm-dd
  flags: Partial<Record<FieldFlag, string>>
}

const KNOWN_MERCHANTS = [
  'Mercadona', 'Lidl', 'Carrefour', 'Dia', 'Aldi', 'Alcampo', 'Eroski', 'Consum', 'Hipercor', 'El Corte Inglés', 'BonÀrea', 'Ahorramas',
  'Zara', 'Primark', 'Decathlon', 'IKEA', 'Leroy Merlin', 'MediaMarkt', 'Media Markt', 'Amazon', 'AliExpress', 'Repsol', 'Cepsa', 'Galp',
  'Shell', 'Starbucks', "McDonald's", 'Burger King', 'KFC', 'Telepizza', 'Glovo', 'Uber', 'Cabify', 'Bolt', 'Renfe', 'Apple', 'Spotify',
  'Netflix', 'Vodafone', 'Movistar', 'Orange', 'Digi', 'Farmacia', 'Pharmacy', 'Аптека', 'Пятёрочка', 'Перекрёсток', 'Магнит', 'Ozon', 'Wildberries',
]

// receipts: these mean "the amount to pay"
const TOTAL_KEYS = ['total a pagar', 'importe total', 'total compra', 'total eur', 'total €', 'total', 'a pagar', 'importe', 'итого к оплате', 'к оплате', 'итого', 'итог', 'всего', 'amount due', 'grand total', 'suma']
// lines that contain "total"-like words but are not the final amount
const NOT_TOTAL = ['subtotal', 'sub total', 'base imp', 'iva', 'i.v.a', 'cambio', 'entregado', 'efectivo', 'descuento', 'ahorro', 'cuota', 'ндс', 'сдача', 'скидка', 'наличные', 'tax', 'vat', 'change']

const INCOME_KEYS = ['has recibido', 'recibido', 'te ha enviado', 'ingreso', 'abono', 'transferencia recibida', 'bizum recibido', 'received', 'you received', 'получено', 'поступление', 'зачисление', 'пополнение', 'входящий перевод', 'вам перевели']
const EXPENSE_KEYS = ['has enviado', 'enviado', 'bizum enviado', 'pago', 'compra', 'cargo', 'paid', 'you sent', 'sent', 'payment', 'списание', 'оплата', 'покупка', 'исходящий перевод', 'вы перевели']
const PARTY_KEYS = ['beneficiario', 'ordenante', 'destinatario', 'para', 'de', 'desde', 'comercio', 'to', 'from', 'merchant', 'получатель', 'отправитель', 'от', 'кому', 'магазин']

const JUNK = /(c\.?i\.?f|n\.?i\.?f|tel[éeф.:]|телефон|www\.|http|@|c\/|calle|avda|avenida|plaza|factura|ticket|fecha|hora|caja|cajero|operaci|terminal|ИНН|кассир|чек №|^\W*$|\d{5})/i

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, янв: 1, feb: 2, фев: 2, mar: 3, мар: 3, abr: 4, apr: 4, апр: 4, may: 5, мая: 5, май: 5, jun: 6, июн: 6,
  jul: 7, июл: 7, ago: 8, aug: 8, авг: 8, sep: 9, set: 9, сен: 9, oct: 10, окт: 10, nov: 11, ноя: 11, dic: 12, dec: 12, дек: 12,
}

// "1.234,56" / "1 234,56" / "1,234.56" / "42,15" / "42.15" with optional sign and currency
const MONEY = /([+\-−–]\s?)?(?:€\s?)?(\d{1,3}(?:[.\s ]\d{3})+|\d+)[,.](\d{2})(?!\d)(?:\s?(?:€|eur|euros?|₽|руб))?/gi
const MONEY_INT = /([+\-−–]\s?)?(?:€\s?(\d+)|(\d+)\s?(?:€|eur\b|euros?\b))/gi

interface Money { cents: number; sign: '+' | '-' | ''; line: number; hasCurrency: boolean }

function moneyIn(line: string, idx: number): Money[] {
  const out: Money[] = []
  for (const m of line.matchAll(MONEY)) {
    const int = parseInt(m[2].replace(/[.\s ]/g, ''), 10)
    const sign = m[1] ? (m[1].trim() === '+' ? '+' : '-') : ''
    out.push({ cents: int * 100 + parseInt(m[3], 10), sign, line: idx, hasCurrency: /€|eur|₽|руб/i.test(m[0]) })
  }
  if (!out.length)
    for (const m of line.matchAll(MONEY_INT)) {
      const v = parseInt(m[2] ?? m[3], 10)
      out.push({ cents: v * 100, sign: m[1] ? (m[1].trim() === '+' ? '+' : '-') : '', line: idx, hasCurrency: true })
    }
  return out.filter((x) => x.cents > 0 && x.cents < 10_000_000_00)
}

/** An uploaded image may be a receipt photo or an app screenshot. */
export function guessKind(text: string): Kind {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const priced = lines.filter((l) => moneyIn(l, 0).length).length
  return /(^|[^a-zа-яё])(total|importe|итого|к оплате|ticket|factura|кассовый)(?=$|[^a-zа-яё])/i.test(text) && priced >= 2 ? 'receipt' : 'screenshot'
}

const pad = (n: number) => String(n).padStart(2, '0')

function validDate(y: number, m: number, d: number, now: Date) {
  if (y < 100) y += 2000
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, m - 1, d)
  if (dt.getMonth() !== m - 1) return null
  const ageDays = (now.getTime() - dt.getTime()) / 86400000
  if (ageDays < -1 || ageDays > 365 * 5) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

export function findDate(text: string, now = new Date()): string | null {
  const t = text.toLowerCase()
  for (const m of t.matchAll(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g)) {
    const r = validDate(+m[1], +m[2], +m[3], now)
    if (r) return r
  }
  // no regex lookbehind: older iOS Safari can't parse it and the whole app would fail to start
  for (const m of t.matchAll(/(?:^|\D)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/g)) {
    const r = validDate(+m[3], +m[2], +m[1], now)
    if (r) return r
  }
  for (const m of t.matchAll(/(?:^|\D)(\d{1,2})\s*(?:de\s+)?([a-zа-яё]{3,})\.?\s*(?:de\s+)?(\d{4})?/g)) {
    const mon = MONTHS[m[2].slice(0, 3)]
    if (!mon) continue
    const r = validDate(m[3] ? +m[3] : now.getFullYear(), mon, +m[1], now)
    if (r) return r
  }
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  if (/\b(hoy|today)\b|сегодня/.test(t)) return today
  if (/\b(ayer|yesterday)\b|вчера/.test(t)) {
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    return `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`
  }
  return null
}

const has = (line: string, keys: string[]) => {
  const l = ` ${normalize(line)} `
  return keys.some((k) => l.includes(` ${normalize(k)}`) || l.includes(`${normalize(k)} `) || l.includes(`${normalize(k)}:`))
}

function cleanTitle(s: string) {
  return s
    .replace(/\b(s\.?\s?a\.?|s\.?\s?l\.?\s?u?\.?|ооо|ип|ltd|inc)\b\.?/gi, '')
    .replace(/[|*_=~<>#]+/g, ' ')
    .replace(/^[\s:.,\-–]+|[\s:.,\-–]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const titleCase = (s: string) => (s === s.toUpperCase() && s.length > 3 ? s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : s)

/**
 * Turns raw OCR text into an operation draft. Never invents values:
 * anything not found stays empty and gets a flag asking the user to check.
 */
export function parseRecognized(text: string, kind: Kind, clients: Client[], knownTitles: string[], now = new Date()): Recognized {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const flags: Recognized['flags'] = {}
  const all = lines.flatMap((l, i) => moneyIn(l, i))

  /* amount */
  let amount: Money | null = null
  if (kind === 'receipt') {
    for (let i = lines.length - 1; i >= 0 && !amount; i--) {
      const startsTotal = /^\W*(total|importe total|a pagar|итого|итог|к оплате|всего)/i.test(lines[i])
      if (!has(lines[i], TOTAL_KEYS) || (has(lines[i], NOT_TOTAL) && !startsTotal)) continue
      const here = all.filter((m) => m.line === i)
      const next = all.filter((m) => m.line === i + 1)
      const pick = (here.length ? here : next).sort((a, b) => b.cents - a.cents)[0]
      if (pick) amount = pick
    }
    if (!amount && all.length) {
      amount = [...all].sort((a, b) => b.cents - a.cents)[0]
      flags.amount = 'Строку «Итого» не нашли — взята самая крупная сумма'
    }
  } else {
    // screenshots: prefer an amount with a currency sign, the biggest font usually comes first
    amount = all.find((m) => m.hasCurrency && m.sign) ?? all.find((m) => m.hasCurrency) ?? all[0] ?? null
    if (amount && all.filter((m) => m.hasCurrency).length > 1) flags.amount = 'На изображении несколько сумм — проверьте'
  }
  if (!amount) flags.amount = 'Сумму не нашли — введите её'

  /* type */
  let type: OpType = 'expense'
  if (kind === 'screenshot') {
    const full = lines.join(' ')
    const inc = has(full, INCOME_KEYS)
    const exp = has(full, EXPENSE_KEYS)
    if (amount?.sign === '+' || (inc && !exp)) type = 'income'
    else if (amount?.sign === '-' || (exp && !inc)) type = 'expense'
    else flags.type = 'Не удалось понять, доход это или расход'
  }

  /* title: client → known merchant → previous titles → labelled party line → first meaningful line */
  let clientId: string | null = null
  let title = ''
  for (const l of lines) {
    const c = matchClient(cleanTitle(l), clients) ?? clients.find((c) => normalize(l).includes(normalize(c.name)) && c.name.length >= 3)
    if (c) { clientId = c.id; title = c.name; break }
  }
  const lowerAll = normalize(text)
  if (!title) title = KNOWN_MERCHANTS.find((m) => lowerAll.includes(normalize(m))) ?? ''
  if (!title) title = knownTitles.find((t) => t.length >= 4 && lowerAll.includes(normalize(t))) ?? ''
  if (!title && kind === 'screenshot') {
    for (let i = 0; i < lines.length && !title; i++) {
      const m = lines[i].match(new RegExp(`^(?:${PARTY_KEYS.join('|')})\\s*:?\\s*(.*)$`, 'i'))
      if (!m) continue
      const cand = cleanTitle(m[1] || lines[i + 1] || '')
      if (/[a-zа-яё]{3,}/i.test(cand) && !moneyIn(cand, 0).length) title = cand
    }
  }
  // without any amount the image is probably not a payment — don't pick a random line as a title
  if (!title && amount) {
    const cand = lines.slice(0, 6).map(cleanTitle).find((l) => /[a-zа-яё]{3,}/i.test(l) && !JUNK.test(l) && !moneyIn(l, 0).length && l.length <= 40)
    if (cand) {
      title = titleCase(cand)
      flags.title = 'Название определено неточно — проверьте'
    } else flags.title = kind === 'receipt' ? 'Магазин не найден — введите название' : 'Получатель не найден — введите название'
  }
  if (!title && !flags.title) flags.title = 'Название не найдено — введите его'
  if (clientId && kind === 'screenshot' && !flags.type && type === 'expense' && !amount?.sign) {
    // payments from a saved client are almost always income — but ask instead of assuming
    flags.type = 'Это клиент — возможно, это доход. Проверьте'
  }

  /* date */
  const date = findDate(text, now)
  if (!date) flags.date = 'Дату не нашли — стоит сегодняшняя'

  return { type, amount: amount?.cents ?? null, title, clientId, date, flags }
}
