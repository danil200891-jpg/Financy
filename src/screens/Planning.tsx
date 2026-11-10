import { useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, CalendarDays, History, Plus, Settings2, Target, Wallet } from 'lucide-react'
import { Card, Empty, PrimaryButton, ScreenHeader, Sheet } from '../components/ui'
import { useStore } from '../lib/store'
import { distribution, financials, localDay, obligations, projectedPlanning, reserve, savePlan, nextPaymentPeriod } from '../lib/planning'
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

export function Planning() {
  const planning = useStore((s) => s.planning)
  const operations = useStore((s) => s.operations)
  const [modal, setModal] = useState<Modal | null>(null)
  const sync = useSyncStatus()
  const money = useMemo(() => financials(operations, planning), [operations, planning])
  const due = useMemo(() => obligations(operations, planning), [operations, planning])
  const needs = new Map<string, number>()
  for (const period of due) needs.set(period.envelope.id, (needs.get(period.envelope.id) ?? 0) + period.missing)
  const required = due.reduce((sum, p) => sum + p.missing, 0)
  const funded = [...needs].reduce((sum, [id, need]) => sum + Math.min(need, money.reserves[id] ?? 0), 0)
  const shortage = Math.max(0, required - funded - Math.max(0, money.free ?? 0))
  const envelopes = planning.filter((r) => r.kind === 'envelope').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const goals = envelopes.filter((r) => r.mode === 'goal' && r.state === 'active')
  const goalTarget = goals.reduce((sum, goal) => sum + (goal.target ?? 0), 0)
  const goalSaved = goals.reduce((sum, goal) => sum + (money.reserves[goal.id] ?? 0), 0)
  const automatic = planning.find((r) => r.kind === 'settings')?.auto ?? false
  const alter = async (record: PlanningRecord, patch: Partial<PlanningRecord>) => {
    try { await savePlan({ ...record, ...patch }); toast('Сохранено') } catch (error) { toast((error as Error).message) }
  }
  return <>
    <ScreenHeader title="Планирование" />
    <div className="space-y-4 px-4">
      <MoneySummary onSetup={() => setModal({ kind: 'balance' })} />
      <Card className="grid grid-cols-2 gap-3 p-4 text-[13px]"><div><p className="text-mist">К оплате до конца месяца</p><p className="num mt-1 font-semibold">{fmt(required)}</p></div><div><p className="text-mist">Прогресс активных целей</p><p className="num mt-1 font-semibold text-income">{fmt(goalSaved)} / {fmt(goalTarget)}</p><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-income transition-[width]" style={{ width: `${Math.min(100, goalTarget ? goalSaved / goalTarget * 100 : 0)}%` }} /></div></div></Card>
      <p className="px-1 text-[13px] text-mist">{sync.planningSupported ? 'Резервы подтверждаются компьютером после проверки.' : 'Для подтверждения резервов потребуется обновлённый Financy Sync. До этого доступны предварительные движения.'}</p>
      <Card className="space-y-3 p-4">
        <h2 className="text-[17px] font-semibold">Хватит ли денег до конца месяца?</h2>
        <p className={`text-[16px] font-medium ${shortage || (money.free ?? 0) < 0 ? 'text-expense' : 'text-income'}`}>{money.balance === null ? 'Сначала укажите фактический баланс' : shortage ? `Не хватает ${fmt(shortage)}` : money.free! < 0 ? `Есть риск нехватки: дефицит ${fmt(-money.free!)}` : 'Денег достаточно на известные обязательства'}</p>
        <p className="text-[13px] text-mist">Неоплаченные обязательства с учётом просроченных: {fmt(required)}. Будущие доходы не включены.</p>
      </Card>
      <div className="grid grid-cols-2 gap-2">
        <button className="glass press flex min-h-14 items-center justify-center gap-2 rounded-2xl px-2 text-[14px]" onClick={() => setModal({ kind: 'envelope' })}><Plus size={18} /> Конверт</button>
        <button className="glass press flex min-h-14 items-center justify-center gap-2 rounded-2xl px-2 text-[14px]" onClick={() => setModal({ kind: 'distribution' })}><ArrowLeftRight size={18} /> Распределить</button>
      </div>
      <label className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-[14px]"><input type="checkbox" checked={automatic} onChange={(event) => { void savePlan({ id: 'planning-settings', kind: 'settings', auto: event.target.checked }).catch(() => toast('Не удалось сохранить настройку')) }} /> Предлагать распределение свободных денег</label>
      <label className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-[14px]"><input type="checkbox" checked={planning.find((r) => r.kind === 'settings')?.order === 'priority'} onChange={(event) => { void savePlan({ id: 'planning-settings', kind: 'settings', auto: automatic, order: event.target.checked ? 'priority' : 'obligations-first' }).catch(() => toast('Не удалось сохранить настройку')) }} /> Использовать общий приоритет вместо порядка «обязательства → подушка → цели»</label>
      {automatic && distribution(operations, projectedPlanning()).length > 0 && <button onClick={() => setModal({ kind: 'distribution' })} className="glass press w-full rounded-2xl p-4 text-left text-[14px] text-income">Есть свободные деньги. Посмотреть предложение →</button>}
      {envelopes.length === 0 && <Card><Empty title="Планы без лишних трат" text="Добавьте обязательный платёж или цель. Резервирование не создаёт расход." /></Card>}
      {envelopes.map((envelope) => {
        const nextDue = envelope.mode === 'obligation' ? nextPaymentPeriod(envelope, operations) : envelope.due
        const saved = money.reserves[envelope.id] ?? 0
        const target = envelope.target ?? 0
        const missing = Math.max(0, target - saved)
        const percent = Math.min(100, Math.round(saved / Math.max(1, target) * 100))
        return <Card key={envelope.id} className="space-y-3 p-4">
          <button onClick={() => setModal({ kind: 'envelope', record: envelope })} className="press flex w-full items-start gap-3 text-left"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-iris/12 text-iris">{envelope.mode === 'obligation' ? <CalendarDays size={21} /> : <Target size={21} />}</span><span className="min-w-0 flex-1"><span className="block break-words text-[17px] font-semibold">{envelope.icon ? `${envelope.icon} ` : ''}{envelope.name}</span><span className="block text-[12px] text-mist">{envelope.mode === 'obligation' ? 'Обязательство' : envelope.cushion ? 'Финансовая подушка' : 'Цель'} · Приоритет {envelope.priority} · {envelope.state === 'active' ? 'Активно' : envelope.state === 'paused' ? 'На паузе' : 'Закрыто'}</span></span><Settings2 size={17} className="text-mist" /></button>
          <div className="flex flex-wrap justify-between gap-2 text-[14px]"><span className="num text-income">{fmt(saved)} / {fmt(target)}</span><span className="text-mist">{percent}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-income transition-[width] duration-300" style={{ width: `${percent}%` }} /></div>
          <p className="text-[13px] text-mist">Осталось {fmt(missing)}{nextDue ? ` · ${envelope.mode === 'obligation' ? 'Следующий платёж' : 'Желаемый срок'} ${nextDue}` : envelope.mode === 'obligation' ? ' · Обязательство оплачено' : ''}. {envelope.mode === 'goal' && missing > 0 ? 'Срок достижения пока не прогнозируем.' : ''}</p>
          {due.filter((p) => p.envelope.id === envelope.id).slice(0, 3).map((p) => <p key={p.period} className="text-[13px] text-amber">К оплате {p.period}: {fmt(p.missing)}</p>)}
          <button className="glass press flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-[14px]" onClick={() => setModal({ kind: 'move', record: envelope })}><Wallet size={17} /> Управлять резервом</button>
        </Card>
      })}
      {planning.filter((r) => r.kind === 'movement' && r.status !== 'confirmed').map((event) => <Card key={event.id} className="space-y-2 p-4 text-[14px]">
        <p className="font-medium text-amber">{event.status === 'pending' ? 'Ожидает подтверждения' : 'Нужна повторная проверка'} · {fmt(event.amount ?? 0)}</p>
        <p>{envelopes.find((r) => r.id === event.from)?.name ?? 'Свободные'} → {envelopes.find((r) => r.id === event.to)?.name ?? 'Свободные'}</p>
        {event.reason && <p className="text-[13px] text-mist">{event.reason}</p>}
        {event.status === 'rejected' && <button className="press min-h-11 text-iris" onClick={() => { if (window.confirm('Повторно отправить движение на проверку с текущими данными?')) void alter(event, { status: 'pending', reason: undefined }) }}>Подтвердить повторно</button>}
        <button className="press ml-3 min-h-11 text-mist" onClick={() => { void alter(event, { deletedAt: new Date().toISOString() }) }}>Отменить движение</button>
      </Card>)}
      <button className="glass press flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-[14px]" onClick={() => setModal({ kind: 'history' })}><History size={17} /> История баланса и резервов</button>
    </div>
    {modal && <PlanningModal modal={modal} onClose={() => setModal(null)} />}
  </>
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
