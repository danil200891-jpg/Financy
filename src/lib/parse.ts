import type { Client, OpType } from './types'

export interface ParsedText {
  type: OpType | null
  amount: number | null // cents
  title: string
  clientId: string | null
  /** true when the type had to be guessed — UI asks the user to confirm */
  typeGuessed: boolean
}

const INCOME_WORDS = ['доход', 'приход', 'получил', 'получила', 'оплата от', 'income', 'зарплата']
const EXPENSE_WORDS = ['расход', 'трата', 'потратил', 'потратила', 'купил', 'купила', 'expense', 'оплата']
const CURRENCY = /(€|eur|евро|euro)/gi

// number: optional sign, digits with optional space/nbsp thousand separators, optional ,/. decimals
const AMOUNT_RE = /([+\-−–]?)\s*(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d)/g

export function normalize(s: string) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

export function matchClient(text: string, clients: Client[]): Client | null {
  const t = normalize(text)
  if (!t) return null
  let best: Client | null = null
  let bestLen = 0
  for (const c of clients) {
    for (const name of [c.name, ...c.aliases]) {
      const n = normalize(name)
      if (!n) continue
      const hit = t === n || t.startsWith(n + ' ') || t.endsWith(' ' + n) || t.includes(' ' + n + ' ')
      if (hit && n.length > bestLen) {
        best = c
        bestLen = n.length
      }
    }
  }
  return best
}

export function parseText(input: string, clients: Client[]): ParsedText {
  let text = ` ${input} `
  let type: OpType | null = null

  const lower = normalize(input)
  for (const w of INCOME_WORDS) if (lower.includes(w)) type = 'income'
  if (!type) for (const w of EXPENSE_WORDS) if (lower.includes(w)) type = 'expense'

  // take the last number in the string as the amount (titles may contain digits, e.g. "iPhone 15 1200")
  const matches = [...text.matchAll(AMOUNT_RE)]
  let amount: number | null = null
  if (matches.length) {
    const m = matches[matches.length - 1]
    const intPart = m[2].replace(/[   ]/g, '')
    const frac = (m[3] ?? '').padEnd(2, '0')
    amount = parseInt(intPart, 10) * 100 + (frac ? parseInt(frac, 10) : 0)
    if (m[1] === '+') type = 'income'
    else if (m[1] && '-−–'.includes(m[1])) type = 'expense'
    text = text.slice(0, m.index) + ' ' + text.slice((m.index ?? 0) + m[0].length)
  }

  let title = text.replace(CURRENCY, ' ')
  for (const w of [...INCOME_WORDS, ...EXPENSE_WORDS]) title = title.replace(new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'gi'), ' ')
  title = title.replace(/[+\-−–]\s*$/g, '').replace(/\s+/g, ' ').trim()

  const client = matchClient(title, clients)
  let typeGuessed = false
  if (!type) {
    type = client ? 'income' : 'expense'
    typeGuessed = true
  }
  if (client && !title) title = client.name

  return { type, amount, title, clientId: client?.id ?? null, typeGuessed }
}
