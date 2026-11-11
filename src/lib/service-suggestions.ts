// Service names used in earlier invoices, for the «Описание услуги» dropdown.
// Built from saved invoices (drafts and issued), so it persists and syncs with them.
// Only names are kept — never prices, which differ per client.
import type { Invoice } from './invoice-types'
import { normalize } from './parse'

/** Starting points shown after the user's own services; the list is not limited to them. */
export const STARTER_SERVICES = ['Видеосъёмка', 'SMM и продвижение социальных сетей']

export interface ServiceName { name: string; count: number; lastUsed: string }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Unique service names (case, «ё» and spaces ignored), most used first, then most recent. */
export function usedServices(invoices: Invoice[]): ServiceName[] {
  const byKey = new Map<string, ServiceName>()
  for (const inv of invoices) {
    if (inv.deletedAt || inv.rectifiesId) continue
    for (const line of inv.lines) {
      const name = clean(line.description)
      const key = normalize(name)
      if (!key || name.length > 300) continue
      const cur = byKey.get(key)
      if (!cur) byKey.set(key, { name, count: 1, lastUsed: inv.updatedAt })
      else {
        cur.count++
        // show the spelling of the most recent use
        if (inv.updatedAt > cur.lastUsed) { cur.lastUsed = inv.updatedAt; cur.name = name }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed) || a.name.localeCompare(b.name, 'ru'))
}

/**
 * Suggestions for the typed text: empty text → everything; otherwise names that start with it first,
 * then names that contain it. A name identical to the text is not offered again.
 */
export function suggestServices(used: ServiceName[], query: string, limit = 8): string[] {
  const all = [...used.map((u) => u.name)]
  for (const s of STARTER_SERVICES) if (!all.some((n) => normalize(n) === normalize(s))) all.push(s)
  const q = normalize(query)
  if (!q) return all.slice(0, limit)
  const starts = all.filter((n) => normalize(n).startsWith(q))
  const contains = all.filter((n) => !normalize(n).startsWith(q) && normalize(n).includes(q))
  return [...starts, ...contains].filter((n) => normalize(n) !== q).slice(0, limit)
}
