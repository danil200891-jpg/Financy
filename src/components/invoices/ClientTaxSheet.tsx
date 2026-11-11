import { useEffect, useRef, useState } from 'react'
import { Camera, Image as ImageIcon, Keyboard, Loader2 } from 'lucide-react'
import { actions, findClientByName, getState, useStore, waitForWrites } from '../../lib/store'
import { recognize } from '../../lib/ocr'
import { recognizeClient, type ClientFields } from '../../lib/client-ocr'
import { TAX_ID_LABEL, taxIdKind, validEmail } from '../../lib/invoicing'
import { toast } from '../../lib/toast'
import { CLIENT_COLORS } from '../../screens/Clients'
import { PrimaryButton, Sheet } from '../ui'
import { Field } from './Field'

type Form = ClientFields & { name: string; country?: string }
const PLACEHOLDER: Partial<Record<keyof Form, string>> = { province: 'Barcelona, Navarra, Madrid…' }
type Key = keyof Form
const LABELS: [Key, string][] = [['legalName', 'Юридическое название'], ['taxId', 'NIF / NIE / CIF'], ['address', 'Адрес'], ['postalCode', 'Индекс'], ['city', 'Город'], ['province', 'Провинция / область'], ['country', 'Страна'], ['email', 'Email'], ['phone', 'Телефон']]

const fromClient = (id: string | null | undefined): Form => {
  const c = getState().clients.find((x) => x.id === id)
  return c ? { name: c.name, legalName: c.legalName ?? '', taxId: c.taxId ?? '', address: c.address ?? '', postalCode: c.postalCode ?? '', city: c.city ?? '', province: c.province ?? '', country: c.country ?? '', email: c.email ?? '', phone: c.phone ?? '' } : { name: '', country: 'España' }
}

/**
 * Client tax details for invoices: photo (camera), image from the gallery/Files, or manual entry.
 * Recognised values are only suggestions — the user reviews and confirms before anything is saved.
 */
export function ClientTaxSheet({ open, clientId, onClose, onSaved }: { open: boolean; clientId?: string | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const [stage, setStage] = useState<'choose' | 'reading' | 'review'>('choose')
  const [form, setForm] = useState<Form>(() => fromClient(clientId))
  const [flags, setFlags] = useState<Set<Key>>(new Set())
  const [lines, setLines] = useState<string[]>([])
  const [active, setActive] = useState<Key>('legalName')
  const [taxInvalid, setTaxInvalid] = useState(false)
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const clients = useStore((s) => s.clients)
  const existing = clientId ? clients.find((c) => c.id === clientId) : undefined

  useEffect(() => {
    if (!open) return
    setForm(fromClient(clientId)); setFlags(new Set()); setLines([]); setTaxInvalid(false)
    setStage(clientId && existing?.taxId ? 'review' : 'choose')
    return () => abort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientId])

  const set = (k: Key, v: string) => { setForm((f) => ({ ...f, [k]: v })); setFlags((s) => { const n = new Set(s); n.delete(k); return n }); if (k === 'taxId') setTaxInvalid(false) }

  const read = async (file: File) => {
    setStage('reading'); setProgress(0)
    const ctl = new AbortController(); abort.current = ctl
    const url = URL.createObjectURL(file)
    try {
      const { text } = await recognize(url, setProgress, ctl.signal)
      const r = recognizeClient(text)
      const found = new Set<Key>()
      setForm((f) => {
        const next = { ...f }
        for (const [k, v] of Object.entries(r.fields) as [Key, string][]) if (v) { next[k] = v; found.add(k) }
        if (!next.name && r.fields.legalName) { next.name = r.fields.legalName; found.add('name') }
        return next
      })
      setFlags(found); setLines(r.lines); setTaxInvalid(!!r.taxIdInvalid)
      if (!found.size) toast('Реквизиты не найдены. Заполните поля или нажмите на строку текста ниже.')
      setStage('review')
    } catch (e) {
      if (!ctl.signal.aborted) toast((e as Error).message || 'Не удалось распознать изображение.')
      setStage('choose')
    } finally { URL.revokeObjectURL(url) }
  }

  const kind = form.taxId?.trim() ? taxIdKind(form.taxId) : null
  const taxErr = form.taxId?.trim() && !kind ? 'Контрольный символ не совпадает — проверьте номер.' : null
  const emailErr = form.email?.trim() && !validEmail(form.email) ? 'Проверьте email.' : null
  const dupe = !clientId && form.name.trim() ? findClientByName(form.name) : undefined
  const canSave = !!form.name.trim() && !emailErr && !busy

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      const id = clientId ?? actions.addClient(form.name, CLIENT_COLORS[getState().clients.length % CLIENT_COLORS.length]).id
      const clean = (v?: string) => v?.trim() || undefined
      actions.updateClient(id, {
        ...(clientId ? { name: form.name.trim().replace(/\s+/g, ' ') } : {}),
        legalName: clean(form.legalName), taxId: clean(form.taxId)?.toUpperCase().replace(/[\s.-]/g, ''), address: clean(form.address), postalCode: clean(form.postalCode),
        city: clean(form.city), province: clean(form.province), country: clean(form.country), email: clean(form.email)?.toLowerCase(), phone: clean(form.phone),
      })
      await waitForWrites()
      toast('Реквизиты клиента сохранены')
      onSaved?.(id)
      onClose()
    } catch { /* write error already shown */ } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onClose={() => { abort.current?.abort(); onClose() }} title={existing ? `Реквизиты: ${existing.name}` : 'Данные клиента'} full>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f) }} />
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f) }} />

      {stage === 'choose' && (
        <div className="space-y-3 px-4 pt-3">
          <p className="px-1 text-[15px] text-mist">Как добавить реквизиты клиента?</p>
          {[
            { Icon: Camera, title: 'Сделать фотографию', text: 'Откроется камера iPhone', run: () => cameraRef.current?.click() },
            { Icon: ImageIcon, title: 'Загрузить фото или скриншот', text: 'Из галереи или «Файлов»', run: () => fileRef.current?.click() },
            { Icon: Keyboard, title: 'Заполнить вручную', text: 'Ввести реквизиты самостоятельно', run: () => setStage('review') },
          ].map(({ Icon, title, text, run }) => (
            <button key={title} onClick={run} className="press glass flex w-full items-center gap-4 rounded-[22px] p-4 text-left">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-iris/15 text-iris"><Icon size={22} /></span>
              <span><span className="block text-[16px] font-medium">{title}</span><span className="block text-[13px] text-mist">{text}</span></span>
            </button>
          ))}
          <p className="px-1 pt-1 text-[12px] text-fog">Текст распознаётся на устройстве, без интернета. Найденные данные нужно проверить — отсутствующие поля останутся пустыми.</p>
        </div>
      )}

      {stage === 'reading' && (
        <div className="flex flex-col items-center px-8 py-16 text-center">
          <Loader2 className="animate-spin text-iris" size={32} />
          <p className="mt-4 text-[16px]">Распознаю текст… {Math.round(progress * 100)}%</p>
          <button onClick={() => { abort.current?.abort(); setStage('choose') }} className="press mt-6 rounded-2xl bg-white/8 px-5 py-3 text-[15px]">Отмена</button>
        </div>
      )}

      {stage === 'review' && (
        <div className="space-y-3 px-5 pt-3">
          {!!flags.size && <p className="rounded-2xl bg-amber/10 px-4 py-3 text-[13px] text-amber">Проверьте отмеченные поля: они распознаны автоматически.</p>}
          <Field label="Имя клиента в Financy" value={form.name} onChange={(v) => set('name', v)} flag={flags.has('name')} placeholder="Как вы его называете" hint={dupe ? 'Клиент с таким именем уже есть — реквизиты добавятся к нему.' : 'Обязательно. Остальные поля нужны только для фактур.'} />
          {LABELS.map(([k, label]) => (
            <div key={k} onFocusCapture={() => setActive(k)}>
              <Field
                label={label} value={form[k] ?? ''} onChange={(v) => set(k, v)} flag={flags.has(k)}
                error={k === 'taxId' ? (taxErr || (taxInvalid ? 'Номер прочитан, но не проходит проверку.' : null)) : k === 'email' ? emailErr : null}
                hint={k === 'taxId' && kind ? `${TAX_ID_LABEL[kind]} — проверен` : undefined}
                inputMode={k === 'email' ? 'email' : k === 'phone' ? 'tel' : k === 'postalCode' ? 'numeric' : 'text'}
                maxLength={k === 'address' ? 600 : 300}
                placeholder={PLACEHOLDER[k]}
              />
            </div>
          ))}
          {!!lines.length && (
            <div className="pt-1">
              <p className="mb-2 px-1 text-[13px] text-mist">Распознанный текст — нажмите строку, чтобы вставить её в поле «{(LABELS.find(([k]) => k === active)?.[1]) ?? 'Имя клиента'}»</p>
              <div className="flex flex-wrap gap-1.5">
                {lines.map((l, i) => (
                  <button key={i} onClick={() => set(active, l)} className="press max-w-full truncate rounded-xl bg-white/8 px-3 py-2 text-left text-[13px]">{l}</button>
                ))}
              </div>
            </div>
          )}
          <div className="pt-2"><PrimaryButton disabled={!canSave} onClick={save}>Сохранить реквизиты</PrimaryButton></div>
          {stage === 'review' && (
            <button onClick={() => setStage('choose')} className="press h-12 w-full rounded-2xl text-[15px] text-mist">Распознать с фото</button>
          )}
        </div>
      )}
    </Sheet>
  )
}
