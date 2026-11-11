import { useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { toast } from '../lib/toast'
import { fmt } from '../lib/format'
import { parseMoney } from '../lib/invoicing'
import { adjustments, currentBalance, saveAdjustment } from '../lib/balance-adjust'
import { Card, PrimaryButton, Sheet } from './ui'
import { Field } from './invoices/Field'

const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : fmt(0))
const tone = (n: number | null) => (n == null || n === 0 ? 'text-mist' : n > 0 ? 'text-income' : 'text-expense')

/** «Корректировка фактического баланса»: sets the real balance as a new starting point; not income or expense. */
export function BalanceAdjustSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const operations = useStore((s) => s.operations)
  const planning = useStore((s) => s.planning)
  const balance = useMemo(() => currentBalance(operations, planning), [operations, planning])
  const history = useMemo(() => adjustments(operations, planning), [operations, planning])
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const actual = text.trim() ? parseMoney(text) : null
  const invalid = !!text.trim() && actual === null
  const diff = actual !== null && balance !== null ? actual - balance : null
  const canSave = actual !== null && !saving && (balance === null || diff !== 0)

  const save = async () => {
    if (!canSave || busy.current) return
    busy.current = true; setSaving(true)
    try {
      await saveAdjustment(actual!, reason)
      toast(`Баланс обновлён: ${fmt(actual!)}`)
      setText(''); setReason('')
    } catch (e) { toast((e as Error).message) } finally { busy.current = false; setSaving(false) }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Корректировка баланса" full>
      <div className="space-y-4 px-4 pt-3">
        <Card className="p-5">
          <p className="text-[14px] text-mist">Баланс в приложении</p>
          <p className="num mt-1 font-display text-[32px] font-semibold tracking-[-0.03em]">{balance === null ? '—' : fmt(balance)}</p>
          {balance === null && <p className="mt-1 text-[13px] text-mist">Баланс ещё не указан. Введите сумму, которая сейчас есть на счетах и в наличных.</p>}
        </Card>

        <Field label="Фактический баланс, €" value={text} onChange={setText} inputMode="decimal" placeholder={balance === null ? '0,00' : (balance / 100).toFixed(2).replace('.', ',')} error={invalid ? 'Введите сумму, например 1210 или 1 210,50' : null} maxLength={20} />

        <div className="glass flex items-center justify-between rounded-2xl px-4 py-3.5">
          <span className="text-[15px] text-mist">Разница</span>
          <span className={`num text-[18px] font-semibold ${tone(diff)}`}>{diff === null ? '—' : signed(diff)}</span>
        </div>

        <Field label="Причина корректировки" value={reason} onChange={setReason} placeholder="Необязательно, например «Комиссия банка»" maxLength={300} />

        <PrimaryButton disabled={!canSave} onClick={save}>Сохранить корректировку</PrimaryButton>
        <p className="px-1 text-[12px] text-fog">Корректировка не считается доходом или расходом и не попадает в статистику. Прошлые операции не меняются; новые доходы и расходы изменяют уже исправленный баланс.</p>

        <section className="pb-2">
          <p className="mb-2 px-1 text-[15px] font-medium text-mist">История корректировок</p>
          {history.length ? (
            <Card className="divide-y divide-line overflow-hidden">
              {history.map((h) => (
                <div key={h.id} className="px-4 py-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="num text-[15px]">{h.before === null ? '—' : fmt(h.before)} → <b className="font-semibold">{fmt(h.after)}</b></span>
                    <span className={`num text-[15px] font-semibold ${tone(h.diff)}`}>{h.diff === null ? 'начальный' : signed(h.diff)}</span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-mist">{new Date(h.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}{h.reason ? ` · ${h.reason}` : ''}</p>
                </div>
              ))}
            </Card>
          ) : <p className="px-1 text-[14px] text-fog">Корректировок пока не было.</p>}
        </section>
      </div>
    </Sheet>
  )
}
