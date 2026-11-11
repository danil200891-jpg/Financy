import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Nav } from '../App'
import { useStore } from '../lib/store'
import { dayLabel, fmt, toDateInput } from '../lib/format'
import { normalize } from '../lib/parse'
import { Card, Empty, OpRow, ScreenHeader, Segmented } from '../components/ui'
import type { OpType } from '../lib/types'

export function History({ nav }: { nav: Nav }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const cats = useStore((s) => s.categories)
  const [month, setMonth] = useState(() => toDateInput(new Date().toISOString()).slice(0, 7))
  const [q, setQ] = useState('')
  const [type, setType] = useState<'all' | OpType>('all')
  const [cat, setCat] = useState<string | null>(null)
  const [limit, setLimit] = useState(100)
  const clientById = useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients])
  const catById = useMemo(() => new Map(cats.map((category) => [category.id, category])), [cats])

  const monthOps = useMemo(() => month ? ops.filter((o) => toDateInput(o.date).slice(0, 7) === month) : ops, [ops, month])
  const availableCats = useMemo(() => {
    const used = new Set(monthOps.filter((o) => type === 'all' || o.type === type).map((o) => `${o.type}:${o.categoryId}`))
    return cats.filter((c) => (type === 'all' || c.type === type) && used.has(`${c.type}:${c.id}`))
  }, [monthOps, cats, type])
  const selectedCat = availableCats.some((c) => c.id === cat) ? cat : null
  useEffect(() => { if (cat && !selectedCat) setCat(null) }, [cat, selectedCat])

  const filtered = useMemo(() => {
    const n = normalize(q)
    return monthOps.filter((o) => {
      if (type !== 'all' && o.type !== type) return false
      if (selectedCat && o.categoryId !== selectedCat) return false
      if (!n) return true
      const client = clientById.get(o.clientId ?? '')?.name ?? ''
      return normalize(`${o.title} ${client} ${o.note ?? ''}`).includes(n)
    })
  }, [monthOps, q, type, selectedCat, clientById])

  const groups = useMemo(() => {
    const g: { day: string; items: typeof filtered; net: Map<string, number> }[] = []
    let index = 0
    for (const o of filtered) {
      const day = toDateInput(o.date)
      let last = g[g.length - 1]
      if (!last || last.day !== day) g.push((last = { day, items: [], net: new Map() }))
      if (index++ < limit) last.items.push(o)
      const currency = (o.currency ?? 'EUR').toUpperCase()
      last.net.set(currency, (last.net.get(currency) ?? 0) + (o.type === 'income' ? o.amount : -o.amount))
    }
    return g.filter((group) => group.items.length)
  }, [filtered, limit])

  return (
    <>
      <ScreenHeader title="История" sub={`${filtered.length} операций`} />

      <div className="sticky top-[env(safe-area-inset-top)] z-20 space-y-3 bg-abyss/75 px-4 pt-2 pb-3 backdrop-blur-xl">
        <div className="flex items-center gap-2"><input type="month" aria-label="Месяц истории" value={month} onChange={(e) => { setMonth(e.target.value); setCat(null); setLimit(100) }} className="glass h-11 min-w-0 flex-1 rounded-2xl px-3 text-[16px]" /><button aria-pressed={!month} onClick={() => { setMonth(''); setCat(null); setLimit(100) }} className="glass press min-h-11 shrink-0 rounded-2xl px-3 text-[13px] text-mist">Все месяцы</button></div>
        <label className="glass flex h-12 items-center gap-2.5 rounded-2xl px-4">
          <Search size={18} className="text-mist" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(100) }} placeholder="Поиск по названию или клиенту" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fog" />
          {q && (
            <button aria-label="Очистить" onClick={() => setQ('')}>
              <X size={18} className="text-mist" />
            </button>
          )}
        </label>
        <Segmented
          value={type}
          onChange={(value) => { setType(value); setCat(null); setLimit(100) }}
          options={[{ value: 'all', label: 'Все' }, { value: 'income', label: 'Доходы' }, { value: 'expense', label: 'Расходы' }]}
        />
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {availableCats.map((c) => (
              <button
                key={c.id}
                aria-label={'Фильтр категории ' + c.name}
                aria-pressed={selectedCat === c.id}
                onClick={() => { setCat(selectedCat === c.id ? null : c.id); setLimit(100) }}
                className={`press shrink-0 rounded-full px-3.5 py-1.5 text-[14px] font-medium transition-colors ${selectedCat === c.id ? 'text-abyss' : 'glass text-mist'}`}
                style={selectedCat === c.id ? { background: c.color } : undefined}
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
              <span className="num flex flex-wrap justify-end gap-x-2">
                {[...g.net].map(([currency, net]) => <span key={currency} className={net >= 0 ? 'text-income' : 'text-mist'}>
                  {net >= 0 ? '+' : '−'}{fmt(Math.abs(net), currency)}
                </span>)}
              </span>
            </div>
            <Card className="divide-y divide-line overflow-hidden">
              {g.items.map((o) => (
                <OpRow
                  key={o.id}
                  op={o}
                  cat={catById.get(o.categoryId ?? '')}
                  client={clientById.get(o.clientId ?? '')}
                  onClick={() => nav.openEdit(o.id)}
                />
              ))}
            </Card>
          </section>
        ))}
        {filtered.length > limit && <button onClick={() => setLimit((value) => value + 100)} className="glass press h-12 w-full rounded-2xl text-[15px] text-iris">Показать ещё</button>}
      </div>
    </>
  )
}
