import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Nav } from '../App'
import { actions, useStore } from '../lib/store'
import { byPeriod, monthly, totals } from '../lib/stats'
import { fmt, fmtShort, monthShort } from '../lib/format'
import { Avatar, Card, ChevronLeft, IconButton, OpRow } from '../components/ui'

export function ClientDetail({ id, nav, onBack }: { id: string; nav: Nav; onBack: () => void }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const cats = useStore((s) => s.categories)
  const c = clients.find((x) => x.id === id)
  const own = useMemo(() => ops.filter((o) => o.clientId === id), [ops, id])
  const months = useMemo(() => monthly(own, 12), [own])
  const [confirm, setConfirm] = useState(false)
  if (!c) return null

  const stat = [
    { label: 'Месяц', v: totals(byPeriod(own, 'month')).income },
    { label: 'Год', v: totals(byPeriod(own, 'year')).income },
    { label: 'Всё время', v: totals(own).income },
  ]
  const max = Math.max(1, ...months.map((m) => m.income))

  return (
    <div className="anim-push fixed inset-0 z-45 overflow-y-auto bg-abyss pb-[calc(env(safe-area-inset-bottom)+110px)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-50" style={{ background: `radial-gradient(80% 100% at 50% 0%, ${c.color}55, transparent)` }} />
      <div className="relative mx-auto max-w-[520px]">
        <div className="pt-safe flex items-center justify-between px-4">
          <IconButton label="Назад" onClick={onBack}>
            <ChevronLeft size={22} />
          </IconButton>
          <IconButton label="Удалить клиента" onClick={() => setConfirm(true)}>
            <Trash2 size={18} />
          </IconButton>
        </div>

        <div className="mt-4 flex flex-col items-center">
          <Avatar client={c} size={88} />
          <h1 className="mt-4 font-display text-[26px] font-semibold tracking-[-0.02em]">{c.name}</h1>
          <p className="text-[14px] text-mist">{own.length} операций</p>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2 px-4">
          {stat.map((s) => (
            <Card key={s.label} className="px-3 py-3.5">
              <p className="text-[13px] text-mist">{s.label}</p>
              <p className="num mt-0.5 text-[17px] font-semibold">{fmtShort(s.v)}</p>
            </Card>
          ))}
        </div>

        <Card className="mx-4 mt-3 p-5">
          <p className="mb-4 text-[15px] font-medium">Доход по месяцам</p>
          <div className="flex h-32 items-end gap-1.5">
            {months.map((m, i) => (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                <div
                  className="w-full max-w-[16px] origin-bottom rounded-full"
                  style={{ height: `${Math.max(4, (m.income / max) * 100)}%`, background: `linear-gradient(${c.color}, ${c.color}40)`, animation: `grow-y 700ms var(--ease-spring) ${i * 30}ms both`, opacity: m.income ? 1 : 0.25 }}
                />
                <span className="text-[10px] text-fog">{monthShort(m.m)}</span>
              </div>
            ))}
          </div>
        </Card>

        <h2 className="mt-6 mb-3 px-5 text-[20px] font-semibold">Операции</h2>
        <Card className="mx-4 divide-y divide-line overflow-hidden">
          {own.map((o) => (
            <OpRow key={o.id} op={o} showDate cat={cats.find((x) => x.id === o.categoryId)} onClick={() => nav.openEdit(o.id)} />
          ))}
        </Card>
      </div>

      {confirm && (
        <div className="anim-fade fixed inset-0 z-50 grid place-items-center bg-black/60 px-8" onClick={() => setConfirm(false)}>
          <div className="glass-strong w-full max-w-[320px] rounded-[26px] p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold">Удалить «{c.name}»?</p>
            <p className="mt-1 text-[14px] text-mist">Операции останутся в истории как разовые, итого {fmt(totals(own).income)}.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button onClick={() => setConfirm(false)} className="press h-12 rounded-2xl bg-white/8 font-medium">Отмена</button>
              <button onClick={() => { actions.removeClient(c.id); onBack() }} className="press h-12 rounded-2xl bg-expense/90 font-semibold text-white">Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
