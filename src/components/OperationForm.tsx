import { useMemo } from 'react'
import { AlertTriangle, CalendarDays, UserRound } from 'lucide-react'
import type { OpType } from '../lib/types'
import { findDuplicate, useStore, type OperationDraft } from '../lib/store'
import { dayLabel, fmt, toDateInput } from '../lib/format'
import { Avatar, CategoryIcon, Segmented } from './ui'
import { incomeSources } from '../lib/income-sources'

/** Amount is edited as text ("42,50") and converted to cents on save. */
export interface FormValue {
  type: OpType
  amountText: string
  title: string
  categoryId: string | null
  clientId: string | null
  date: string // yyyy-mm-dd
  note: string
  currency?: string
}

export const centsToText = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, ''))
export const textToCents = (t: string) => {
  const clean = t.replace(/\s/g, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null
  const cents = Math.round(Number(clean) * 100)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function toDraft(v: FormValue, source: OperationDraft['source'], keepTime?: string): OperationDraft | null {
  const amount = textToCents(v.amountText)
  if (!amount || !v.title.trim()) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return null
  const time = keepTime ? new Date(keepTime) : new Date()
  const [y, m, d] = v.date.split('-').map(Number)
  if (!Number.isFinite(time.getTime()) || y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null
  time.setFullYear(y, m - 1, d)
  if (time.getFullYear() !== y || time.getMonth() !== m - 1 || time.getDate() !== d) return null
  const date = time.toISOString()
  return {
    type: v.type, amount, currency: v.currency ?? 'EUR', title: v.title.trim(), categoryId: v.categoryId,
    clientId: v.type === 'income' ? v.clientId : null, date, note: v.note.trim() || undefined, source,
  }
}

export const emptyForm = (): FormValue => ({
  type: 'expense', amountText: '', title: '', categoryId: null, clientId: null, date: toDateInput(new Date().toISOString()), note: '',
})

export function OperationForm({ value, onChange, ignoreId, flags, fixedType, suggestSources = false }: {
  value: FormValue
  onChange: (v: FormValue) => void
  ignoreId?: string
  fixedType?: boolean
  suggestSources?: boolean
  /** fields the recognizer was unsure about — highlighted for confirmation */
  flags?: Partial<Record<'type' | 'amount' | 'title' | 'date', string>>
}) {
  const cats = useStore((s) => s.categories)
  const clients = useStore((s) => s.clients)
  const operations = useStore((s) => s.operations)
  const set = (p: Partial<FormValue>) => onChange({ ...value, ...p })
  const income = value.type === 'income'
  const sources = useMemo(() => income && suggestSources ? incomeSources(operations, value.title).slice(0, 8) : [], [operations, value.title, income, suggestSources])

  const dup = useMemo(() => {
    const d = toDraft(value, 'manual')
    return d ? findDuplicate(d, ignoreId) : undefined
  }, [value, ignoreId, operations])

  const flag = (k: keyof NonNullable<typeof flags>) =>
    flags?.[k] ? <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-amber"><AlertTriangle size={14} /> {flags[k]}</p> : null

  return (
    <div className="space-y-5">
      {!fixedType && <div>
        <Segmented
          value={value.type}
          onChange={(type) => set({ type, categoryId: cats.find((c) => c.id === value.categoryId)?.type === type ? value.categoryId : null })}
          options={[{ value: 'expense', label: 'Расход' }, { value: 'income', label: 'Доход' }]}
        />
        {flag('type')}
      </div>}

      <div className="text-center">
        <div className={`flex items-baseline justify-center gap-1 font-display font-semibold tracking-[-0.03em] ${income ? 'text-income' : 'text-ink'}`}>
          <span className="text-[34px] opacity-60">{income ? '+' : '−'}</span>
          <input
            inputMode="decimal"
            value={value.amountText}
            onChange={(e) => set({ amountText: e.target.value.replace(/[^\d.,\s]/g, '') })}
            placeholder="0"
            aria-label="Сумма"
            className="num w-[min(70vw,260px)] bg-transparent text-center !text-[52px] leading-none outline-none placeholder:text-white/20"
          />
          <span className="text-[30px] opacity-60">{value.currency && value.currency !== 'EUR' ? value.currency : '€'}</span>
        </div>
        {flag('amount')}
      </div>

      <div>
        <input
          value={value.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={income ? 'Источник дохода' : 'Магазин или получатель'}
          aria-label="Название"
          autoComplete="off"
          className="glass h-14 w-full rounded-2xl px-4 outline-none placeholder:text-fog"
        />
        {flag('title')}
        {sources.length > 0 && <div className="mt-3" aria-label="Подсказки источников дохода">
          <p className="mb-2 px-1 text-[13px] text-mist">Частые источники</p>
          <div className="flex flex-wrap gap-2">
            {sources.map((source) => <button type="button" key={source.name} onClick={() => set({ title: source.name })} className="press min-h-11 max-w-full rounded-2xl bg-income/10 px-3.5 py-2 text-left text-[14px] text-income [overflow-wrap:anywhere]">{source.name}</button>)}
          </div>
        </div>}
      </div>

      {income && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 px-1 text-[14px] text-mist"><UserRound size={15} /> Клиент</p>
          <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
            <button
              onClick={() => set({ clientId: null })}
              className={`press shrink-0 rounded-full px-4 py-2 text-[14px] font-medium ${!value.clientId ? 'bg-white text-abyss' : 'glass text-mist'}`}
            >
              Разовый доход
            </button>
            {clients.map((c) => (
              <button
                key={c.id}
                onClick={() => set({ clientId: c.id })}
                className={`press flex shrink-0 items-center gap-2 rounded-full py-1 pr-4 pl-1 text-[14px] font-medium ${value.clientId === c.id ? 'bg-white text-abyss' : 'glass text-ink'}`}
              >
                <Avatar client={c} size={30} /> {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 px-1 text-[14px] text-mist">Категория</p>
        <div className="grid grid-cols-4 gap-2">
          {cats.filter((c) => c.type === value.type).map((c) => {
            const on = value.categoryId === c.id
            return (
              <button
                key={c.id}
                onClick={() => set({ categoryId: on ? null : c.id })}
                className={`press flex flex-col items-center gap-1.5 rounded-2xl py-2.5 transition-colors ${on ? 'bg-white/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]' : ''}`}
              >
                <CategoryIcon cat={c} size={40} />
                <span className={`w-full truncate px-1 text-[12px] ${on ? 'text-ink' : 'text-mist'}`}>{c.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input
          value={value.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Заметка"
          className="glass h-12 min-w-0 rounded-2xl px-4 outline-none placeholder:text-fog"
        />
        <label className="glass relative flex h-12 items-center gap-2 rounded-2xl px-4 text-[15px]">
          <CalendarDays size={17} className="text-mist" />
          {Number.isFinite(Date.parse(value.date + 'T12:00:00')) ? dayLabel(value.date + 'T12:00:00') : 'Выберите дату'}
          <input type="date" value={value.date} onChange={(e) => set({ date: e.target.value })} className="absolute inset-0 opacity-0" aria-label="Дата" />
        </label>
      </div>
      {flag('date')}

      {dup && (
        <div className="flex gap-3 rounded-2xl bg-amber/10 p-3.5 text-[14px] text-amber shadow-[inset_0_0_0_1px_rgba(255,197,107,0.25)]">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>
            Похоже на дубликат: «{dup.title}» на {fmt(dup.amount)} уже есть за {dayLabel(dup.date).toLowerCase()}. Сохранить всё равно?
          </p>
        </div>
      )}
    </div>
  )
}
