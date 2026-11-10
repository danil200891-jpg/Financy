import type { Operation } from './types'

export const sourceKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU')

/** Suggest only sources supported by at least two distinct, live saved incomes. */
export function incomeSources(operations: Operation[], query = '') {
  const sources = new Map<string, { name: string; count: number; latest: number }>()
  const seen = new Set<string>()
  for (const operation of operations) {
    if (operation.type !== 'income' || operation.deletedAt || seen.has(operation.id)) continue
    seen.add(operation.id)
    const name = operation.title.trim().replace(/\s+/g, ' ')
    const key = sourceKey(name)
    if (!key) continue
    const latest = Date.parse(operation.updatedAt || operation.date) || 0
    const previous = sources.get(key)
    if (!previous) sources.set(key, { name, count: 1, latest })
    else {
      previous.count++
      if (latest > previous.latest) { previous.name = name; previous.latest = latest }
    }
  }
  const filter = sourceKey(query)
  return [...sources.entries()]
    .filter(([key, value]) => value.count >= 2 && key.includes(filter))
    .sort((a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest || a[0].localeCompare(b[0]))
    .map(([, value]) => value)
}
