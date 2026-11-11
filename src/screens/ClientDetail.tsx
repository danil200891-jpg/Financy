import { useMemo, useState } from 'react'
import { ChevronRight, FileText, Plus, Trash2 } from 'lucide-react'
import type { Nav } from '../App'
import { actions, useStore, waitForWrites } from '../lib/store'
import { byPeriod, monthly, totals } from '../lib/stats'
import { fmt, fmtShort, monthShort } from '../lib/format'
import { Avatar, Card, ChevronLeft, IconButton, OpRow } from '../components/ui'
import { InvoiceSheet } from '../components/invoices/InvoiceSheet'
import { ClientTaxSheet } from '../components/invoices/ClientTaxSheet'
import { invoicesForClient } from '../lib/invoice-actions'
import { STATUS_COLOR, STATUS_LABEL, computeTotals, displayStatus } from '../lib/invoicing'

export function ClientDetail({ id, nav, onBack }: { id: string; nav: Nav; onBack: () => void }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const cats = useStore((s) => s.categories)
  const c = clients.find((x) => x.id === id)
  const own = useMemo(() => ops.filter((o) => o.clientId === id), [ops, id])
  const months = useMemo(() => monthly(own, 12), [own])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [limit, setLimit] = useState(100)
  const invoicing = useStore((s) => s.invoicing)
  const invoices = useMemo(() => invoicesForClient(invoicing, id).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt)), [invoicing, id])
  const [invoice, setInvoice] = useState<{ id: string | null } | null>(null)
  const [tax, setTax] = useState(false)
  if (!c) return null

  const stat = [
    { label: 'Месяц', v: totals(byPeriod(own, 'month')).income },
    { label: 'Год', v: totals(byPeriod(own, 'year')).income },
    { label: 'Всё время', v: totals(own).income },
  ]
  const max = Math.max(1, ...months.map((m) => m.income))

  return (
    <div className="anim-push fixed inset-0 z-45 overflow-y-auto bg-abyss pb-[calc(env(safe-area-inset-bottom)+110px)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-50" style={{ background: `radial-gradient(80% 100% at 50% 0%, ${c.color}55, transparent)` }} />
      <div className="relative mx-auto max-w-[520px]">
        <div className="pt-safe flex items-center justify-between px-4">
          <IconButton label="Назад" onClick={onBack}>
            <ChevronLeft size={22} />
          </IconButton>
          <IconButton label="Удалить клиента" onClick={() => setConfirm(true)}>
            <Trash2 size={18} />
          </IconButton>
        </div>

        <div className="mt-4 flex flex-col items-center">
          <Avatar client={c} size={88} />
          <h1 className="mt-4 max-w-full break-words px-4 text-center font-display text-[26px] font-semibold tracking-[-0.02em]">{c.name}</h1>
          <p className="text-[14px] text-mist">{own.length} операций</p>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2 px-4">
          {stat.map((s) => (
            <Card key={s.label} className="px-3 py-3.5">
              <p className="text-[13px] text-mist">{s.label}</p>
              <p className="num mt-0.5 text-[17px] font-semibold">{fmtShort(s.v)}</p>
            </Card>
          ))}
        </div>

        <Card className="mx-4 mt-3 p-5">
          <p className="mb-4 text-[15px] font-medium">Доход по месяцам</p>
          <div className="flex h-32 items-end gap-1.5">
            {months.map((m, i) => (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                <div
                  className="w-full max-w-[16px] origin-bottom rounded-full"
                  style={{ height: `${Math.max(4, (m.income / max) * 100)}%`, background: `linear-gradient(${c.color}, ${c.color}40)`, animation: `grow-y 700ms var(--ease-spring) ${i * 30}ms both`, opacity: m.income ? 1 : 0.25 }}
                />
                <span className="text-[10px] text-fog">{monthShort(m.m)}</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="mt-6 mb-3 flex items-center justify-between px-5">
          <h2 className="text-[20px] font-semibold">Фактуры</h2>
          <button onClick={() => setInvoice({ id: null })} className="press flex items-center gap-1 rounded-xl bg-white/8 px-3 py-2 text-[14px] text-iris"><Plus size={16} /> Создать</button>
        </div>
        <Card className="mx-4 divide-y divide-line overflow-hidden">
          <button onClick={() => setTax(true)} className="press flex w-full items-center gap-3 px-4 py-3.5 text-left">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]">Реквизиты клиента</span>
              <span className={`block truncate text-[13px] ${c.taxId ? 'text-mist' : 'text-fog'}`}>{c.taxId ? `${c.legalName || c.name} · ${c.taxId}` : 'Не указаны — нужны только для фактур'}</span>
            </span>
            <ChevronRight size={18} className="text-fog" />
          </button>
          {invoices.map((inv) => {
            const st = displayStatus(inv)
            const total = (inv.totals ?? computeTotals(inv.lines, inv.vatRate, inv.irpfRate)).total
            return (
              <button key={inv.id} onClick={() => setInvoice({ id: inv.id })} className="press flex w-full items-center gap-3 px-4 py-3.5 text-left">
                <FileText size={20} className="shrink-0 text-iris" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{inv.code ?? 'Черновик'}</span>
                  <span className="block text-[12px] text-mist">{inv.issueDate.split('-').reverse().join('.')} · <span className={STATUS_COLOR[st]}>{STATUS_LABEL[st]}</span></span>
                </span>
                <span className={`num text-[15px] font-semibold ${st === 'void' ? 'text-fog line-through' : ''}`}>{fmt(total)}</span>
              </button>
            )
          })}
        </Card>

        <h2 className="mt-6 mb-3 px-5 text-[20px] font-semibold">Операции</h2>
        <Card className="mx-4 divide-y divide-line overflow-hidden">
          {own.slice(0, limit).map((o) => (
            <OpRow key={o.id} op={o} showDate cat={cats.find((x) => x.id === o.categoryId)} onClick={() => nav.openEdit(o.id)} />
          ))}
        </Card>
        {own.length > limit && <button onClick={() => setLimit((value) => value + 100)} className="glass press mx-4 mt-3 h-12 rounded-2xl px-5 text-[15px] text-iris">Показать ещё</button>}
      </div>

      <InvoiceSheet open={!!invoice} invoiceId={invoice?.id} clientId={id} onClose={() => setInvoice(null)} onOpen={(x) => setInvoice({ id: x })} />
      <ClientTaxSheet open={tax} clientId={id} onClose={() => setTax(false)} />

      {confirm && (
        <div className="anim-fade fixed inset-0 z-50 grid place-items-center bg-black/60 px-8" onClick={() => setConfirm(false)}>
          <div className="glass-strong w-full max-w-[320px] rounded-[26px] p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold">Удалить «{c.name}»?</p>
            <p className="mt-1 text-[14px] text-mist">Операции останутся в истории как разовые, итого {fmt(totals(own).income)}.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button onClick={() => setConfirm(false)} className="press h-12 rounded-2xl bg-white/8 font-medium">Отмена</button>
              <button disabled={busy} onClick={async () => {
                if (busy) return
                setBusy(true)
                try { actions.removeClient(c.id); await waitForWrites(); onBack() }
                catch { /* The store restores the client and reports the error. */ }
                finally { setBusy(false) }
              }} className="press h-12 rounded-2xl bg-expense/90 font-semibold text-white">Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
