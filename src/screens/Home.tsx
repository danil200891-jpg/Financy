import { useMemo, useRef, useState } from 'react'
import { useFittedText } from '../lib/use-fitted-text'
import { Settings2, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import type { Nav } from '../App'
import { useStore } from '../lib/store'
import { byPeriod, dailyCumulative, groupSum, totals } from '../lib/stats'
import { cap, fmtShort, monthName, splitMoney } from '../lib/format'
import { Avatar, Card, Empty, IconButton, ImageUp, Keyboard, OpRow, ScanLine } from '../components/ui'
import { Sparkline } from '../components/charts'

function greeting(d = new Date()) {
  const h = d.getHours()
  if (h < 6) return 'Доброй ночи'
  if (h < 12) return 'Доброе утро'
  if (h < 18) return 'Добрый день'
  return 'Добрый вечер'
}

/** The hero: a wallet-style card with slowly drifting aurora and a gentle tilt under the finger. */
function BalanceCard({ net, income, expense, spark }: { net: number; income: number; expense: number; spark: number[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const balance = useFittedText<HTMLParagraphElement>(net)
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const m = splitMoney(net)
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    setTilt({ x: ((e.clientY - r.top) / r.height - 0.5) * -6, y: ((e.clientX - r.left) / r.width - 0.5) * 8 })
  }
  return (
    <div className="px-4 [perspective:900px]">
      <div
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={() => setTilt({ x: 0, y: 0 })}
        className="relative isolate overflow-hidden rounded-[30px] p-5 pb-4 shadow-[0_30px_60px_-25px_rgba(124,140,255,0.6)] transition-transform duration-500 ease-[var(--ease-spring)]"
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`, background: '#14163a' }}
      >
        {/* aurora */}
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute -top-1/2 -left-1/3 h-[130%] w-[90%] rounded-full bg-[#5865ff] blur-[50px]" style={{ animation: 'aurora 14s ease-in-out infinite' }} />
          <div className="absolute -right-1/4 -bottom-1/2 h-[120%] w-[85%] rounded-full bg-[#a24dff] blur-[55px]" style={{ animation: 'aurora 18s ease-in-out infinite reverse' }} />
          <div className="absolute top-[15%] -right-[10%] h-[55%] w-[50%] rounded-full bg-[#2fd9bd] opacity-80 blur-[50px]" style={{ animation: 'aurora 11s ease-in-out infinite' }} />
          <div className="absolute inset-0 bg-[linear-gradient(165deg,rgba(255,255,255,0.18),transparent_35%,rgba(0,0,0,0.25))]" />
          <div className="absolute inset-0 rounded-[30px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]" />
        </div>

        <div className="flex items-center justify-between text-white/80">
          <span className="text-[15px] font-medium">Итог за {monthName(new Date())}</span>
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[12px] font-medium backdrop-blur">EUR</span>
        </div>

        <p ref={balance} className="num mt-3 whitespace-nowrap font-display text-[44px] leading-none font-semibold tracking-[-0.035em] text-white">
          {m.sign}
          {m.int}
          <span className="text-[0.59em] text-white/60">,{m.frac} €</span>
        </p>

        <div className="-mx-1 mt-2 h-16">
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

  const month = useMemo(() => byPeriod(ops, 'month'), [ops])
  const t = useMemo(() => totals(month), [month])
  const spark = useMemo(() => dailyCumulative(ops), [ops])
  const topClients = useMemo(
    () => groupSum(month.filter((o) => o.type === 'income'), (o) => o.clientId).slice(0, 6),
    [month],
  )
  const recent = ops.slice(0, 6)

  return (
    <>
      <header className="pt-safe flex items-center justify-between px-5 pb-5">
        <div>
          <p className="text-[15px] text-mist">{greeting()}</p>
          <h1 className="font-display text-[30px] leading-tight font-semibold tracking-[-0.02em]">{cap(monthName(new Date()))}</h1>
        </div>
        <IconButton label="Настройки" onClick={nav.openSettings}>
          <Settings2 size={20} />
        </IconButton>
      </header>

      <BalanceCard net={t.net} income={t.income} expense={t.expense} spark={spark} />

      {/* quick capture — sized for the thumb */}
      <div className="mt-4 grid grid-cols-3 gap-2.5 px-4">
        {[
          { label: 'Камера', Icon: ScanLine, mode: 'camera' as const },
          { label: 'Из фото', Icon: ImageUp, mode: 'upload' as const },
          { label: 'Текстом', Icon: Keyboard, mode: 'text' as const },
        ].map((a) => (
          <button key={a.mode} onClick={() => nav.openAdd(a.mode)} className="glass press flex flex-col items-center gap-2 rounded-[22px] py-4">
            <a.Icon size={24} className="text-iris" strokeWidth={1.9} />
            <span className="text-[14px] font-medium">{a.label}</span>
          </button>
        ))}
      </div>

      {topClients.length > 0 && (
        <section className="mt-7">
          <div className="mb-3 flex items-baseline justify-between px-5">
            <h2 className="text-[20px] font-semibold">Клиенты месяца</h2>
            <button onClick={() => nav.goTab('clients')} className="text-[15px] text-iris">Все</button>
          </div>
          <div className="no-scrollbar flex gap-2.5 overflow-x-auto px-4 pb-1">
            {topClients.map(([id, sum]) => {
              const c = clients.find((x) => x.id === id)
              if (!c) return null
              return (
                <button key={id} onClick={() => nav.openClient(id)} className="glass press flex w-[132px] shrink-0 flex-col items-start rounded-[22px] p-3.5">
                  <Avatar client={c} size={40} />
                  <p className="mt-3 w-full truncate text-left text-[15px] font-medium">{c.name}</p>
                  <p className="num text-[15px] font-semibold text-income">+{fmtShort(sum)}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {recent.length === 0 && (
        <Card className="mx-4 mt-7">
          <Empty
            title="Добавьте первую операцию"
            text="Напишите «Mercadona -42 €», сфотографируйте чек или выберите скриншот"
            action={<button onClick={() => nav.openAdd('text')} className="press rounded-2xl bg-white/10 px-5 py-3 text-[15px] font-semibold">Добавить операцию</button>}
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
