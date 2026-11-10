import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { financials, nextPaymentPeriod } from '../lib/planning'
import { AlertTriangle, CalendarDays, Check, ChevronDown, Plus, Search, UserRound } from 'lucide-react'
import type { IncomeKind, Operation, OpType } from '../lib/types'
import { actions, findClientByName, findDuplicate, getState, useStore, waitForWrites, type OperationDraft } from '../lib/store'
import { dayLabel, fmt, toDateInput } from '../lib/format'
import { normalize } from '../lib/parse'
import { Avatar, CategoryIcon, Segmented, Sheet } from './ui'
import { incomeSources } from '../lib/income-sources'

export const INCOME_KINDS: { value: IncomeKind; label: string }[] = [
  { value: 'work', label: 'Работа' }, { value: 'shoot', label: 'Съёмки' }, { value: 'oneoff', label: 'Разовый доход' },
]

/** Older incomes have no switch value: derive one for display/editing only (nothing is written until saved). */
export function incomeKindOf(o: Pick<Operation, 'incomeKind' | 'categoryId' | 'clientId'>): IncomeKind {
  if (o.incomeKind) return o.incomeKind
  if (o.categoryId === 'c-photo') return 'shoot'
  return o.clientId ? 'work' : 'oneoff'
}

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
  incomeKind?: IncomeKind
  planningPayment?: Operation['planningPayment']
}

export const centsToText = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, ''))
export const textToCents = (t: string) => {
  const clean = t.replace(/\s/g, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null
  const cents = Math.round(Number(clean) * 100)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function toDraft(v: FormValue, source: OperationDraft['source'], keepTime?: string, creating = false): OperationDraft | null {
  const amount = textToCents(v.amountText)
  if (!amount || (creating && v.type === 'expense' && !v.categoryId)) return null
  const category = getState().categories.find((c) => c.id === v.categoryId)
  const title = v.title.trim() || (v.type === 'expense' ? category?.name ?? '' : '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return null
  const time = keepTime ? new Date(keepTime) : new Date()
  const [y, m, d] = v.date.split('-').map(Number)
  if (!Number.isFinite(time.getTime()) || y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null
  time.setFullYear(y, m - 1, d)
  if (time.getFullYear() !== y || time.getMonth() !== m - 1 || time.getDate() !== d) return null
  const date = time.toISOString()
  return {
    type: v.type, amount, currency: v.currency ?? 'EUR', title, categoryId: v.categoryId,
    clientId: v.type === 'income' ? v.clientId : null, date, note: v.note.trim() || undefined, source,
    ...(v.planningPayment && v.type === 'expense' ? { planningPayment: { ...v.planningPayment, reserved: Math.min(amount, v.planningPayment.reserved) } } : {}),
    ...(v.type === 'income' ? { incomeKind: v.incomeKind ?? 'work' } : {}),
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
  const operations = useStore((s) => s.operations)
  const planning = useStore((s) => s.planning)
  const manualCategory = useRef(false)
  useEffect(() => { manualCategory.current = false }, [ignoreId, value.type])
  const available = financials(operations.filter((o) => o.id !== ignoreId), planning)
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

      {income && !fixedType && (
        <Segmented value={value.incomeKind ?? 'work'} onChange={(incomeKind) => set({ incomeKind })} options={INCOME_KINDS} />
      )}

      <div className="text-center">
        <div className={`flex items-baseline justify-center gap-1 font-display font-semibold tracking-[-0.03em] ${income ? 'text-income' : 'text-ink'}`}>
          <span className="text-[34px] opacity-60">{income ? '+' : '−'}</span>
          <input
            inputMode="decimal"
            value={value.amountText}
            onChange={(e) => { const amountText = e.target.value.replace(/[^\d.,\s]/g, ''); set({ amountText, ...(!ignoreId && value.planningPayment ? { planningPayment: { ...value.planningPayment, reserved: Math.min(textToCents(amountText) ?? 0, available.reserves[value.planningPayment.envelopeId] ?? 0) } } : {}) }) }}
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
          onChange={(e) => {
            const title = e.target.value
            const rules: [RegExp, string][] = [[/lidl|mercadona|carrefour|aldi|пят[её]рочка|магнит/i, 'c-food'], [/starbucks|кафе|cafe|restaurant|mcdonald/i, 'c-cafe']]
            const guess = rules.find(([pattern]) => pattern.test(title))?.[1]
            set({ title, ...(!income && !manualCategory.current ? { categoryId: cats.some((c) => c.id === guess && !c.deletedAt) ? guess! : null } : {}) })
          }}
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

      {income && <ClientField value={value.clientId} onChange={(clientId) => set({ clientId, title: clientId ? getState().clients.find((c) => c.id === clientId)?.name ?? '' : value.title })} />}

      <div>
        <p className="mb-2 px-1 text-[14px] text-mist">Категория</p>
        <div className={`grid gap-2 ${income ? 'grid-cols-3' : 'grid-cols-4'}`}>
          {cats.filter((c) => c.type === value.type && (!c.archived || c.id === value.categoryId)).map((c) => {
            const on = value.categoryId === c.id
            return (
              <button
                key={c.id}
                aria-pressed={on}
                style={{ background: on ? 'rgba(124,140,255,.17)' : 'rgba(255,255,255,.025)', border: `1px solid ${on ? 'rgba(124,140,255,.4)' : 'rgba(255,255,255,.06)'}` }}
                onClick={() => { manualCategory.current = true; set({ categoryId: !income && on ? null : c.id }) }}
                className={`press flex flex-col items-center gap-1.5 rounded-2xl py-2.5 transition-colors ${on ? 'bg-white/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]' : ''}`}
              >
                <CategoryIcon cat={c} size={40} />
                <span className={`line-clamp-2 w-full px-1 text-[12px] leading-tight [overflow-wrap:anywhere] ${on ? 'text-ink' : 'text-mist'}`}>{c.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      {!income && (value.currency ?? 'EUR') === 'EUR' && planning.some((r) => r.kind === 'envelope') && <label className="block space-y-2 text-[14px] text-mist">Оплата из резерва
        <select aria-label="Оплата из резерва" value={value.planningPayment?.envelopeId ?? ''} onChange={(event) => {
          const id = event.target.value
          const envelope = planning.find((r) => r.id === id)
          const period = envelope?.mode === 'obligation' ? nextPaymentPeriod(envelope, operations.filter((o) => o.id !== ignoreId)) : undefined
          set({ planningPayment: id ? { envelopeId: id, reserved: Math.min(textToCents(value.amountText) ?? 0, available.reserves[id] ?? 0), period } : undefined })
        }} className="glass h-12 w-full rounded-2xl px-3">
          <option value="">Без использования резерва</option>
          {planning.filter((r) => r.kind === 'envelope' && ((available.reserves[r.id] ?? 0) > 0 || r.id === value.planningPayment?.envelopeId)).map((r) => <option key={r.id} value={r.id}>{r.name} · {fmt(available.reserves[r.id] ?? 0)}</option>)}
        </select>
        {value.planningPayment && <span className="block text-[13px]">Из резерва: {fmt(Math.min(value.planningPayment.reserved, textToCents(value.amountText) ?? 0))}. Это один реальный расход.{value.planningPayment.period ? ` Платёжный период: ${value.planningPayment.period}.` : ''}</span>}
      </label>}

      <div className="grid grid-cols-[1fr_auto] gap-2">
        {!fixedType && <input
          value={value.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Заметка"
          className="glass h-12 min-w-0 rounded-2xl px-4 outline-none placeholder:text-fog"
        />}
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

const CLIENT_COLORS = ['#7c8cff', '#3fe0c5', '#ffc56b', '#ff6b81', '#9f6bff', '#6bc5ff', '#ff9f6b', '#5ee08a']

/** Client is optional. Tapping opens a searchable list; «+» creates (and selects) a client from the search text. */
function ClientField({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const clients = useStore((s) => s.clients)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = clients.find((c) => c.id === value)
  const q = normalize(query)
  const list = clients
    .filter((c) => !q || normalize(c.name).includes(q) || c.aliases?.some((a) => normalize(a).includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const exact = query.trim() ? findClientByName(query) : undefined
  const close = () => { setOpen(false); setQuery('') }
  const pick = (id: string | null) => { onChange(id); close() }
  const add = async () => {
    if (busy) return
    if (!query.trim()) { inputRef.current?.focus(); return }
    if (exact) return pick(exact.id)
    setBusy(true)
    try {
      const c = actions.addClient(query, CLIENT_COLORS[clients.length % CLIENT_COLORS.length])
      await waitForWrites()
      pick(c.id)
    } catch { /* the store already reported the failed write */ }
    finally { setBusy(false) }
  }
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 px-1 text-[14px] text-mist"><UserRound size={15} /> Клиент</p>
      <button type="button" aria-label="Выбрать клиента" onClick={() => setOpen(true)} className="glass press flex h-14 w-full items-center gap-3 rounded-2xl px-3 text-left">
        {selected ? <Avatar client={selected} size={34} /> : <NoClient />}
        <span className={`min-w-0 flex-1 truncate text-[16px] ${selected ? '' : 'text-fog'}`}>{selected?.name ?? 'Без клиента'}</span>
        <ChevronDown size={18} className="text-fog" />
      </button>

      <Sheet open={open} onClose={close} title="Клиент">
        <div className="px-4 pt-3">
          <div className="flex gap-2">
            <label className="glass flex h-12 min-w-0 flex-1 items-center gap-2 rounded-2xl px-3.5">
              <Search size={17} className="shrink-0 text-fog" />
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
                placeholder="Поиск или новый клиент" aria-label="Поиск клиента" autoComplete="off" enterKeyHint="done"
                className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-fog" />
            </label>
            <button type="button" aria-label="Добавить клиента" disabled={busy} onClick={add} className="press grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-iris/15 text-iris disabled:opacity-40">
              <Plus size={22} />
            </button>
          </div>
          {query.trim() && !exact && <p className="mt-2 px-1 text-[13px] text-mist">«+» добавит клиента «{query.trim().replace(/\s+/g, ' ')}»</p>}
          <div className="glass mt-3 divide-y divide-line overflow-hidden rounded-[22px]">
            {!q && <ClientRow label="Без клиента" on={!value} onClick={() => pick(null)} />}
            {list.map((c) => <ClientRow key={c.id} label={c.name} on={value === c.id} onClick={() => pick(c.id)} avatar={<Avatar client={c} size={34} />} />)}
            {q && !list.length && <p className="px-4 py-5 text-center text-[14px] text-mist">Клиент не найден</p>}
            {!q && !clients.length && <p className="px-4 py-5 text-center text-[14px] text-mist">Клиентов пока нет. Введите имя и нажмите «+».</p>}
          </div>
        </div>
      </Sheet>
    </div>
  )
}

const NoClient = () => <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-white/6 text-fog"><UserRound size={17} /></span>

function ClientRow({ label, on, onClick, avatar }: { label: string; on: boolean; onClick: () => void; avatar?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="press flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left">
      {avatar ?? <NoClient />}
      <span className="min-w-0 flex-1 truncate text-[16px]">{label}</span>
      {on && <Check size={19} className="text-iris" />}
    </button>
  )
}
