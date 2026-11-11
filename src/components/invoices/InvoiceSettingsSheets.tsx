import { useMemo, useRef, useState } from 'react'
import { Check, ImagePlus, Plus, Star, Trash2, X } from 'lucide-react'
import { useStore } from '../../lib/store'
import { toast } from '../../lib/toast'
import type { InvoiceSeries, IssuerProfile } from '../../lib/invoice-types'
import { createSeries, invoicesOf, issuersOf, removeIssuer, renameSeries, saveIssuer, saveSettings, seriesOf, seriesOwnedHere, setSeriesStart, settingsOf, takeOverSeries } from '../../lib/invoice-actions'
import { TAX_ID_LABEL, formatCode, lastIssued, formatIban, parseRate, rateLabel, taxIdKind, validEmail, validIban } from '../../lib/invoicing'
import { logoDataUrl } from '../../lib/image'
import { plural } from '../../lib/format'
import { Card, PrimaryButton, Sheet } from '../ui'
import { Field } from './Field'

/* ---------------- Мои реквизиты ---------------- */

type IssuerDraft = Omit<IssuerProfile, 'id' | 'kind' | 'createdAt' | 'updatedAt'> & { id?: string }
const emptyIssuer = (): IssuerDraft => ({ label: '', name: '', taxId: '', address: '', postalCode: '', city: '', country: 'España', email: '', phone: '', iban: '', logo: null })

export function IssuerEditor({ initial, onDone }: { initial: IssuerDraft; onDone: () => void }) {
  const [d, setD] = useState<IssuerDraft>(initial)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<IssuerDraft>) => setD((x) => ({ ...x, ...patch }))
  const kind = d.taxId.trim() ? taxIdKind(d.taxId) : null
  const taxErr = d.taxId.trim() && !kind ? 'Контрольный символ не совпадает. Проверьте номер.' : null
  const ibanErr = d.iban?.trim() && !validIban(d.iban) ? 'IBAN не проходит проверку.' : null
  const emailErr = d.email?.trim() && !validEmail(d.email) ? 'Проверьте email.' : null
  const ready = d.name.trim() && d.taxId.trim() && d.address.trim() && !taxErr && !ibanErr && !emailErr
  const save = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      saveIssuer({ ...d, label: d.label.trim() || d.name.trim(), taxId: d.taxId.trim().toUpperCase(), iban: d.iban ? formatIban(d.iban) : '' })
      toast('Реквизиты сохранены')
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3 px-5 pt-3">
      <div className="flex items-center gap-4">
        <button onClick={() => fileRef.current?.click()} className="press glass grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl" aria-label="Логотип">
          {d.logo ? <img src={d.logo} alt="" className="h-full w-full object-contain p-1.5" /> : <ImagePlus className="text-mist" />}
        </button>
        <div className="min-w-0 flex-1 text-[13px] text-mist">
          <p className="text-[15px] text-ink">Логотип</p>
          <p>Необязательно. Появится в PDF.</p>
          {d.logo && <button onClick={() => set({ logo: null })} className="press mt-1 text-expense">Убрать</button>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { set({ logo: await logoDataUrl(f) }) } catch (err) { toast((err as Error).message) }
        }} />
      </div>
      <Field label="Название профиля" value={d.label} onChange={(v) => set({ label: v })} placeholder="Например, «Autónomo»" maxLength={120} />
      <Field label="Имя или название компании" value={d.name} onChange={(v) => set({ name: v })} placeholder="Как в налоговой" />
      <Field label="NIF / NIE / CIF" value={d.taxId} onChange={(v) => set({ taxId: v })} placeholder="12345678Z" error={taxErr} hint={kind ? `${TAX_ID_LABEL[kind]} — проверен` : undefined} maxLength={40} />
      <Field label="Юридический адрес" value={d.address} onChange={(v) => set({ address: v })} placeholder="Calle, número, piso" maxLength={600} />
      <div className="grid grid-cols-[2fr_3fr] gap-2">
        <Field label="Индекс" value={d.postalCode ?? ''} onChange={(v) => set({ postalCode: v })} inputMode="numeric" maxLength={20} />
        <Field label="Город" value={d.city ?? ''} onChange={(v) => set({ city: v })} maxLength={120} />
      </div>
      <Field label="Страна" value={d.country ?? ''} onChange={(v) => set({ country: v })} maxLength={80} />
      <Field label="Email" value={d.email ?? ''} onChange={(v) => set({ email: v })} inputMode="email" type="email" error={emailErr} maxLength={200} />
      <Field label="Телефон" value={d.phone ?? ''} onChange={(v) => set({ phone: v })} inputMode="tel" type="tel" maxLength={60} />
      <Field label="IBAN" value={d.iban ?? ''} onChange={(v) => set({ iban: v })} placeholder="ES00 0000 0000 0000 0000 0000" error={ibanErr} maxLength={40} />
      <div className="pt-2">
        <PrimaryButton disabled={!ready || busy} onClick={save}>Сохранить реквизиты</PrimaryButton>
      </div>
      <p className="px-1 pb-2 text-[12px] text-fog">Уже выставленные фактуры не меняются: в них сохранены реквизиты на момент выставления.</p>
    </div>
  )
}

export function IssuersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invoicing = useStore((s) => s.invoicing)
  const list = useMemo(() => issuersOf(invoicing), [invoicing])
  const [edit, setEdit] = useState<IssuerDraft | null>(null)
  const close = () => { setEdit(null); onClose() }
  return (
    <Sheet open={open} onClose={close} title={edit ? (edit.id ? 'Реквизиты' : 'Новый профиль') : 'Мои реквизиты'} full>
      {edit ? <IssuerEditor key={edit.id ?? 'new'} initial={edit} onDone={() => setEdit(null)} /> : (
        <div className="space-y-3 px-4 pt-3">
          {!list.length && <p className="px-1 text-[15px] text-mist">Заполните реквизиты один раз — они будут подставляться в каждую фактуру. Можно завести несколько профилей.</p>}
          {!!list.length && (
            <Card className="divide-y divide-line overflow-hidden">
              {list.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-3.5">
                  <button onClick={() => setEdit({ ...i })} className="press min-w-0 flex-1 text-left">
                    <p className="truncate text-[16px] font-medium">{i.label || i.name}</p>
                    <p className="truncate text-[13px] text-mist">{i.name} · {i.taxId}</p>
                  </button>
                  <button aria-label="Профиль по умолчанию" onClick={() => saveIssuer({ ...i, isDefault: true })} className={`press p-2 ${i.isDefault ? 'text-amber' : 'text-fog'}`}><Star size={18} fill={i.isDefault ? 'currentColor' : 'none'} /></button>
                  <button aria-label="Удалить профиль" onClick={() => { if (window.confirm(`Удалить профиль «${i.label || i.name}»? Выставленные фактуры сохранят свои реквизиты.`)) removeIssuer(i.id) }} className="press p-2 text-fog"><Trash2 size={18} /></button>
                </div>
              ))}
            </Card>
          )}
          <button onClick={() => setEdit(emptyIssuer())} className="press glass flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[16px] font-medium text-iris">
            <Plus size={18} /> {list.length ? 'Добавить профиль' : 'Заполнить реквизиты'}
          </button>
        </div>
      )}
    </Sheet>
  )
}

/* ---------------- Нумерация и налоги ---------------- */

function SeriesRow({ s }: { s: InvoiceSeries }) {
  const used = useStore((st) => lastIssued(invoicesOf(st.all.invoicing), s.id))
  const [example, setExample] = useState(formatCode(s, s.next))
  const [editing, setEditing] = useState(false)
  const own = seriesOwnedHere(s)
  const apply = () => {
    try { setSeriesStart(s.id, example); setEditing(false); toast('Следующий номер сохранён') } catch (e) { toast((e as Error).message) }
  }
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-medium">{s.name}{s.rectifying ? ' · исправленные' : ''}</p>
          <p className="text-[13px] text-mist">Следующий номер: <span className="num text-ink">{formatCode(s, Math.max(s.next, used + 1))}</span>{used ? ` · выставлено до ${formatCode(s, used)}` : ''}</p>
          {!own && <p className="text-[12px] text-amber">Номера этой серии выдаёт другое устройство</p>}
        </div>
        {!s.rectifying && (
          <button aria-label="Серия по умолчанию" onClick={() => renameSeries(s.id, s.name, true)} className={`press p-2 ${s.isDefault ? 'text-amber' : 'text-fog'}`}><Star size={18} fill={s.isDefault ? 'currentColor' : 'none'} /></button>
        )}
      </div>
      {!used && !editing && <button onClick={() => setEditing(true)} className="press mt-2 text-[14px] text-iris">Изменить следующий номер</button>}
      {editing && (
        <div className="mt-2 flex gap-2">
          <input value={example} onChange={(e) => setExample(e.target.value)} className="glass num h-12 min-w-0 flex-1 rounded-2xl px-4 outline-none" aria-label="Следующий номер" />
          <button onClick={apply} aria-label="Сохранить" className="press glass grid h-12 w-12 place-items-center rounded-2xl text-income"><Check size={20} /></button>
          <button onClick={() => { setEditing(false); setExample(formatCode(s, s.next)) }} aria-label="Отмена" className="press glass grid h-12 w-12 place-items-center rounded-2xl text-mist"><X size={20} /></button>
        </div>
      )}
      {!!used && <p className="mt-1 text-[12px] text-fog">После первой фактуры нумерация продолжается автоматически и не меняется. Для другой нумерации создайте новую серию.</p>}
      {!own && (
        <button onClick={() => { if (window.confirm('Выдавать номера этой серии на этом устройстве? Делайте это, только если на другом устройстве в серии нет невыгруженных фактур — иначе номер может повториться.')) takeOverSeries(s.id) }} className="press mt-2 text-[14px] text-iris">
          Выдавать номера на этом устройстве
        </button>
      )}
    </div>
  )
}

export function InvoicingSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invoicing = useStore((s) => s.invoicing)
  const series = seriesOf(invoicing)
  const st = settingsOf(invoicing)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [example, setExample] = useState('F-0001')
  const [vat, setVat] = useState(String(st.vatRate / 100).replace('.', ','))
  const add = () => {
    try { createSeries(name, example); setAdding(false); setName(''); toast('Серия создана') } catch (e) { toast((e as Error).message) }
  }
  const saveRates = () => {
    const v = parseRate(vat)
    if (v === null) { toast('Проверьте ставку IVA.'); return }
    saveSettings({ vatRate: v })
    toast('Сохранено')
  }
  return (
    <Sheet open={open} onClose={onClose} title="Нумерация и налоги" full>
      <div className="space-y-6 px-4 pt-3">
        <section>
          <p className="mb-2 px-1 text-[15px] font-medium text-mist">Серии номеров</p>
          {!series.length && !adding && (
            <p className="mb-3 px-1 text-[14px] text-mist">Укажите номер, с которого продолжить. Если последняя выставленная фактура была F-0025, введите F-0026.</p>
          )}
          {!!series.length && <Card className="divide-y divide-line overflow-hidden">{series.map((s) => <SeriesRow key={s.id} s={s} />)}</Card>}
          {adding ? (
            <div className="mt-3 space-y-3">
              <Field label="Название серии" value={name} onChange={setName} placeholder="Фактуры" maxLength={80} />
              <Field label="Номер следующей фактуры" value={example} onChange={setExample} placeholder="F-0026" hint={(() => { const p = /^(.*?)(\d+)$/.exec(example.trim()); return p ? `Префикс «${p[1]}», ${p[2].length} ${plural(p[2].length, 'цифра', 'цифры', 'цифр')}; после неё — ${p[1]}${String(Number(p[2]) + 1).padStart(p[2].length, '0')}` : 'В конце номера нужны цифры' })()} maxLength={30} />
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setAdding(false)} className="press h-12 rounded-2xl bg-white/8 font-medium">Отмена</button>
                <button onClick={add} className="press h-12 rounded-2xl bg-iris/80 font-semibold text-white">Создать</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="press glass mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[16px] font-medium text-iris"><Plus size={18} /> Новая серия</button>
          )}
        </section>
        <section className="space-y-3">
          <p className="px-1 text-[15px] font-medium text-mist">Налоги по умолчанию</p>
          <Field label="IVA по умолчанию, %" value={vat} onChange={setVat} inputMode="decimal" maxLength={6} hint={parseRate(vat) !== null ? rateLabel(parseRate(vat)!) : undefined} />
          <PrimaryButton onClick={saveRates}>Сохранить</PrimaryButton>
          <p className="px-1 pb-2 text-[12px] text-fog">IVA подставляется в новые фактуры. IRPF в каждой новой фактуре равен 0 % — при необходимости укажите удержание в самой фактуре. Уточняйте ставки у своего gestor.</p>
        </section>
      </div>
    </Sheet>
  )
}
