import { useMemo, useRef, useState } from 'react'
import { ChevronRight, UserPlus } from 'lucide-react'
import type { Nav } from '../App'
import { actions, useStore, waitForWrites } from '../lib/store'
import { byPeriod, totals } from '../lib/stats'
import { fmt, fmtShort, periodLabel, plural, isEuro } from '../lib/format'
import type { Period } from '../lib/types'
import { Avatar, Card, Empty, IconButton, PrimaryButton, ScreenHeader, Segmented, Sheet } from '../components/ui'

export const CLIENT_COLORS = ['#7c8cff', '#3fe0c5', '#ffc56b', '#ff6b81', '#9f6bff', '#6bc5ff', '#ff9f6b', '#5ee08a']

export function NewClientSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(CLIENT_COLORS[0])
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (saving.current || !name.trim()) return
    saving.current = true
    setBusy(true)
    try {
      const c = actions.addClient(name, color)
      await waitForWrites()
      setName('')
      onCreated?.(c.id)
      onClose()
    } catch { /* Keep the draft on a failed write. */ }
    finally { saving.current = false; setBusy(false) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Новый клиент">
      <div className="space-y-5 px-5 pt-4">
        <div className="flex justify-center">
          <Avatar client={{ name: name || '?', color }} size={84} />
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название или имя"
          className="glass h-14 w-full rounded-2xl px-4 outline-none placeholder:text-fog"
        />
        <div className="no-scrollbar flex gap-2 overflow-x-auto py-1">
          {CLIENT_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Цвет ${c}`}
              onClick={() => setColor(c)}
              className="h-11 w-11 shrink-0 rounded-full transition-transform"
              style={{ background: c, transform: c === color ? 'scale(1.15)' : undefined, boxShadow: c === color ? `0 0 0 3px #06070d, 0 0 0 5px ${c}` : undefined }}
            />
          ))}
        </div>
        <PrimaryButton disabled={!name.trim() || busy} onClick={save}>
          Сохранить клиента
        </PrimaryButton>
      </div>
    </Sheet>
  )
}

export function Clients({ nav }: { nav: Nav }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const [period, setPeriod] = useState<Period>('month')
  const [adding, setAdding] = useState(false)

  const rows = useMemo(() => {
    const inP = byPeriod(ops, period).filter((o) => o.type === 'income' && isEuro(o))
    const sums = new Map<string, { sum: number; count: number }>()
    for (const operation of inP) {
      if (!operation.clientId) continue
      const own = sums.get(operation.clientId) ?? { sum: 0, count: 0 }
      own.sum += operation.amount
      own.count++
      sums.set(operation.clientId, own)
    }
    return clients
      .map((c) => {
        return { c, ...sums.get(c.id) ?? { sum: 0, count: 0 } }
      })
      .sort((a, b) => b.sum - a.sum)
  }, [ops, clients, period])

  const oneOff = useMemo(() => {
    const ids = new Set(clients.map((client) => client.id))
    return totals(byPeriod(ops, period).filter((o) => o.type === 'income' && (!o.clientId || !ids.has(o.clientId)))).income
  }, [ops, period, clients])
  const total = rows.reduce((s, r) => s + r.sum, 0) + oneOff
  const max = Math.max(1, ...rows.map((r) => r.sum))

  return (
    <>
      <ScreenHeader
        title="Клиенты"
        sub={`${clients.length} ${plural(clients.length, 'постоянный', 'постоянных', 'постоянных')}`}
        right={
          <IconButton label="Добавить клиента" onClick={() => setAdding(true)}>
            <UserPlus size={20} />
          </IconButton>
        }
      />
      <div className="px-4">
        <Segmented value={period} onChange={setPeriod} options={(['month', 'year', 'all'] as Period[]).map((p) => ({ value: p, label: periodLabel[p] }))} />

        <Card className="mt-4 p-5">
          <p className="text-[14px] text-mist">Доход от клиентов, {periodLabel[period].toLowerCase()}</p>
          <p className="num mt-1 font-display text-[32px] font-semibold tracking-[-0.03em]">{fmtShort(total)}</p>
          {/* share strip */}
          <div className="mt-4 flex h-2.5 gap-[3px] overflow-hidden rounded-full">
            {rows.filter((r) => r.sum > 0).map((r) => (
              <div key={r.c.id} style={{ flex: r.sum, background: r.c.color }} />
            ))}
            {oneOff > 0 && <div style={{ flex: oneOff }} className="bg-white/25" />}
          </div>
          {oneOff > 0 && <p className="mt-3 text-[13px] text-mist">Разовые без клиента: {fmt(oneOff)}</p>}
        </Card>

        {clients.length === 0 ? (
          <Empty title="Пока нет клиентов" text="Добавьте постоянного клиента, чтобы видеть его доходы за месяц и год" />
        ) : (
          <Card className="mt-4 divide-y divide-line overflow-hidden">
            {rows.map(({ c, sum, count }) => (
              <button data-scroll-reveal="" key={c.id} onClick={() => nav.openClient(c.id)} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
                <Avatar client={c} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <p className="truncate text-[16px] font-medium">{c.name}</p>
                    <p className="num text-[16px] font-semibold">{fmt(sum)}</p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/6">
                      <div className="h-full rounded-full" style={{ width: `${(sum / max) * 100}%`, background: c.color }} />
                    </div>
                    <span className="text-[12px] text-mist">
                      {count} {plural(count, 'оплата', 'оплаты', 'оплат')}
                    </span>
                  </div>
                </div>
                <ChevronRight size={18} className="text-fog" />
              </button>
            ))}
          </Card>
        )}
      </div>
      <NewClientSheet open={adding} onClose={() => setAdding(false)} />
    </>
  )
}
