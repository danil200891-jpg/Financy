import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Nav } from '../App'
import { useStore } from '../lib/store'
import { dayLabel, fmt } from '../lib/format'
import { normalize } from '../lib/parse'
import { Card, Empty, OpRow, ScreenHeader, Segmented } from '../components/ui'
import type { OpType } from '../lib/types'

export function History({ nav }: { nav: Nav }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const cats = useStore((s) => s.categories)
  const [q, setQ] = useState('')
  const [type, setType] = useState<'all' | OpType>('all')
  const [cat, setCat] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const n = normalize(q)
    return ops.filter((o) => {
      if (type !== 'all' && o.type !== type) return false
      if (cat && o.categoryId !== cat) return false
      if (!n) return true
      const client = clients.find((c) => c.id === o.clientId)?.name ?? ''
      return normalize(`${o.title} ${client} ${o.note ?? ''}`).includes(n)
    })
  }, [ops, q, type, cat, clients])

  const groups = useMemo(() => {
    const g: { day: string; items: typeof filtered; net: number }[] = []
    for (const o of filtered) {
      const day = o.date.slice(0, 10)
      let last = g[g.length - 1]
      if (!last || last.day !== day) g.push((last = { day, items: [], net: 0 }))
      last.items.push(o)
      last.net += o.type === 'income' ? o.amount : -o.amount
    }
    return g.slice(0, 60)
  }, [filtered])

  return (
    <>
      <ScreenHeader title="История" sub={`${filtered.length} операций`} />

      <div className="sticky top-[env(safe-area-inset-top)] z-20 space-y-3 bg-abyss/75 px-4 pt-2 pb-3 backdrop-blur-xl">
        <label className="glass flex h-12 items-center gap-2.5 rounded-2xl px-4">
          <Search size={18} className="text-mist" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию или клиенту" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fog" />
          {q && (
            <button aria-label="Очистить" onClick={() => setQ('')}>
              <X size={18} className="text-mist" />
            </button>
          )}
        </label>
        <Segmented
          value={type}
          onChange={setType}
          options={[{ value: 'all', label: 'Все' }, { value: 'income', label: 'Доходы' }, { value: 'expense', label: 'Расходы' }]}
        />
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {cats
            .filter((c) => type === 'all' || c.type === type)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(cat === c.id ? null : c.id)}
                className={`press shrink-0 rounded-full px-3.5 py-1.5 text-[14px] font-medium transition-colors ${cat === c.id ? 'text-abyss' : 'glass text-mist'}`}
                style={cat === c.id ? { background: c.color } : undefined}
              >
                {c.name}
              </button>
            ))}
        </div>
      </div>

      <div className="space-y-5 px-4 pt-1">
        {groups.length === 0 && <Empty title="Ничего не найдено" text="Измените запрос или сбросьте фильтры" />}
        {groups.map((g) => (
          <section key={g.day}>
            <div className="mb-2 flex justify-between px-1 text-[14px]">
              <span className="font-medium text-mist">{dayLabel(g.items[0].date)}</span>
              <span className={`num ${g.net >= 0 ? 'text-income' : 'text-mist'}`}>
                {g.net >= 0 ? '+' : '−'}
                {fmt(Math.abs(g.net))}
              </span>
            </div>
            <Card className="divide-y divide-line overflow-hidden">
              {g.items.map((o) => (
                <OpRow
                  key={o.id}
                  op={o}
                  cat={cats.find((c) => c.id === o.categoryId)}
                  client={clients.find((c) => c.id === o.clientId)}
                  onClick={() => nav.openEdit(o.id)}
                />
              ))}
            </Card>
          </section>
        ))}
      </div>
    </>
  )
}
