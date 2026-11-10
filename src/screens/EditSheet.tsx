import { useEffect, useRef, useState } from 'react'
import { History as HistoryIcon, Trash2 } from 'lucide-react'
import { actions, findDuplicate, useStore, waitForWrites } from '../lib/store'
import { historyFor } from '../lib/db'
import { toast } from '../lib/toast'
import { dayLabel, fmt, timeLabel, toDateInput } from '../lib/format'
import type { HistoryEntry, Operation } from '../lib/types'
import { Card, PrimaryButton, Sheet } from '../components/ui'
import { OperationForm, centsToText, emptyForm, incomeKindOf, toDraft, type FormValue } from '../components/OperationForm'

const SOURCE: Record<Operation['source'], string> = { manual: 'вручную', camera: 'с камеры', upload: 'из изображения', import: 'из резервной копии' }
const ACTION: Record<HistoryEntry['action'], string> = { create: 'Создана', update: 'Изменена', delete: 'Удалена', restore: 'Восстановлена' }

/** Human-readable list of what changed between two versions of an operation. */
function diff(before?: Partial<Operation>, after?: Partial<Operation>) {
  if (!before || !after) return []
  const out: string[] = []
  if (before.amount !== after.amount) out.push(`сумма ${fmt(before.amount ?? 0)} → ${fmt(after.amount ?? 0)}`)
  if (before.title !== after.title) out.push(`название «${before.title}» → «${after.title}»`)
  if (before.type !== after.type) out.push(after.type === 'income' ? 'стал доходом' : 'стал расходом')
  if (before.date?.slice(0, 10) !== after.date?.slice(0, 10)) out.push(`дата → ${dayLabel(after.date!).toLowerCase()}`)
  if (before.categoryId !== after.categoryId) out.push('категория')
  if (before.clientId !== after.clientId) out.push('клиент')
  if (before.incomeKind && after.incomeKind && before.incomeKind !== after.incomeKind) out.push('вид дохода')
  if ((before.note ?? '') !== (after.note ?? '')) out.push('заметка')
  return out
}

export function EditSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const op = useStore((s) => s.operations.find((o) => o.id === id))
  const [form, setForm] = useState<FormValue>(emptyForm)
  const [confirm, setConfirm] = useState(false)
  const [dupOk, setDupOk] = useState(false)
  const [log, setLog] = useState<HistoryEntry[]>([])
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const original = useRef('')

  useEffect(() => {
    setConfirm(false)
    setDupOk(false)
    setLog([])
    if (!op) return
    original.current = JSON.stringify(op)
    setForm({
      planningPayment: op.planningPayment,
      type: op.type, amountText: centsToText(op.amount), title: op.title, categoryId: op.categoryId,
      clientId: op.clientId, date: toDateInput(op.date), note: op.note ?? '', currency: op.currency,
      incomeKind: op.type === 'income' ? incomeKindOf(op) : undefined,
    })
    let cancelled = false
    historyFor(op.id).then((entries) => { if (!cancelled) setLog(entries) }).catch(() => {})
    return () => { cancelled = true }
    // only when another operation is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (!op) return null
  const draft = toDraft(form, op.source, op.date)
  const dup = draft ? findDuplicate(draft, op.id) : undefined

  const save = async () => {
    if (!draft || saving.current) return
    if (JSON.stringify(op) !== original.current) { toast('Операция изменилась в другой вкладке. Закройте и откройте её заново перед сохранением.'); return }
    if (dup && !dupOk) return setDupOk(true)
    saving.current = true
    setBusy(true)
    try {
      actions.updateOperation(op.id, draft)
      await waitForWrites()
      onClose()
    } catch { /* The store reports the error and keeps the draft open. */ }
    finally { saving.current = false; setBusy(false) }
  }

  return (
    <Sheet open={!!id} onClose={() => { if (!saving.current) onClose() }} title="Операция" full>
      <div className="px-5 pt-4">
        <OperationForm value={form} onChange={(v) => { setForm(v); setDupOk(false) }} ignoreId={op.id} />
        <PrimaryButton className="mt-6" disabled={!draft || busy} onClick={save}>
          {dup && dupOk ? 'Да, сохранить с дубликатом' : 'Сохранить изменения'}
        </PrimaryButton>
        {confirm ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => setConfirm(false)} className="press h-14 rounded-[18px] bg-white/8 font-medium">Отмена</button>
            <button disabled={busy} onClick={async () => {
              if (saving.current) return
              saving.current = true; setBusy(true)
              try { actions.removeOperation(op.id); await waitForWrites(); onClose() }
              catch { /* Keep the restored operation available on failure. */ }
              finally { saving.current = false; setBusy(false) }
            }} className="press h-14 rounded-[18px] bg-expense font-semibold text-white">Удалить</button>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)} className="press mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-[18px] text-[16px] font-medium text-expense">
            <Trash2 size={18} /> Удалить операцию
          </button>
        )}

        <p className="mt-6 mb-2 flex items-center gap-1.5 px-1 text-[14px] text-mist">
          <HistoryIcon size={15} /> История изменений
        </p>
        <Card className="divide-y divide-line overflow-hidden">
          {log.length === 0 && <p className="px-4 py-3 text-[14px] text-mist">Добавлена {SOURCE[op.source]}, {dayLabel(op.createdAt).toLowerCase()}</p>}
          {log.map((h) => {
            const changes = h.action === 'update' ? diff(h.before as Operation, h.after as Operation) : []
            return (
              <div key={h.id} className="px-4 py-3">
                <div className="flex justify-between text-[14px]">
                  <span className="font-medium">{h.action === 'create' ? `Добавлена ${SOURCE[op.source]}` : ACTION[h.action]}</span>
                  <span className="text-mist">{dayLabel(h.at)}, {timeLabel(h.at)}</span>
                </div>
                {changes.length > 0 && <p className="mt-0.5 text-[13px] text-mist">{changes.join(', ')}</p>}
              </div>
            )
          })}
        </Card>
      </div>
    </Sheet>
  )
}
