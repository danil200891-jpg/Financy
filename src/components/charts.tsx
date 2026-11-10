import { useId, useState } from 'react'
import { fmt, fmtShort, monthShort } from '../lib/format'

/** Smooth path through points using Catmull-Rom → Bézier. */
function smooth(pts: [number, number][]) {
  // Straight daily segments cannot overshoot real balances like a cubic spline can.
  return pts.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
}

export function Sparkline({ data, height = 64, color = '#ffffff' }: { data: number[]; height?: number; color?: string }) {
  const id = useId()
  const w = 300
  if (data.length < 2) data = [0, ...data, ...(data.length ? [] : [0])]
  const min = Math.min(...data, 0)
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, height - 4 - ((v - min) / (max - min)) * (height - 8)] as [number, number])
  const line = smooth(pts)
  return (
    <svg key={data.join(',')} role="img" aria-label="Накопительный итог доходов и расходов по дням" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        pathLength={1}
        style={{ strokeDasharray: 1, ['--len' as string]: 1, animation: 'draw 1.4s var(--ease-spring) both' }}
      />
    </svg>
  )
}

export function MonthlyBars({ data }: { data: { m: number; income: number; expense: number }[] }) {
  const [sel, setSel] = useState(data.length - 1)
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]))
  const cur = data[sel]
  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <div>
          <p className="text-[13px] text-mist">Доход</p>
          <p className="num font-display text-[20px] font-medium text-income">{fmtShort(cur?.income ?? 0)}</p>
        </div>
        <div className="text-right">
          <p className="text-[13px] text-mist">Расход</p>
          <p className="num font-display text-[20px] font-medium text-expense">{fmtShort(cur?.expense ?? 0)}</p>
        </div>
      </div>
      <div className="flex h-40 items-end gap-1.5">
        {data.map((d, i) => (
          <button key={i} onClick={() => setSel(i)} className="flex h-full flex-1 flex-col items-center justify-end gap-2" aria-label={monthShort(d.m)}>
            <div className="flex h-full w-full items-end justify-center gap-[3px]">
              {(['income', 'expense'] as const).map((k) => (
                <div
                  key={k}
                  className="w-full max-w-[9px] origin-bottom rounded-full transition-opacity"
                  style={{
                    height: `${Math.max(3, (d[k] / max) * 100)}%`,
                    background: k === 'income' ? 'linear-gradient(#3fe0c5,#3fe0c555)' : 'linear-gradient(#ff6b81,#ff6b8155)',
                    opacity: i === sel ? 1 : 0.35,
                    animation: `grow-y 700ms var(--ease-spring) ${i * 35}ms both`,
                  }}
                />
              ))}
            </div>
            <span className={`text-[11px] ${i === sel ? 'text-ink' : 'text-fog'}`}>{monthShort(d.m)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function Donut({ items, total, label }: { items: { color: string; value: number }[]; total: number; label: string }) {
  const r = 70
  const c = 2 * Math.PI * r
  const gap = items.length > 1 ? 4 : 0
  let off = 0
  return (
    <div className="relative mx-auto aspect-square w-[200px]">
      <svg viewBox="0 0 180 180" className="-rotate-90">
        <circle cx="90" cy="90" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="16" />
        {items.map((it, i) => {
          const len = Math.max(0, (it.value / (total || 1)) * c - gap)
          const el = (
            <circle
              key={i}
              cx="90"
              cy="90"
              r={r}
              fill="none"
              stroke={it.color}
              strokeWidth="16"
              strokeLinecap="round"
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-off}
              style={{ transition: 'stroke-dasharray 600ms var(--ease-spring)' }}
            />
          )
          off += (it.value / (total || 1)) * c
          return el
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-[13px] text-mist">{label}</p>
        <p className="num font-display text-[22px] font-medium">{fmtShort(total)}</p>
      </div>
    </div>
  )
}

export function ProgressRow({ color, value, max, name, amount, icon }: {
  color: string; value: number; max: number; name: string; amount: number; icon: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3.5 py-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex justify-between gap-2">
          <span className="truncate text-[15px] font-medium">{name}</span>
          <span className="num text-[15px] font-medium">{fmt(amount)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
          <div className="h-full rounded-full" style={{ width: `${(value / (max || 1)) * 100}%`, background: color }} />
        </div>
      </div>
    </div>
  )
}
