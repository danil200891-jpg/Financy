import type { Category, Client, Operation } from './types'

export const demoCategories: Category[] = [
  { id: 'c-work', name: 'Работа', type: 'income', icon: 'briefcase', color: '#3fe0c5' },
  { id: 'c-other-in', name: 'Прочие доходы', type: 'income', icon: 'sparkles', color: '#9f6bff' },
  { id: 'c-oneoff', name: 'Разовый клиент', type: 'income', icon: 'user', color: '#ffc56b' },
  // kept (hidden) so older operations still show it; «Съёмки» now lives in the income switch
  { id: 'c-photo', name: 'Съёмки', type: 'income', icon: 'camera', color: '#7c8cff', archived: true },
  { id: 'c-food', name: 'Продукты', type: 'expense', icon: 'basket', color: '#ffc56b' },
  { id: 'c-cafe', name: 'Кафе', type: 'expense', icon: 'coffee', color: '#ff9f6b' },
  { id: 'c-shop', name: 'Покупки', type: 'expense', icon: 'bag', color: '#ff6b81' },
  { id: 'c-transport', name: 'Транспорт', type: 'expense', icon: 'car', color: '#6bc5ff' },
  { id: 'c-home', name: 'Дом', type: 'expense', icon: 'home', color: '#b58cff' },
  { id: 'c-subs', name: 'Подписки', type: 'expense', icon: 'repeat', color: '#ff7ad9' },
  { id: 'c-health', name: 'Здоровье', type: 'expense', icon: 'heart', color: '#5ee08a' },
]

export const demoClients: Client[] = [
  { id: 'cl-mvp', name: 'MVP', aliases: ['mvp studio'], color: '#7c8cff', createdAt: '2025-01-10T10:00:00Z' },
  { id: 'cl-nova', name: 'Nova Agency', aliases: ['nova'], color: '#3fe0c5', createdAt: '2025-03-02T10:00:00Z' },
  { id: 'cl-lumen', name: 'Lumen Events', aliases: ['lumen'], color: '#ffc56b', createdAt: '2025-05-15T10:00:00Z' },
  { id: 'cl-casa', name: 'Casa Verde', aliases: [], color: '#ff6b81', createdAt: '2025-08-20T10:00:00Z' },
]

let seq = 0
const id = () => `op-demo-${++seq}`

/** Deterministic pseudo-random so the demo looks the same every reload. */
function rng(seed: number) {
  return () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
}

export function buildDemoOperations(now = new Date()): Operation[] {
  const r = rng(42)
  const ops: Operation[] = []
  const push = (daysAgo: number, o: Omit<Operation, 'id' | 'date' | 'createdAt' | 'updatedAt' | 'currency' | 'source'>) => {
    const d = new Date(now)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(9 + Math.floor(r() * 11), Math.floor(r() * 60), 0, 0)
    if (d > now) d.setTime(now.getTime() - (ops.length % 5 + 1) * 17 * 60000)
    const iso = d.toISOString()
    ops.push({ id: id(), date: iso, createdAt: iso, updatedAt: iso, currency: 'EUR', source: 'manual', ...o })
  }

  // 11 months of history
  for (let m = 0; m < 11; m++) {
    const base = m * 30
    push(base + 2, { type: 'income', amount: 180000 + Math.round(r() * 60000), title: 'MVP', categoryId: 'c-work', clientId: 'cl-mvp', incomeKind: 'work' })
    if (r() > 0.25) push(base + 9, { type: 'income', amount: 35000 + Math.round(r() * 40000), title: 'Nova Agency', categoryId: 'c-work', clientId: 'cl-nova' })
    if (r() > 0.45) push(base + 16, { type: 'income', amount: 50000 + Math.round(r() * 30000), title: 'Съёмка мероприятия', categoryId: 'c-work', clientId: 'cl-lumen', incomeKind: 'shoot' })
    if (r() > 0.7) push(base + 21, { type: 'income', amount: 12000 + Math.round(r() * 20000), title: 'Портретная съёмка', categoryId: 'c-oneoff', clientId: null, incomeKind: 'shoot' })
    if (m > 2 && r() > 0.5) push(base + 12, { type: 'income', amount: 40000 + Math.round(r() * 25000), title: 'Casa Verde', categoryId: 'c-work', clientId: 'cl-casa' })

    push(base + 1, { type: 'expense', amount: 95000, title: 'Аренда квартиры', categoryId: 'c-home', clientId: null })
    for (let k = 0; k < 6; k++)
      push(base + Math.floor(r() * 29), { type: 'expense', amount: 1500 + Math.round(r() * 7000), title: r() > 0.5 ? 'Mercadona' : 'Lidl', categoryId: 'c-food', clientId: null })
    for (let k = 0; k < 4; k++)
      push(base + Math.floor(r() * 29), { type: 'expense', amount: 350 + Math.round(r() * 2500), title: ['Café de Paris', 'Starbucks', 'La Tagliatella', 'Bar Manolo'][k], categoryId: 'c-cafe', clientId: null })
    push(base + 5, { type: 'expense', amount: 1299, title: 'Spotify', categoryId: 'c-subs', clientId: null })
    push(base + 7, { type: 'expense', amount: 2299, title: 'iCloud+ и Netflix', categoryId: 'c-subs', clientId: null })
    if (r() > 0.3) push(base + Math.floor(r() * 29), { type: 'expense', amount: 2990 + Math.round(r() * 12000), title: 'Amazon', categoryId: 'c-shop', clientId: null })
    push(base + Math.floor(r() * 29), { type: 'expense', amount: 4000 + Math.round(r() * 3000), title: 'Repsol', categoryId: 'c-transport', clientId: null })
    if (r() > 0.6) push(base + Math.floor(r() * 29), { type: 'expense', amount: 3500 + Math.round(r() * 6000), title: 'Аптека', categoryId: 'c-health', clientId: null })
  }

  // make sure "today" looks alive
  push(0, { type: 'income', amount: 35000, title: 'MVP', categoryId: 'c-work', clientId: 'cl-mvp' })
  push(0, { type: 'expense', amount: 4200, title: 'Mercadona', categoryId: 'c-food', clientId: null })
  push(1, { type: 'expense', amount: 2990, title: 'Amazon', categoryId: 'c-shop', clientId: null })

  return ops.filter((o) => new Date(o.date) <= now).sort((a, b) => b.date.localeCompare(a.date))
}
