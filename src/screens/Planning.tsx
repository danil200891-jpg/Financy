import { useMemo, useRef, useState } from 'react'
import { CalendarDays, Plus, Settings2, Target, ChevronRight } from 'lucide-react'
import { Card, PrimaryButton, Sheet } from '../components/ui'
import { useStore } from '../lib/store'
import { distribution, financials, localDay, obligations, projectedPlanning, reserve, savePlan, savePlanWithReserve, closePlan, nextPaymentPeriod } from '../lib/planning'
import type { PlanningRecord } from '../lib/planning-types'
import { fmt } from '../lib/format'
import { textToCents } from '../components/OperationForm'
import { toast } from '../lib/toast'
import { useSyncStatus } from '../lib/sync'

const field = 'glass h-12 w-full min-w-0 rounded-2xl px-3.5 outline-none'
const signedCents = (value: string) => {
  const clean = value.replace(/\s/g, '').replace(',', '.')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(clean)) return null
  const n = Math.round(Number(clean) * 100)
  return Number.isSafeInteger(n) ? n : null
}
type Modal = { kind: 'balance' | 'envelope' | 'move' | 'distribution' | 'history'; record?: PlanningRecord }

export function MoneySummary({ onSetup }: { onSetup: () => void }) {
  const operations = useStore((s) => s.operations)
  const planning = useStore((s) => s.planning)
  const money = useMemo(() => financials(operations, planning), [operations, planning])
  return <Card className="p-4">
    <div className="flex items-center justify-between gap-2"><p className="text-[14px] text-mist">Деньги сейчас · EUR</p><button onClick={onSetup} aria-label="Настроить баланс" className="press grid h-11 w-11 place-items-center rounded-full bg-white/5"><Settings2 size={17} /></button></div>
    {money.balance === null ? <button onClick={onSetup} className="press py-2 text-left text-[16px] font-semibold text-iris">Укажите фактический остаток</button> : <div className="grid grid-cols-3 gap-2">
      {[['Всего', money.balance], ['В резерве', money.reserved], ['Свободно', money.free!]].map(([name, amount]) => <div key={name}><p className="text-[12px] text-mist">{name}</p><p className={`num mt-1 text-[16px] font-semibold ${Number(amount) < 0 ? 'text-expense' : name === 'Свободно' ? 'text-income' : ''}`}>{fmt(Number(amount))}</p></div>)}
    </div>}
    {money.pending.length > 0 && <p className="mt-3 text-[12px] text-amber">Предварительных движений: {money.pending.length}. Они ещё не входят в подтверждённый резерв.</p>}
  </Card>
}

const frequencies = { monthly: 'Каждый месяц', quarterly: 'Каждые 3 месяца', yearly: 'Каждый год', once: 'Однократно' }

export function Planning() {
  const records = useStore((s) => s.planning)
  const operations = useStore((s) => s.operations)
  const [editor, setEditor] = useState<{ record?: PlanningRecord } | null>(null)
  const [settings, setSettings] = useState(false)
  const [modal, setModal] = useState<Modal | null>(null)
  const money = useMemo(() => financials(operations, records), [operations, records])
  const projected = useMemo(() => financials(operations, projectedPlanning()), [operations, records])
  const envelopes = records.filter((r) => r.kind === 'envelope' && (r.state !== 'closed' || (money.reserves[r.id] ?? 0) > 0 || (projected.reserves[r.id] ?? 0) > 0)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const tool = (value: Modal) => { setSettings(false); setEditor(null); setModal(value) }
  return <>
    <header className="pt-safe flex items-center justify-between gap-2 px-5 pb-4"><h1 className="font-display text-[24px] font-semibold">Планирование</h1><button aria-label="Настройки планирования" onClick={() => setSettings(true)} className="glass press grid h-11 w-11 shrink-0 place-items-center rounded-full"><Settings2 size={19} /></button></header>
    <div className="space-y-3 px-4">
      <Card className="grid grid-cols-2 gap-4 p-5">
        <div><p className="text-[13px] text-mist">Зарезервировано</p><p className="num mt-1 text-[23px] font-semibold text-iris">{fmt(money.reserved)}</p></div>
        <div><p className="text-[13px] text-mist">Свободно</p><p className={'num mt-1 text-[23px] font-semibold ' + ((money.free ?? 0) < 0 ? 'text-expense' : 'text-income')}>{money.free === null ? '—' : fmt(money.free)}</p></div>
        {money.balance === null && <button className="press col-span-2 min-h-11 text-left text-[14px] text-iris" onClick={() => tool({ kind: 'balance' })}>Указать фактический остаток</button>}
      </Card>
      {!envelopes.length && <p className="px-1 py-5 text-center text-[14px] text-mist">Добавьте план и решите, сколько отложить.</p>}
      {envelopes.map((record) => {
        const saved = money.reserves[record.id] ?? 0, target = record.target ?? 0
        const pending = records.some((r) => r.kind === 'movement' && r.status === 'pending' && (r.from === record.id || r.to === record.id))
        const rejected = records.some((r) => r.kind === 'movement' && r.status === 'rejected' && (r.from === record.id || r.to === record.id))
        const date = record.mode === 'obligation' ? nextPaymentPeriod(record, operations) : record.due
        const schedule = record.frequency === 'monthly' && record.due ? frequencies.monthly + ', ' + (record.scheduleDay ?? Number(record.due.slice(-2))) + ' числа' : (frequencies[record.frequency ?? 'once'] + (date ? ' · ' + new Date(date + 'T12:00:00').toLocaleDateString('ru-RU') : ''))
        return <button key={record.id} aria-label={'Открыть план ' + record.name} onClick={() => setEditor({ record })} className="glass press block w-full rounded-[24px] p-4 text-left">
          <div className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-iris/12 text-[23px] text-iris">{record.icon || (record.mode === 'obligation' ? <CalendarDays size={22} /> : <Target size={22} />)}</span><span className="min-w-0 flex-1"><span className="block break-words text-[17px] font-semibold">{record.name}</span><span className="num mt-0.5 block text-[15px]"><span className="font-medium text-iris">{fmt(saved)}</span><span className="text-mist"> / {fmt(target)}</span></span></span><ChevronRight size={17} className="shrink-0 text-fog" /></div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-iris transition-[width] duration-300" style={{ width: String(Math.min(100, saved / Math.max(1, target) * 100)) + '%' }} /></div>
          <p className="mt-2 text-[12px] text-mist">{record.state === 'closed' ? 'Закрыт · возврат резерва' : record.state === 'paused' ? 'На паузе · ' + schedule : schedule}</p>
          {pending && <p className="mt-1 text-[12px] text-amber">Ожидает подтверждения · резерв {fmt(projected.reserves[record.id] ?? 0)}</p>}
          {!pending && rejected && <p className="mt-1 text-[12px] text-amber">Проверьте изменение резерва</p>}
        </button>
      })}
      <button onClick={() => setEditor({})} className="glass press flex min-h-14 w-full items-center justify-center gap-2 rounded-[20px] font-semibold text-iris"><Plus size={20} /> Добавить план</button>
    </div>
    {editor && <SimplePlan record={editor.record} onClose={() => setEditor(null)} onAdvanced={() => tool({ kind: 'move', record: editor.record })} />}
    {settings && <PlanSettings onClose={() => setSettings(false)} onTool={tool} />}
    {modal && <PlanningModal modal={modal} onClose={() => setModal(null)} />}
  </>
}

function SimplePlan({ record, onClose, onAdvanced }: { record?: PlanningRecord; onClose: () => void; onAdvanced: () => void }) {
  const records = useStore((s) => s.planning), operations = useStore((s) => s.operations)
  const projected = financials(operations, projectedPlanning())
  const current = record ? projected.reserves[record.id] ?? 0 : 0
  const [name, setName] = useState(record?.name ?? '')
  const [budget, setBudget] = useState(record ? String((record.target ?? 0) / 100) : '')
  const [frequency, setFrequency] = useState<NonNullable<PlanningRecord['frequency']>>(record?.frequency ?? 'monthly')
  const [date, setDate] = useState(record?.due ?? localDay())
  const [amount, setAmount] = useState(record ? String(current / 100) : '')
  const [busy, setBusy] = useState(false), saving = useRef(false)
  const reserveAmount = amount.trim() ? signedCents(amount) : 0
  const change = (reserveAmount ?? 0) - current
  const remaining = projected.free === null ? null : projected.free - change
  const valid = !!name.trim() && !!textToCents(budget) && reserveAmount !== null && reserveAmount >= 0 && (change <= 0 || (remaining !== null && remaining >= 0)) && (frequency === 'once' || !!date)
  const save = async () => {
    if (saving.current || !valid) return
    saving.current = true; setBusy(true)
    try {
      await savePlanWithReserve({ ...record, kind: 'envelope', name: name.trim(), target: textToCents(budget)!, frequency, due: date || undefined, mode: record && record.frequency === frequency ? record.mode : frequency === 'once' ? 'goal' : 'obligation', priority: record?.priority ?? 1, state: record?.state ?? 'active' }, reserveAmount!)
      toast(record ? 'План сохранён' : 'План создан'); onClose()
    } catch (error) { toast((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }
  const remove = async () => {
    if (!record || saving.current || !window.confirm('Удалить план «' + record.name + '»? Подтверждённый резерв будет возвращён после синхронизации. История сохранится.')) return
    saving.current = true; setBusy(true)
    try { await closePlan(record); toast('План закрыт. Возврат резерва сохранён.'); onClose() } catch (error) { toast((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }
  const requests = record ? records.filter((r) => r.kind === 'movement' && r.status !== 'confirmed' && (r.from === record.id || r.to === record.id)) : []
  return <Sheet open full title={record ? 'План' : 'Новый план'} onClose={() => { if (!saving.current) onClose() }}>
    <div className="space-y-4 px-5 pt-4">
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-2 text-[14px] text-mist">Название плана<input autoComplete="off" aria-label="Название плана" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" /></label>
        <label className="block space-y-2 text-[14px] text-mist">Нужный бюджет<input aria-label="Нужный бюджет" className={field} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Сумма, EUR" /></label>
        <label className="block space-y-2 text-[14px] text-mist">Периодичность<select aria-label="Периодичность" className={field} value={frequency} onChange={(e) => { const value = e.target.value as typeof frequency; setFrequency(value); if (value === 'once' && !record) setDate('') }}>{Object.entries(frequencies).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block space-y-2 text-[14px] text-mist">{frequency === 'once' ? 'Дата (необязательно)' : 'Дата платежа'}<input type="date" aria-label="Дата платежа" className={field} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="block space-y-2 text-[14px] text-mist">{record ? 'Сколько оставить в резерве?' : 'Сколько зарезервировать сейчас?'}<input aria-label="Зарезервировать сейчас" className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></label>
        <Card className="space-y-2 p-4 text-[13px]">
          <p className="flex justify-between gap-2"><span className="text-mist">{projected.pending.length ? 'Свободно с учётом заявок' : 'Свободно до распределения'}</span><span className="num">{projected.free === null ? '—' : fmt(projected.free)}</span></p>
          <p className="flex justify-between gap-2"><span className="text-mist">{record ? 'Новый резерв плана' : 'В резерв нового плана'}</span><span className="num text-iris">{fmt(reserveAmount ?? 0)}</span></p>
          <p className="flex justify-between gap-2"><span className="text-mist">Останется свободно</span><span className={'num font-semibold ' + ((remaining ?? 0) < 0 ? 'text-expense' : 'text-income')}>{remaining === null ? '—' : fmt(remaining)}</span></p>
        </Card>
        {change > 0 && (remaining === null || remaining < 0) && <p role="alert" className="text-[13px] text-expense">{remaining === null ? 'Сначала укажите фактический остаток в настройках планирования.' : 'Эта сумма превышает свободный остаток.'}</p>}
      </fieldset>
      <PrimaryButton disabled={busy || !valid} onClick={save}>{record ? 'Сохранить изменения' : 'Создать план'}</PrimaryButton>
      {record && <><button disabled={busy} onClick={onAdvanced} className="press min-h-11 w-full text-[14px] text-iris">Другие действия с резервом</button><button disabled={busy} onClick={remove} className="press min-h-11 w-full text-[14px] text-expense">Удалить план</button></>}
      {!!requests.length && <p className="text-[12px] text-amber">Изменение резерва ожидает проверки. Подробности — в настройках планирования.</p>}
      <button disabled={busy} onClick={onClose} className="press h-12 w-full text-[15px] text-mist">Отмена</button>
    </div>
  </Sheet>
}

function PlanSettings({ onClose, onTool }: { onClose: () => void; onTool: (modal: Modal) => void }) {
  const records = useStore((s) => s.planning), operations = useStore((s) => s.operations)
  const sync = useSyncStatus(), prefs = records.find((r) => r.kind === 'settings')
  const alter = async (record: PlanningRecord, patch: Partial<PlanningRecord>) => { try { await savePlan({ ...record, ...patch }) } catch (error) { toast((error as Error).message) } }
  return <Sheet open title="Настройки планирования" onClose={onClose}><div className="space-y-3 px-5 pt-4">
    <button aria-label="Настроить баланс" onClick={() => onTool({ kind: 'balance' })} className="glass press min-h-12 w-full rounded-2xl px-4 text-left text-[15px]">Фактический баланс</button>
    <button onClick={() => onTool({ kind: 'history' })} className="glass press min-h-12 w-full rounded-2xl px-4 text-left text-[15px]">История баланса и резервов</button>
    <label className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-[14px]"><input type="checkbox" checked={prefs?.auto ?? false} onChange={(e) => { void savePlan({ id: 'planning-settings', kind: 'settings', auto: e.target.checked }).catch(() => toast('Не удалось сохранить настройку')) }} /> Предлагать распределение</label>
    <label className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-[14px]"><input type="checkbox" checked={prefs?.order === 'priority'} onChange={(e) => { void savePlan({ id: 'planning-settings', kind: 'settings', auto: prefs?.auto ?? false, order: e.target.checked ? 'priority' : 'obligations-first' }).catch(() => toast('Не удалось сохранить настройку')) }} /> Распределять по общему приоритету</label>
    <button onClick={() => onTool({ kind: 'distribution' })} className="glass press min-h-12 w-full rounded-2xl px-4 text-left text-[15px]">Посмотреть распределение</button>
    <details className="glass rounded-2xl p-4"><summary className="min-h-7 text-[14px]">Приоритеты и архив планов</summary><div className="mt-2 space-y-2">{records.filter((r) => r.kind === 'envelope').map((r) => <button key={r.id} onClick={() => onTool({ kind: 'envelope', record: r })} className="press min-h-11 w-full text-left text-[14px]">{r.name} · {r.state === 'closed' ? 'Архив' : 'Приоритет ' + r.priority}</button>)}</div></details>
    <details className="glass rounded-2xl p-4"><summary className="min-h-7 text-[14px]">Обязательства до конца месяца</summary>{obligations(operations, records).map((p) => <p key={p.envelope.id + p.period} className="mt-2 text-[13px] text-mist">{p.envelope.name} · {p.period} · {fmt(p.missing)}</p>)}</details>
    {records.filter((r) => r.kind === 'movement' && r.status !== 'confirmed').map((event) => <Card key={event.id} className="space-y-2 p-3 text-[13px]"><p>{event.status === 'pending' ? 'Ожидает подтверждения' : 'Проверьте резерв'} · {fmt(event.amount ?? 0)}</p><p className="text-mist">{event.reason || 'Подтверждение выполняется при доступном совместимом Sync.'}</p>{event.status === 'rejected' && <button className="press min-h-11 text-iris" onClick={() => { if (window.confirm('Повторить проверку резерва с текущими данными?')) void alter(event, { status: 'pending', reason: undefined }) }}>Проверить повторно</button>}<button className="press ml-3 min-h-11 text-mist" onClick={() => { void alter(event, { deletedAt: new Date().toISOString() }) }}>Отменить заявку</button></Card>)}
    <p className="text-[12px] text-mist">{sync.planningSupported ? 'Sync поддерживает подтверждение резервов.' : 'Для подтверждения резервов потребуется совместимый Financy Sync. Записи остаются на устройстве.'}</p>
    <button onClick={onClose} className="press h-12 w-full text-[15px] text-mist">Закрыть</button>
  </div></Sheet>
}

function PlanningModal({ modal, onClose }: { modal: Modal; onClose: () => void }) {
  const record = modal.record
  const records = useStore((s) => s.planning)
  const operations = useStore((s) => s.operations)
  const categories = useStore((s) => s.categories)
  const [amount, setAmount] = useState(modal.kind === 'envelope' && record ? String((record.target ?? 0) / 100) : '')
  const [name, setName] = useState(record?.name ?? '')
  const [mode, setMode] = useState<'goal' | 'obligation'>(record?.mode ?? 'obligation')
  const [frequency, setFrequency] = useState<PlanningRecord['frequency']>(record?.frequency ?? 'monthly')
  const [due, setDue] = useState(record?.due ?? localDay())
  const [priority, setPriority] = useState(String(record?.priority ?? 1))
  const [category, setCategory] = useState(record?.categoryId ?? '')
  const [state, setState] = useState(record?.state ?? 'active')
  const [icon, setIcon] = useState(record?.icon ?? '')
  const [cushion, setCushion] = useState(record?.cushion ?? false)
  const [action, setAction] = useState('add')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const proposal = useMemo(() => distribution(operations, projectedPlanning()), [operations, records])
  const title = { balance: 'Фактический баланс', envelope: record ? 'Изменить конверт' : 'Новый конверт', move: 'Управление резервом', distribution: 'Распределение денег', history: 'История баланса и резервов' }[modal.kind]
  const save = async () => {
    if (saving.current) return
    saving.current = true; setBusy(true)
    try {
      if (modal.kind === 'balance') {
        const cents = signedCents(amount)
        if (cents === null) throw new Error('Введите корректный остаток')
        await savePlan({ kind: 'balance', amount: cents, at: new Date().toISOString(), name: name.trim() || 'Ручная корректировка' })
      } else if (modal.kind === 'envelope') {
        const target = textToCents(amount)
        if (!target || !name.trim() || !/^\d{1,3}$/.test(priority) || (mode === 'obligation' && !due)) throw new Error('Проверьте название, сумму, приоритет и дату')
        await savePlan({ ...record, kind: 'envelope', name: name.trim(), target, priority: Number(priority), mode, frequency: mode === 'goal' ? 'once' : frequency, due: due || undefined, categoryId: category || null, state, cushion, icon: icon.trim().slice(0, 8) })
      } else if (modal.kind === 'move') {
        const cents = action === 'set' ? signedCents(amount) : textToCents(amount)
        if (cents === null || cents < 0) throw new Error('Введите положительную сумму или ноль для изменения резерва')
        const current = financials(operations, projectedPlanning()).reserves[record!.id] ?? 0
        const difference = action === 'set' ? cents - current : cents
        if (!difference) { onClose(); return }
        await reserve(Math.abs(difference), action === 'take' || action === 'transfer' || difference < 0 ? record!.id : null, action === 'transfer' ? destination || null : action === 'take' || difference < 0 ? null : record!.id)
      } else if (modal.kind === 'distribution') {
        for (const item of proposal) await reserve(item.amount, null, item.envelopeId)
      }
      toast(modal.kind === 'move' || modal.kind === 'distribution' ? 'Движения сохранены предварительно. Ожидают проверки компьютером.' : 'Сохранено')
      onClose()
    } catch (error) { toast((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }
  return <Sheet open onClose={() => { if (!saving.current) onClose() }} title={title}>
    <div className="space-y-4 px-5 pt-4">
      <fieldset disabled={busy} className="space-y-4">
      {modal.kind === 'balance' && <><p className="text-[14px] text-mist">Введите сумму денег в наличии сейчас. Это новая точка отсчёта с текущего момента. История корректировок сохранится; доход или расход не создаётся.</p><input aria-label="Фактический баланс" className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Остаток, EUR" /><input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Причина корректировки (необязательно)" /></>}
      {modal.kind === 'envelope' && <>
        <select aria-label="Тип конверта" className={field} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="obligation">Обязательный платёж</option><option value="goal">Цель накопления</option></select>
        <input aria-label="Название конверта" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" />
        <input aria-label="Сумма конверта" className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Необходимая сумма, EUR" />
        {mode === 'obligation' && <select aria-label="Периодичность" className={field} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}><option value="monthly">Ежемесячно</option><option value="quarterly">Раз в квартал</option><option value="yearly">Ежегодно</option><option value="once">Однократно</option></select>}
        <label className="block space-y-2 text-[14px] text-mist">{mode === 'goal' ? 'Желаемый срок (необязательно)' : 'Дата первого платежа'}<input aria-label="Срок конверта" type="date" className={field} value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label className="block space-y-2 text-[14px] text-mist">Приоритет (0 — самый высокий)<input aria-label="Приоритет" className={field} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} /></label>
        <select aria-label="Категория конверта" className={field} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Категория не указана</option>{categories.filter((c) => c.type === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {mode === 'goal' && <><label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={cushion} onChange={(e) => setCushion(e.target.checked)} /> Финансовая подушка</label><input aria-label="Иконка цели" className={field} value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Иконка, например символ (необязательно)" /></>}
        {record && <select aria-label="Статус конверта" className={field} value={state} onChange={(e) => setState(e.target.value as typeof state)}><option value="active">Активно</option><option value="paused">Приостановлено</option><option value="closed">Закрыто</option></select>}
        {record && <p className="text-[13px] text-mist">Пауза или закрытие не забирают резерв автоматически. Новая сумма регулярного платежа действует с ближайшего будущего периода либо с выбранной новой даты. Старые условия сохраняются.</p>}
      </>}
      {modal.kind === 'move' && <><p className="text-[15px]">{record?.name}</p><select className={field} aria-label="Действие с резервом" value={action} onChange={(e) => setAction(e.target.value)}><option value="add">Добавить из свободных денег</option><option value="take">Вернуть в свободный остаток</option><option value="set">Задать новый размер резерва</option><option value="transfer">Перевести в другой конверт</option></select><input aria-label="Сумма движения" className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Сумма, EUR" />{action === 'transfer' && <select className={field} value={destination} onChange={(e) => setDestination(e.target.value)}><option value="">В свободный остаток</option>{records.filter((r) => r.kind === 'envelope' && r.id !== record?.id && r.state === 'active').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}<p className="text-[13px] text-amber">До проверки компьютером это предварительное движение. Фактический баланс не изменится.</p></>}
      {modal.kind === 'distribution' && <>{proposal.length ? proposal.map((p) => <div key={p.envelopeId} className="glass flex justify-between gap-3 rounded-2xl p-3 text-[15px]"><span>{p.name}</span><span className="num text-income">{fmt(p.amount)}</span></div>) : <p className="text-[14px] text-mist">Нет свободной суммы для распределения. Задайте баланс, создайте активные конверты и проверьте предварительные движения.</p>}<p className="text-[13px] text-mist">Сначала обязательства, затем подушка и цели по приоритету. Предварительные движения уже учтены. Подтверждённые резервы не перераспределяются.</p></>}
      {modal.kind === 'history' && <>{records.filter((r) => r.kind === 'balance' || r.kind === 'movement').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => <div key={r.id} className="glass space-y-1 rounded-2xl p-3 text-[14px]"><p>{r.kind === 'balance' ? r.name || 'Корректировка баланса' : `${records.find((p) => p.id === r.from)?.name ?? 'Свободные'} → ${records.find((p) => p.id === r.to)?.name ?? 'Свободные'}`}</p><p className="num font-medium">{fmt(r.amount ?? 0)}</p><p className="text-[12px] text-mist">{new Date(r.createdAt).toLocaleString('ru-RU')}{r.kind === 'movement' ? ` · ${r.status === 'confirmed' ? 'Подтверждено' : r.status === 'pending' ? 'Предварительно' : 'Отклонено'}` : ''}</p></div>)}{operations.filter((o) => o.planningPayment).map((o) => <div key={o.id} className="glass rounded-2xl p-3 text-[14px]">Оплата: {o.title} · {fmt(o.amount)}<p className="text-[12px] text-mist">Из резерва до {fmt(o.planningPayment!.reserved)} · {new Date(o.date).toLocaleDateString('ru-RU')}</p></div>)}</>}
      </fieldset>
      {modal.kind !== 'history' && <PrimaryButton onClick={save} disabled={busy || (modal.kind === 'distribution' && !proposal.length)}>{busy ? 'Сохранение…' : modal.kind === 'distribution' ? 'Подтвердить распределение' : 'Сохранить'}</PrimaryButton>}
      <button onClick={onClose} disabled={busy} className="press h-12 w-full rounded-2xl text-[15px] text-mist">{modal.kind === 'history' ? 'Закрыть' : 'Отмена'}</button>
    </div>
  </Sheet>
}
