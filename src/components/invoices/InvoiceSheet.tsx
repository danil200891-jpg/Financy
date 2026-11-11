import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Ban, Check, ChevronRight, Copy, FilePlus2, FileText, Plus, Search, Share2, Trash2, Undo2, UserPlus, Wallet, X } from 'lucide-react'
import { getState, uid, useStore } from '../../lib/store'
import { toast } from '../../lib/toast'
import { deliver } from '../../lib/backup'
import { fmt } from '../../lib/format'
import type { Invoice, InvoiceLine, IssuerProfile } from '../../lib/invoice-types'
import {
  clientSnapshot, defaultIssuer, defaultSeries, deleteDraft, invoicesOf, issueInvoice, issueProblems, issuerSnapshot, issuersOf, linkableOperations,
  markPaid, markUnpaid, newDraft, newLine, rectifyingDraft, saveDraft, seriesOf, seriesOwnedHere, voidInvoice,
} from '../../lib/invoice-actions'
import { STATUS_COLOR, STATUS_LABEL, computeTotals, displayStatus, formatCode, formatIban, lastIssued, lineAmount, localDay, moneyInput, parseMoney, parseQuantity, parseRate, quantityLabel, rateLabel, taxIdKind, validIban } from '../../lib/invoicing'
import { Avatar, Card, PrimaryButton, Sheet } from '../ui'
import { Field } from './Field'
import { ClientTaxSheet } from './ClientTaxSheet'
import { InvoicingSettingsSheet, IssuersSheet } from './InvoiceSettingsSheets'

const day = (d?: string | null) => (d ? d.split('-').reverse().join('.') : '—')

export async function sharePdf(inv: Invoice) {
  const { invoicePdf, pdfFileName } = await import('../../lib/invoice-pdf')
  const all = getState().invoicing
  const issuerRec = all.find((r) => r.id === inv.issuerId) as IssuerProfile | undefined
  const client = getState().all.clients.find((c) => c.id === inv.clientId)
  const issuer = inv.issuer ?? (issuerRec ? issuerSnapshot(issuerRec, inv.iban) : null)
  const party = inv.client ?? (client ? clientSnapshot(client) : null)
  if (!issuer || !party) throw new Error('Не хватает реквизитов для PDF.')
  const rect = inv.rectifiesId ? (invoicesOf(getState().all.invoicing).find((i) => i.id === inv.rectifiesId)?.code ?? null) : null
  const bytes = await invoicePdf({ invoice: inv, issuer, client: party, rectifiesCode: rect })
  const copy = new Uint8Array(bytes.length); copy.set(bytes)
  return deliver(new Blob([copy.buffer], { type: 'application/pdf' }), pdfFileName(inv))
}

/* ---------------- client picker ---------------- */

function ClientPicker({ open, onClose, onPick, onNew }: { open: boolean; onClose: () => void; onPick: (id: string) => void; onNew: () => void }) {
  const clients = useStore((s) => s.clients)
  const [q, setQ] = useState('')
  const list = clients.filter((c) => !q.trim() || `${c.name} ${c.legalName ?? ''} ${c.taxId ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Sheet open={open} onClose={onClose} title="Клиент" full>
      <div className="space-y-3 px-4 pt-3">
        <label className="glass flex h-12 items-center gap-2 rounded-2xl px-4">
          <Search size={18} className="text-fog" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fog" />
        </label>
        <button onClick={onNew} className="press glass flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left text-iris"><UserPlus size={20} /> Новый клиент с реквизитами</button>
        {!!list.length && (
          <Card className="divide-y divide-line overflow-hidden">
            {list.map((c) => (
              <button key={c.id} onClick={() => onPick(c.id)} className="press flex w-full items-center gap-3 px-4 py-3 text-left">
                <Avatar client={c} size={38} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px]">{c.name}</span>
                  <span className={`block truncate text-[12px] ${c.taxId ? 'text-mist' : 'text-fog'}`}>{c.taxId ? `${c.legalName || c.name} · ${c.taxId}` : 'без налоговых реквизитов'}</span>
                </span>
              </button>
            ))}
          </Card>
        )}
      </div>
    </Sheet>
  )
}

/* ---------------- line editor ---------------- */

function LineRow({ line, onChange, onRemove, canRemove }: { line: InvoiceLine; onChange: (l: InvoiceLine) => void; onRemove: () => void; canRemove: boolean }) {
  const [qty, setQty] = useState(quantityLabel(line.quantity))
  const [price, setPrice] = useState(line.unitPrice ? moneyInput(line.unitPrice) : '')
  const qErr = qty.trim() && parseQuantity(qty) === null
  const pErr = price.trim() && parseMoney(price) === null
  return (
    <div className="glass space-y-2 rounded-[22px] p-3">
      <div className="flex gap-2">
        <textarea value={line.description} rows={2} maxLength={1000} onChange={(e) => onChange({ ...line, description: e.target.value })} placeholder="Описание услуги" className="min-h-14 min-w-0 flex-1 resize-none rounded-xl bg-white/5 px-3 py-2.5 text-[16px] outline-none placeholder:text-fog" />
        {canRemove && <button aria-label="Удалить строку" onClick={onRemove} className="press grid h-10 w-10 shrink-0 place-items-center rounded-xl text-fog"><Trash2 size={18} /></button>}
      </div>
      <div className="grid grid-cols-[1fr_1.4fr_1.4fr] items-end gap-2">
        <label className="block"><span className="px-1 text-[12px] text-mist">Кол-во</span>
          <input value={qty} inputMode="decimal" onChange={(e) => { setQty(e.target.value); const v = parseQuantity(e.target.value); if (v !== null) onChange({ ...line, quantity: v }) }} className={`num h-11 w-full rounded-xl bg-white/5 px-3 text-[16px] outline-none ${qErr ? 'ring-1 ring-expense/70' : ''}`} />
        </label>
        <label className="block"><span className="px-1 text-[12px] text-mist">Цена, €</span>
          <input value={price} inputMode="decimal" placeholder="0,00" onChange={(e) => { setPrice(e.target.value); const v = parseMoney(e.target.value); onChange({ ...line, unitPrice: v ?? 0 }) }} className={`num h-11 w-full rounded-xl bg-white/5 px-3 text-[16px] outline-none placeholder:text-fog ${pErr ? 'ring-1 ring-expense/70' : ''}`} />
        </label>
        <p className="num h-11 truncate pt-3 text-right text-[16px] font-semibold">{fmt(lineAmount(line))}</p>
      </div>
    </div>
  )
}

/* ---------------- HTML preview (document look) ---------------- */

function Preview({ inv, code }: { inv: Invoice; code: string }) {
  const issuerRec = useStore((s) => s.invoicing.find((r) => r.id === inv.issuerId)) as IssuerProfile | undefined
  const client = useStore((s) => s.all.clients.find((c) => c.id === inv.clientId))
  const issuer = inv.issuer ?? (issuerRec ? issuerSnapshot(issuerRec, inv.iban) : null)
  const party = inv.client ?? (client ? clientSnapshot(client) : null)
  const t = inv.totals ?? computeTotals(inv.lines, inv.vatRate, inv.irpfRate)
  const block = (label: string, p: typeof party) => (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold tracking-wide text-slate-400">{label}</p>
      {p ? <>
        <p className="mt-1 break-words text-[13px] font-semibold">{p.name}</p>
        {p.taxId && <p>NIF: {p.taxId}</p>}
        <p className="break-words">{p.address}</p>
        <p>{[p.postalCode, p.city].filter(Boolean).join(' ')}</p>
        {p.email && <p className="break-all">{p.email}</p>}
      </> : <p className="mt-1 text-red-500">нет данных</p>}
    </div>
  )
  return (
    <div className="rounded-[18px] bg-white p-4 text-[11px] leading-snug text-slate-800 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
      <div className="flex items-start justify-between gap-3">
        {issuer?.logo ? <img src={issuer.logo} alt="" className="max-h-12 max-w-[120px] object-contain" /> : <span />}
        <div className="text-right">
          <p className="text-[15px] font-bold text-indigo-600">{inv.rectifiesId ? 'FACTURA RECTIFICATIVA' : 'FACTURA'}</p>
          <p>Nº <b>{code}</b></p>
          <p>Fecha: <b>{day(inv.issueDate)}</b></p>
          {inv.dueDate && <p>Vencimiento: <b>{day(inv.dueDate)}</b></p>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">{block('EMISOR', issuer)}{block('CLIENTE', party)}</div>
      <div className="mt-4 rounded-lg bg-slate-100 px-2 py-1.5 font-semibold text-slate-500 grid grid-cols-[1fr_auto_auto] gap-2"><span>Descripción</span><span>Cant.</span><span className="w-16 text-right">Importe</span></div>
      {inv.lines.map((l) => (
        <div key={l.id} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-slate-200 px-2 py-1.5">
          <span className="break-words">{l.description || '—'}<span className="block text-slate-400">{fmt(l.unitPrice)}</span></span>
          <span>{quantityLabel(l.quantity)}</span>
          <span className="w-16 text-right font-semibold">{fmt(lineAmount(l))}</span>
        </div>
      ))}
      <div className="mt-3 ml-auto w-48 space-y-0.5">
        <p className="flex justify-between"><span>Base imponible</span><span>{fmt(t.base)}</span></p>
        <p className="flex justify-between"><span>IVA {rateLabel(inv.vatRate)}</span><span>{fmt(t.vat)}</span></p>
        {!!inv.irpfRate && <p className="flex justify-between"><span>IRPF {rateLabel(inv.irpfRate)}</span><span>−{fmt(t.irpf)}</span></p>}
        <p className="mt-1 flex justify-between border-t border-slate-800 pt-1 text-[13px] font-bold"><span>TOTAL</span><span>{fmt(t.total)}</span></p>
      </div>
      {inv.vatNote?.trim() && <p className="mt-3"><b>Mención IVA:</b> {inv.vatNote}</p>}
      {(inv.iban || issuer?.iban) && <p className="mt-2"><b>Forma de pago:</b> transferencia a {formatIban(inv.iban || issuer?.iban || '')}</p>}
      {inv.notes?.trim() && <p className="mt-2 whitespace-pre-wrap break-words"><b>Observaciones:</b> {inv.notes}</p>}
    </div>
  )
}

/* ---------------- mark paid ---------------- */

function PaySheet({ inv, open, onClose }: { inv: Invoice; open: boolean; onClose: () => void }) {
  const allOps = useStore((s) => s.operations)
  const allCats = useStore((s) => s.categories)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ops = useMemo(() => linkableOperations(inv), [allOps, inv])
  const cats = useMemo(() => allCats.filter((c) => c.type === 'income' && !c.archived), [allCats])
  const [date, setDate] = useState(localDay())
  const [cat, setCat] = useState(cats.find((c) => c.id === 'c-work')?.id ?? cats[0]?.id ?? null)
  const [busy, setBusy] = useState(false)
  const run = async (link: Parameters<typeof markPaid>[1]) => {
    if (busy) return
    setBusy(true)
    try { await markPaid(inv.id, link); toast('Фактура отмечена оплаченной'); onClose() } catch (e) { toast((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Отметить оплаченной">
      <div className="space-y-4 px-4 pt-3">
        <p className="px-1 text-[14px] text-mist">Доход учитывается один раз. Если оплата уже добавлена как доход — выберите её. Иначе создайте новую операцию на {fmt(inv.totals?.total ?? 0)}.</p>
        {!!ops.length && (
          <Card className="divide-y divide-line overflow-hidden">
            {ops.slice(0, 20).map((o) => (
              <button key={o.id} disabled={busy} onClick={() => run({ operationId: o.id })} className="press flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="min-w-0 flex-1"><span className="block truncate text-[15px]">{o.title}</span><span className="block text-[12px] text-mist">{new Date(o.date).toLocaleDateString('ru-RU')}</span></span>
                <span className={`num text-[15px] font-semibold ${o.amount === inv.totals?.total ? 'text-income' : ''}`}>{fmt(o.amount)}</span>
              </button>
            ))}
          </Card>
        )}
        <div className="space-y-2">
          <p className="px-1 text-[15px] font-medium text-mist">Новая операция дохода</p>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="glass h-12 w-full rounded-2xl px-4 outline-none" aria-label="Дата оплаты" />
          <div className="flex flex-wrap gap-1.5">
            {cats.map((c) => <button key={c.id} onClick={() => setCat(c.id)} className={`press rounded-xl px-3 py-2 text-[14px] ${cat === c.id ? 'bg-iris/30 text-ink' : 'bg-white/8 text-mist'}`}>{c.name}</button>)}
          </div>
          <PrimaryButton disabled={busy || !date} onClick={() => run({ create: { date: new Date(`${date}T12:00:00`).toISOString(), categoryId: cat } })}>Создать доход {fmt(inv.totals?.total ?? 0)}</PrimaryButton>
        </div>
      </div>
    </Sheet>
  )
}

/* ---------------- main sheet ---------------- */

export function InvoiceSheet({ open, invoiceId, clientId, onClose, onOpen }: { open: boolean; invoiceId?: string | null; clientId?: string | null; onClose: () => void; onOpen?: (id: string) => void }) {
  const stored = useStore((s) => (invoiceId ? (s.invoicing.find((r) => r.id === invoiceId) as Invoice | undefined) : undefined))
  const invoicing = useStore((s) => s.invoicing)
  const clients = useStore((s) => s.clients)
  const [draft, setDraft] = useState<Invoice | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [rates, setRates] = useState({ vat: '', irpf: '' })
  const [picker, setPicker] = useState(false)
  const [taxFor, setTaxFor] = useState<string | null | undefined>(undefined)
  const [issuersOpen, setIssuersOpen] = useState(false)
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [pay, setPay] = useState(false)
  const [confirmIssue, setConfirmIssue] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const base = stored && stored.status === 'draft' ? stored : !invoiceId ? newDraft({ clientId }) : null
    setDraft(base ? { ...base, lines: base.lines.length ? base.lines : [newLine()] } : null)
    if (base) setRates({ vat: String(base.vatRate / 100).replace('.', ','), irpf: String(base.irpfRate / 100).replace('.', ',') })
    setMode('edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId])

  // fill issuer / series once they are created from inside the editor
  useEffect(() => {
    if (!draft) return
    const patch: Partial<Invoice> = {}
    if (!draft.issuerId) { const i = defaultIssuer(invoicing); if (i) { patch.issuerId = i.id; if (!draft.iban) patch.iban = i.iban ?? '' } }
    if (!draft.seriesId) { const s = defaultSeries(invoicing); if (s) patch.seriesId = s.id }
    if (Object.keys(patch).length) setDraft({ ...draft, ...patch })
  }, [invoicing, draft])

  const issuedView = stored && stored.status !== 'draft' ? stored : null
  const inv = issuedView ?? draft
  const series = seriesOf(invoicing)
  const usable = series.filter((s) => (draft?.rectifiesId ? s.rectifying : !s.rectifying))
  const curSeries = series.find((s) => s.id === inv?.seriesId)
  const nextCode = curSeries ? formatCode(curSeries, Math.max(curSeries.next, lastIssued(invoicesOf(getState().all.invoicing), curSeries.id) + 1)) : '—'
  const client = clients.find((c) => c.id === inv?.clientId)
  const issuers = issuersOf(invoicing)
  const totals = useMemo(() => inv ? (inv.totals ?? computeTotals(inv.lines, inv.vatRate, inv.irpfRate)) : null, [inv])
  const problems = draft ? issueProblems(draft) : []
  if (!open) return null
  const set = (patch: Partial<Invoice>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const persist = async () => { if (draft) await saveDraft(draft) }
  const close = async () => {
    if (draft && !issuedView && (stored || draft.lines.some((l) => l.description.trim() || l.unitPrice) || draft.clientId)) {
      try { await persist(); toast('Черновик сохранён') } catch { /* toast shown */ }
    }
    onClose()
  }

  const doIssue = async () => {
    if (!draft || busy) return
    setBusy(true)
    try {
      await persist()
      const done = await issueInvoice(draft.id)
      setConfirmIssue(false)
      toast(`Фактура ${done.code} выставлена`)
      onOpen?.(done.id)
      try { await sharePdf(done) } catch (e) { toast((e as Error).message) }
    } catch (e) { toast((e as Error).message) } finally { setBusy(false) }
  }

  /* ----- issued / paid / void: read-only view with actions ----- */
  if (issuedView) {
    const ds = displayStatus(issuedView)
    const op = getState().all.operations.find((o) => o.id === issuedView.paymentOperationId)
    const rectifies = issuedView.rectifiesId ? invoicesOf(invoicing).find((i) => i.id === issuedView.rectifiesId) : undefined
    const rectifiedBy = invoicesOf(invoicing).filter((i) => i.rectifiesId === issuedView.id)
    const action = (Icon: typeof Share2, label: string, run: () => void | Promise<void>, danger = false) => (
      <button key={label} disabled={busy} onClick={async () => { setBusy(true); try { await run() } catch (e) { toast((e as Error).message) } finally { setBusy(false) } }} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
        <Icon size={20} className={danger ? 'text-expense' : 'text-iris'} /><span className={`flex-1 text-[16px] ${danger ? 'text-expense' : ''}`}>{label}</span><ChevronRight size={18} className="text-fog" />
      </button>
    )
    return (
      <Sheet open onClose={onClose} title={`Фактура ${issuedView.code}`} full>
        <div className="space-y-4 px-4 pt-3">
          <Card className="p-5">
            <div className="flex items-center justify-between gap-3">
              <span className={`text-[14px] font-semibold ${STATUS_COLOR[ds]}`}>{STATUS_LABEL[ds]}</span>
              <span className="text-[13px] text-mist">от {day(issuedView.issueDate)}{issuedView.dueDate ? ` · до ${day(issuedView.dueDate)}` : ''}</span>
            </div>
            <p className="num mt-2 font-display text-[32px] font-semibold tracking-[-0.03em]">{fmt(totals?.total ?? 0)}</p>
            <p className="truncate text-[14px] text-mist">{issuedView.client?.name}</p>
            {ds === 'paid' && <p className="mt-2 text-[13px] text-income">Оплата: {op ? `${op.title}, ${new Date(op.date).toLocaleDateString('ru-RU')}` : 'операция удалена'}</p>}
            {ds === 'void' && <p className="mt-2 text-[13px] text-fog">Аннулирована{issuedView.voidReason ? `: ${issuedView.voidReason}` : ''}. Номер не используется повторно.</p>}
            {rectifies && <p className="mt-2 text-[13px] text-mist">Исправляет фактуру {rectifies.code}</p>}
            {!!rectifiedBy.length && <p className="mt-2 text-[13px] text-mist">Исправлена: {rectifiedBy.map((r) => r.code ?? 'черновик').join(', ')}</p>}
          </Card>
          <Card className="divide-y divide-line overflow-hidden">
            {action(Share2, 'Поделиться PDF', async () => { await sharePdf(issuedView) })}
            {issuedView.status === 'issued' && (totals?.total ?? 0) > 0 && action(Wallet, 'Отметить оплаченной', () => setPay(true))}
            {issuedView.status === 'paid' && action(Undo2, 'Снять отметку об оплате', async () => { await markUnpaid(issuedView.id); toast('Отметка снята. Операция дохода осталась в истории.') })}
            {issuedView.status !== 'void' && !issuedView.rectifiesId && action(FilePlus2, 'Создать исправленную фактуру', () => { const d = rectifyingDraft(issuedView.id); void saveDraft(d).then(() => onOpen?.(d.id)) })}
            {action(Copy, 'Новая фактура на основе этой', () => {
              const d = newDraft({ clientId: issuedView.clientId, issuerId: issuedView.issuerId })
              void saveDraft({ ...d, lines: issuedView.lines.filter((l) => l.quantity > 0).map((l) => ({ ...l, id: uid('ln') })), vatRate: issuedView.vatRate, irpfRate: issuedView.irpfRate, vatNote: issuedView.vatNote, notes: '' }).then(() => onOpen?.(d.id))
            })}
            {issuedView.status === 'issued' && action(Ban, 'Аннулировать', async () => {
              const reason = window.prompt(`Аннулировать фактуру ${issuedView.code}? Номер останется занятым. Если фактура уже передана клиенту, обычно выставляют исправленную фактуру. Причина:`)
              if (reason === null) return
              await voidInvoice(issuedView.id, reason); toast('Фактура аннулирована')
            }, true)}
          </Card>
          <Preview inv={issuedView} code={issuedView.code ?? '—'} />
        </div>
        <PaySheet inv={issuedView} open={pay} onClose={() => setPay(false)} />
      </Sheet>
    )
  }

  if (!draft) return null

  /* ----- draft: edit and preview ----- */
  return (
    <Sheet open onClose={close} title={mode === 'preview' ? 'Предпросмотр' : draft.rectifiesId ? 'Исправленная фактура' : stored ? 'Черновик фактуры' : 'Новая фактура'} full>
      {mode === 'preview' ? (
        <div className="space-y-4 px-4 pt-3">
          <Preview inv={draft} code={nextCode} />
          {problems.length ? (
            <Card className="space-y-1.5 p-4 text-[14px]">
              <p className="flex items-center gap-2 font-medium text-amber"><AlertTriangle size={18} /> Чтобы выставить, исправьте:</p>
              {problems.map((p) => <p key={p} className="text-mist">• {p}</p>)}
            </Card>
          ) : (
            <p className="px-1 text-[13px] text-mist">Номер {nextCode} будет присвоен при выставлении. После этого фактуру нельзя изменить — только аннулировать или исправить.</p>
          )}
          <PrimaryButton disabled={!!problems.length || busy} onClick={() => setConfirmIssue(true)}>Выставить фактуру {nextCode}</PrimaryButton>
          <div className="grid grid-cols-2 gap-2 pb-2">
            <button onClick={() => setMode('edit')} className="press h-12 rounded-2xl bg-white/8 font-medium">Изменить</button>
            <button disabled={busy} onClick={async () => { try { await persist(); await sharePdf({ ...draft, code: null }) } catch (e) { toast((e as Error).message) } }} className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-white/8 font-medium"><FileText size={18} /> PDF-черновик</button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 px-4 pt-3">
          {/* client */}
          <section className="space-y-2">
            <p className="px-1 text-[15px] font-medium text-mist">Клиент</p>
            <button onClick={() => setPicker(true)} className="press glass flex w-full items-center gap-3 rounded-[22px] p-3.5 text-left">
              {client ? <Avatar client={client} size={42} /> : <span className="grid h-[42px] w-[42px] place-items-center rounded-full bg-white/8 text-mist"><UserPlus size={20} /></span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium">{client ? client.name : 'Выбрать клиента'}</span>
                {client && <span className={`block truncate text-[13px] ${client.taxId && client.address ? 'text-mist' : 'text-amber'}`}>{client.taxId && client.address ? `${client.taxId} · ${client.address}` : 'Нужны налоговые реквизиты'}</span>}
              </span>
              <ChevronRight size={18} className="text-fog" />
            </button>
            {client && <button onClick={() => setTaxFor(client.id)} className="press px-1 text-[14px] text-iris">{client.taxId ? 'Изменить реквизиты клиента' : 'Добавить реквизиты: фото, скриншот или вручную'}</button>}
          </section>

          {/* issuer + series */}
          <section className="space-y-2">
            <p className="px-1 text-[15px] font-medium text-mist">Выставитель и номер</p>
            {issuers.length ? (
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {issuers.map((i) => <button key={i.id} onClick={() => set({ issuerId: i.id, iban: i.iban ?? draft.iban })} className={`press shrink-0 rounded-xl px-3.5 py-2.5 text-[14px] ${draft.issuerId === i.id ? 'bg-iris/30 text-ink' : 'bg-white/8 text-mist'}`}>{i.label || i.name}</button>)}
                <button onClick={() => setIssuersOpen(true)} aria-label="Мои реквизиты" className="press shrink-0 rounded-xl bg-white/8 px-3 py-2.5 text-mist"><Plus size={16} /></button>
              </div>
            ) : <button onClick={() => setIssuersOpen(true)} className="press glass w-full rounded-2xl px-4 py-3.5 text-left text-[15px] text-amber">Заполните «Мои реквизиты»</button>}
            {usable.length ? (
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {usable.map((s) => <button key={s.id} onClick={() => set({ seriesId: s.id })} className={`press shrink-0 rounded-xl px-3.5 py-2.5 text-[14px] ${draft.seriesId === s.id ? 'bg-iris/30 text-ink' : 'bg-white/8 text-mist'}`}>{s.name}</button>)}
              </div>
            ) : <button onClick={() => setSeriesOpen(true)} className="press glass w-full rounded-2xl px-4 py-3.5 text-left text-[15px] text-amber">Настройте нумерацию: укажите следующий номер</button>}
            {curSeries && <p className="px-1 text-[13px] text-mist">Номер при выставлении: <span className="num text-ink">{nextCode}</span>{!seriesOwnedHere(curSeries) ? ' · серия выпускается на другом устройстве' : ''}</p>}
          </section>

          {/* dates */}
          <section className="grid grid-cols-2 gap-2">
            <label className="block"><span className="mb-1.5 block px-1 text-[13px] text-mist">Дата выставления</span>
              <input type="date" value={draft.issueDate} onChange={(e) => set({ issueDate: e.target.value })} className="glass h-14 w-full rounded-2xl px-3 outline-none" /></label>
            <label className="block"><span className="mb-1.5 block px-1 text-[13px] text-mist">Оплатить до</span>
              <input type="date" value={draft.dueDate ?? ''} onChange={(e) => set({ dueDate: e.target.value || null })} className="glass h-14 w-full rounded-2xl px-3 outline-none" /></label>
          </section>

          {/* lines */}
          <section className="space-y-2">
            <p className="px-1 text-[15px] font-medium text-mist">Услуги</p>
            {draft.lines.map((l) => (
              <LineRow key={l.id} line={l} canRemove={draft.lines.length > 1}
                onChange={(n) => set({ lines: draft.lines.map((x) => (x.id === n.id ? n : x)) })}
                onRemove={() => set({ lines: draft.lines.filter((x) => x.id !== l.id) })} />
            ))}
            <button onClick={() => set({ lines: [...draft.lines, newLine()] })} className="press glass flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-[15px] text-iris"><Plus size={18} /> Добавить строку</button>
          </section>

          {/* taxes */}
          <section className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="IVA, %" value={rates.vat} inputMode="decimal" maxLength={6} error={rates.vat.trim() && parseRate(rates.vat) === null ? 'Неверная ставка' : null}
                onChange={(v) => { setRates((r) => ({ ...r, vat: v })); const p = parseRate(v); if (p !== null) set({ vatRate: p }) }} />
              <Field label="IRPF, %" value={rates.irpf} inputMode="decimal" maxLength={6} hint="0 — без удержания" error={rates.irpf.trim() && parseRate(rates.irpf) === null ? 'Неверная ставка' : null}
                onChange={(v) => { setRates((r) => ({ ...r, irpf: v })); const p = v.trim() ? parseRate(v) : 0; if (p !== null) set({ irpfRate: p }) }} />
            </div>
            {!draft.vatRate && <Field label="Основание IVA 0 %" value={draft.vatNote ?? ''} onChange={(v) => set({ vatNote: v })} placeholder="Operación exenta de IVA (art. 20 Ley 37/1992)" maxLength={600} hint="Обязательно при нулевой ставке" />}
          </section>

          <Field label="IBAN для оплаты" value={draft.iban ?? ''} onChange={(v) => set({ iban: v })} error={draft.iban?.trim() && !validIban(draft.iban) ? 'IBAN не проходит проверку.' : null} maxLength={40} />
          <Field label="Примечания" value={draft.notes ?? ''} onChange={(v) => set({ notes: v })} multiline placeholder="Необязательно" maxLength={4000} />

          {totals && (
            <Card className="space-y-1.5 p-4 text-[15px]">
              <p className="flex justify-between text-mist"><span>Сумма без IVA</span><span className="num">{fmt(totals.base)}</span></p>
              <p className="flex justify-between text-mist"><span>IVA {rateLabel(draft.vatRate)}</span><span className="num">{fmt(totals.vat)}</span></p>
              {!!draft.irpfRate && <p className="flex justify-between text-mist"><span>IRPF {rateLabel(draft.irpfRate)}</span><span className="num">−{fmt(totals.irpf)}</span></p>}
              <p className="flex justify-between pt-1 text-[18px] font-semibold"><span>Итого</span><span className="num">{fmt(totals.total)}</span></p>
              <p className="text-[12px] text-fog">Выставление фактуры не добавляет доход. Доход появится, когда вы отметите оплату.</p>
            </Card>
          )}

          <PrimaryButton disabled={busy} onClick={async () => { try { await persist(); setMode('preview') } catch { /* toast */ } }}>Предпросмотр</PrimaryButton>
          <div className="grid grid-cols-2 gap-2 pb-2">
            <button onClick={close} className="press h-12 rounded-2xl bg-white/8 font-medium">Сохранить черновик</button>
            {stored ? (
              <button onClick={() => { if (window.confirm('Удалить черновик? Номер он не занимал.')) { try { deleteDraft(draft.id); onClose() } catch (e) { toast((e as Error).message) } } }} className="press h-12 rounded-2xl bg-white/8 font-medium text-expense">Удалить</button>
            ) : <button onClick={onClose} className="press h-12 rounded-2xl bg-white/8 font-medium text-mist">Отмена</button>}
          </div>
        </div>
      )}

      {confirmIssue && (
        <div className="anim-fade fixed inset-0 z-[60] grid place-items-center bg-black/60 p-6" onClick={() => !busy && setConfirmIssue(false)}>
          <div className="glass-strong w-full max-w-sm rounded-[28px] p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold">Выставить фактуру {nextCode}?</p>
            <p className="mt-1 text-[14px] text-mist">{client?.legalName || client?.name}, {fmt(totals?.total ?? 0)}. Номер закрепится за этой фактурой, изменить её будет нельзя.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={() => setConfirmIssue(false)} className="press flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-white/8 font-medium"><X size={18} /> Отмена</button>
              <button disabled={busy} onClick={doIssue} className="press flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-iris/85 font-semibold text-white"><Check size={18} /> Выставить</button>
            </div>
          </div>
        </div>
      )}

      <ClientPicker open={picker} onClose={() => setPicker(false)} onPick={(id) => { set({ clientId: id }); setPicker(false); const c = getState().clients.find((x) => x.id === id); if (c && (!c.taxId || !c.address)) setTaxFor(id) }} onNew={() => { setPicker(false); setTaxFor(null) }} />
      <ClientTaxSheet open={taxFor !== undefined} clientId={taxFor} onClose={() => setTaxFor(undefined)} onSaved={(id) => set({ clientId: id })} />
      <IssuersSheet open={issuersOpen} onClose={() => setIssuersOpen(false)} />
      <InvoicingSettingsSheet open={seriesOpen} onClose={() => setSeriesOpen(false)} />
    </Sheet>
  )
}

export const clientHasTax = (c: { taxId?: string; address?: string }) => !!(c.taxId && taxIdKind(c.taxId) && c.address)
