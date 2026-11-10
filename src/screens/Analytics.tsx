import { useMemo, useState } from 'react'
import type { Nav } from '../App'
import { useStore } from '../lib/store'
import { byPeriod, groupSum, monthly, totals } from '../lib/stats'
import { fmt, fmtShort, periodLabel, isEuro } from '../lib/format'
import type { OpType, Period } from '../lib/types'
import { Avatar, Card, CategoryIcon, ScreenHeader, Segmented } from '../components/ui'
import { Donut, MonthlyBars, ProgressRow } from '../components/charts'
import { useFittedText } from '../lib/use-fitted-text'

export function Analytics({ nav }: { nav: Nav }) {
  const ops = useStore((s) => s.operations)
  const cats = useStore((s) => s.categories)
  const clients = useStore((s) => s.clients)
  const [period, setPeriod] = useState<Period>('month')
  const [kind, setKind] = useState<OpType>('expense')

  const inP = useMemo(() => byPeriod(ops, period), [ops, period])
  const t = useMemo(() => totals(inP), [inP])
  const months = useMemo(() => monthly(ops, 8), [ops])
  const byCat = useMemo(() => groupSum(inP.filter((o) => o.type === kind), (o) => o.categoryId ?? 'none'), [inP, kind])
  const byClient = useMemo(() => groupSum(inP.filter((o) => o.type === 'income'), (o) => o.clientId), [inP])
  const kindTotal = kind === 'income' ? t.income : t.expense
  const savings = t.income ? Math.round((t.net / t.income) * 100) : 0
  const netRef = useFittedText<HTMLParagraphElement>(t.net)
  const savingsRef = useFittedText<HTMLParagraphElement>(savings)

  const catOf = (id: string) => cats.find((c) => c.id === id)
  const donutItems = byCat.map(([id, v]) => ({ color: catOf(id)?.color ?? '#5a5f75', value: v }))

  return (
    <>
      <ScreenHeader title="Аналитика" />
      <div className="space-y-4 px-4">
        {ops.some((operation) => !isEuro(operation)) && <p className="text-[13px] text-mist">Итоги в EUR. Операции в других валютах доступны в истории без пересчёта.</p>}
        <Segmented value={period} onChange={setPeriod} options={(['month', 'year', 'all'] as Period[]).map((p) => ({ value: p, label: periodLabel[p] }))} />

        <div className="grid grid-cols-2 gap-2.5">
          <Card className="p-4">
            <p className="text-[13px] text-mist">Чистый итог</p>
            <p ref={netRef} className={`num mt-1 whitespace-nowrap font-display text-[22px] font-semibold tracking-[-0.02em] ${t.net >= 0 ? 'text-income' : 'text-expense'}`}>
              {t.net >= 0 ? '+' : '−'}
              {fmtShort(Math.abs(t.net))}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[13px] text-mist">Сохранено</p>
            <p ref={savingsRef} className="num mt-1 whitespace-nowrap font-display text-[22px] font-semibold tracking-[-0.02em]">{savings}%</p>
            <p className="text-[12px] text-fog">от доходов</p>
          </Card>
        </div>

        <Card className="p-5">
          <p className="mb-4 text-[17px] font-semibold">Доходы и расходы</p>
          <MonthlyBars data={months} />
        </Card>

        <Card className="p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[17px] font-semibold">Категории</p>
            <Segmented
              className="w-[190px]"
              value={kind}
              onChange={setKind}
              options={[{ value: 'expense', label: 'Расходы' }, { value: 'income', label: 'Доходы' }]}
            />
          </div>
          <Donut items={donutItems} total={kindTotal} label={kind === 'income' ? 'Доходы' : 'Расходы'} />
          <div className="mt-5">
            {byCat.map(([id, v]) => {
              const c = catOf(id)
              return (
                <ProgressRow key={id} icon={<CategoryIcon cat={c} size={38} />} name={c?.name ?? 'Без категории'} amount={v} value={v} max={byCat[0][1]} color={c?.color ?? '#5a5f75'} />
              )
            })}
          </div>
        </Card>

        {byClient.length > 0 && (
          <Card className="p-5">
            <p className="mb-2 text-[17px] font-semibold">Доход по клиентам</p>
            {byClient.map(([id, v]) => {
              const c = clients.find((x) => x.id === id)!
              if (!c) return null
              return (
                <button key={id} className="block w-full text-left" onClick={() => nav.openClient(id)}>
                  <ProgressRow icon={<Avatar client={c} size={38} />} name={c.name} amount={v} value={v} max={byClient[0][1]} color={c.color} />
                </button>
              )
            })}
            <p className="mt-2 text-[13px] text-mist">Всего доходов: {fmt(t.income)}</p>
          </Card>
        )}
      </div>
    </>
  )
}
