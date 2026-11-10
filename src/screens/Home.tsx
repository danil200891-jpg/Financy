import { useMemo, useState } from 'react'
import { MoneySummary } from './Planning'
import { useFittedText } from '../lib/use-fitted-text'
import { Settings2, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import type { Nav } from '../App'
import { useStore } from '../lib/store'
import { byPeriod, dailyCumulative, totals } from '../lib/stats'
import { cap, fmtShort, monthName, splitMoney } from '../lib/format'
import { Card, Empty, IconButton, OpRow } from '../components/ui'
import { Sparkline } from '../components/charts'

/** The hero: a wallet-style card with slowly drifting aurora and a gentle tilt under the finger. */
function BalanceCard({ net, income, expense, spark, period }: { period: Date; net: number; income: number; expense: number; spark: number[] }) {
  const balance = useFittedText<HTMLParagraphElement>(net)
  const m = splitMoney(net)
  return (
    <div className="px-4 [perspective:900px]">
      <div
        className="relative isolate overflow-hidden glass rounded-[26px] p-4 shadow-[0_30px_60px_-25px_rgba(124,140,255,0.6)] transition-transform duration-500 ease-[var(--ease-spring)]"
        style={{ background: 'linear-gradient(135deg,rgba(86,101,255,.35),rgba(20,22,40,.8),rgba(47,217,189,.14))' }}
      >
        <div className="flex items-center justify-between text-white/80">
          <span className="text-[15px] font-medium">Итог за {monthName(period)}</span>
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[12px] font-medium backdrop-blur">EUR</span>
        </div>

        <p ref={balance} className="num mt-2 whitespace-nowrap font-display text-[36px] leading-none font-semibold tracking-[-0.035em] text-white">
          {m.sign}
          {m.int}
          <span className="text-[0.59em] text-white/60">,{m.frac} €</span>
        </p>

        <div className="-mx-1 mt-1 h-11">
          <Sparkline data={spark} color="#ffffff" />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-black/20 p-3 backdrop-blur-md">
            <div className="flex items-center gap-1.5 text-[13px] text-white/70">
              <ArrowDownLeft size={15} className="text-income" /> Доходы
            </div>
            <p className="num mt-0.5 text-[18px] font-semibold text-white">{fmtShort(income)}</p>
          </div>
          <div className="rounded-2xl bg-black/20 p-3 backdrop-blur-md">
            <div className="flex items-center gap-1.5 text-[13px] text-white/70">
              <ArrowUpRight size={15} className="text-expense" /> Расходы
            </div>
            <p className="num mt-0.5 text-[18px] font-semibold text-white">{fmtShort(expense)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Home({ nav }: { nav: Nav }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const cats = useStore((s) => s.categories)

  const [offset, setOffset] = useState(0)
  const today = new Date()
  const period = new Date(today.getFullYear(), today.getMonth() + offset, 1)
  const month = useMemo(() => byPeriod(ops, 'month', period), [ops, offset, today.getMonth(), today.getFullYear()])
  const t = useMemo(() => totals(month), [month])
  const spark = useMemo(() => dailyCumulative(ops.filter((o) => Date.parse(o.date) <= +today), offset === 0 ? today : new Date(period.getFullYear(), period.getMonth() + 1, 0)), [ops, offset, today.getDate()])
  const recent = ops.slice(0, 6)

  return (
    <>
      <header className="pt-safe flex items-center justify-between px-5 pb-5">
        <div>
          <p className="text-[14px] text-mist">{today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <div className="mt-1 flex items-center gap-2"><button aria-label="Предыдущий месяц" onClick={() => setOffset((n) => n - 1)} className="glass press h-11 w-9 rounded-xl">‹</button><h1 className="text-[20px] font-semibold">{cap(monthName(period))} {period.getFullYear()}</h1><button aria-label="Следующий месяц" onClick={() => setOffset((n) => n + 1)} className="glass press h-11 w-9 rounded-xl">›</button></div>
        </div>
        <IconButton label="Настройки" onClick={nav.openSettings}>
          <Settings2 size={20} />
        </IconButton>
      </header>

      <BalanceCard net={t.net} income={t.income} expense={t.expense} spark={spark} period={period} />

      {/* Primary entry points — sized for the thumb. */}
      <div className="mt-4 grid grid-cols-2 gap-3 px-4">
        {[
          { label: 'Доход', Icon: ArrowDownLeft, mode: 'income' as const, color: 'text-income', surface: 'bg-income/10 ring-income/20' },
          { label: 'Расход', Icon: ArrowUpRight, mode: 'expense' as const, color: 'text-expense', surface: 'bg-expense/10 ring-expense/20' },
        ].map((a) => (
          <button key={a.mode} onClick={() => nav.openAdd(a.mode)} style={{ background: `linear-gradient(135deg,${a.mode === 'income' ? 'rgba(63,224,197,.13)' : 'rgba(255,107,129,.13)'},rgba(255,255,255,.025))` }} className={`press flex glass min-h-[72px] items-center justify-center gap-3 rounded-[24px] ring-1 ring-inset ${a.surface} ${a.color}`}>
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/5"><a.Icon size={26} strokeWidth={2} /></span>
            <span className="text-[18px] font-semibold">{a.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 px-4"><MoneySummary onSetup={() => { nav.goTab('planning') }} /></div>

      {recent.length === 0 && (
        <Card className="mx-4 mt-7">
          <Empty
            title="Добавьте первую операцию"
            text="Выберите «Доход» или «Расход», чтобы начать вести учёт"
          />
        </Card>
      )}

      {recent.length > 0 && <section className="mt-7 px-4">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2 className="text-[20px] font-semibold">Последние</h2>
          <button onClick={() => nav.goTab('history')} className="text-[15px] text-iris">История</button>
        </div>
        <Card className="divide-y divide-line overflow-hidden">
          {recent.map((o) => (
            <OpRow
              key={o.id}
              op={o}
              showDate
              cat={cats.find((c) => c.id === o.categoryId)}
              client={clients.find((c) => c.id === o.clientId)}
              onClick={() => nav.openEdit(o.id)}
            />
          ))}
        </Card>
      </section>}
    </>
  )
}
