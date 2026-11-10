import { useEffect, useState } from 'react'
import { AlertTriangle, Archive, ChevronRight, GitMerge, Laptop, Link2Off, RefreshCw } from 'lucide-react'
import { createServerBackup, fetchServerBackup, listServerBackups, pair, resolveConflict, syncNow, unpair, useSyncStatus, type Conflict, type ServerBackup } from '../lib/sync'
import { cleanHost, validHost, CA_PORT } from '../lib/sync/device'
import { parseBackup, planRestore, restoreFromBackup, type Backup, type RestorePlan } from '../lib/backup'
import { toast } from '../lib/toast'
import { dayLabel, fmt, plural, timeLabel } from '../lib/format'
import type { Category, Client, Operation } from '../lib/types'
import { Card, PrimaryButton, Sheet } from './ui'

const when = (iso: string | null) => (iso ? `${dayLabel(iso)}, ${timeLabel(iso)}` : 'ещё не было')
const ops = (n: number) => `${n} ${plural(n, 'операция', 'операции', 'операций')}`
const cls = (n: number) => `${n} ${plural(n, 'клиент', 'клиента', 'клиентов')}`

export function SyncSection({ onRestored }: { onRestored?: () => void }) {
  const s = useSyncStatus()
  const [pairOpen, setPairOpen] = useState(false)
  const [backups, setBackups] = useState(false)
  const [conflicts, setConflicts] = useState(false)

  const dot = s.phase === 'syncing' ? 'bg-iris animate-pulse' : s.phase === 'error' ? 'bg-expense' : s.reachable === false || s.phase === 'offline' ? 'bg-amber' : s.reachable ? 'bg-income' : 'bg-fog'
  const line = s.phase === 'syncing' ? 'Синхронизация…'
    : s.phase === 'offline' ? 'Недоступен — данные сохраняются на iPhone'
    : s.phase === 'error' ? 'Ошибка синхронизации'
    : s.reachable ? 'Подключён' : 'Проверяем связь…'

  return (
    <section>
      <p className="mb-2 px-1 text-[15px] font-medium text-mist">Синхронизация и резервные копии</p>
      {!s.paired ? (
        <Card className="overflow-hidden">
          <button onClick={() => setPairOpen(true)} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
            <Laptop size={20} className="text-iris" />
            <span className="flex-1">
              <span className="block text-[16px]">Подключить компьютер</span>
              <span className="block text-[13px] text-mist">Автосинхронизация по Wi-Fi и копии раз в неделю</span>
            </span>
            <ChevronRight size={18} className="text-fog" />
          </button>
        </Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          <button onClick={() => void syncNow()} aria-label="Проверить синхронизацию" className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
            <span className="relative"><Laptop size={20} className="text-iris" /><span className={`absolute -right-1 -bottom-1 h-2.5 w-2.5 rounded-full ring-2 ring-abyss ${dot}`} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px]">{s.serverName ?? 'Компьютер'}</span>
              <span className="block text-[13px] text-mist">{line}</span>
            </span>
            <RefreshCw size={17} className={`text-fog ${s.phase === 'syncing' ? 'animate-spin' : ''}`} />
          </button>
          <div className="space-y-1.5 px-4 py-3 text-[14px]">
            <p className="flex justify-between gap-3"><span className="text-mist">Синхронизация</span><span className="text-right">{when(s.lastSyncAt)}</span></p>
            <p className="flex justify-between gap-3"><span className="text-mist">Копия на компьютере</span><span className="text-right">{when(s.lastBackupAt)}</span></p>
            <p className="flex justify-between gap-3"><span className="text-mist">Ожидают отправки</span><span className={s.pending ? 'text-amber' : ''}>{s.pending ? `${s.pending} ${plural(s.pending, 'изменение', 'изменения', 'изменений')}` : 'нет'}</span></p>
            {s.error && <p className="flex gap-2 pt-1 text-[13px] text-amber"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {s.error}</p>}
          </div>
          {s.conflicts.length > 0 && (
            <Row Icon={GitMerge} label="Изменено на двух устройствах" hint={String(s.conflicts.length)} warn onClick={() => setConflicts(true)} />
          )}
          <Row Icon={Archive} label="Резервные копии на компьютере" onClick={() => setBackups(true)} />
          <Row Icon={Link2Off} label="Отключить компьютер" onClick={async () => {
            if (!window.confirm('Отключить компьютер на этом iPhone? Все данные останутся на iPhone и на компьютере.')) return
            await unpair(); toast('Компьютер отключён. Данные на месте.')
          }} />
        </Card>
      )}
      <p className="mt-2 px-1 text-[13px] text-fog">Все операции сохраняются на iPhone и без компьютера. Синхронизация идёт сама, пока Financy открыт и компьютер в той же Wi-Fi.</p>

      <PairSheet open={pairOpen} onClose={() => setPairOpen(false)} />
      <BackupsSheet open={backups} onClose={() => setBackups(false)} onRestored={onRestored} />
      <ConflictsSheet open={conflicts} onClose={() => setConflicts(false)} list={s.conflicts} />
    </section>
  )
}

function Row({ Icon, label, hint, onClick, warn }: { Icon: typeof Laptop; label: string; hint?: string; onClick: () => void; warn?: boolean }) {
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
      <Icon size={20} className={warn ? 'text-amber' : 'text-iris'} />
      <span className="flex-1 text-[16px]">{label}</span>
      {hint && <span className={`text-[13px] ${warn ? 'text-amber' : 'text-fog'}`}>{hint}</span>}
      <ChevronRight size={18} className="text-fog" />
    </button>
  )
}

function PairSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) setError(null) }, [open])
  const host = cleanHost(address)
  const submit = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try { await pair(address, code); toast('Компьютер подключён'); setCode(''); onClose() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose() }} title="Подключить компьютер">
      <div className="space-y-4 px-5 pt-3">
        <ol className="list-decimal space-y-1.5 pl-5 text-[14px] text-mist">
          <li>На компьютере запустите «Установить Financy Sync» — откроется страница с адресом и кодом.</li>
          <li>Один раз установите сертификат: откройте {validHost(host)
            ? <a className="text-iris underline" href={`http://${host}:${CA_PORT}/`} target="_blank" rel="noreferrer">http://{host}:{CA_PORT}</a>
            : <>http://адрес:{CA_PORT}</>} в Safari и следуйте шагам на странице.</li>
          <li>Введите адрес и код с компьютера.</li>
        </ol>
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Адрес, например 192.168.1.20" aria-label="Адрес компьютера"
          inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" className="glass h-14 w-full rounded-2xl px-4 outline-none placeholder:text-fog" />
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Код из 6 цифр" aria-label="Код подключения"
          inputMode="numeric" autoComplete="one-time-code" className="num glass h-14 w-full rounded-2xl px-4 text-[20px] tracking-[0.2em] outline-none placeholder:text-[16px] placeholder:tracking-normal placeholder:text-fog" />
        {error && <p className="flex gap-2 text-[14px] text-amber"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}</p>}
        <PrimaryButton disabled={busy || !address.trim() || code.length !== 6} onClick={submit}>{busy ? 'Подключаем…' : 'Подключить'}</PrimaryButton>
        <p className="text-[13px] text-fog">Ключ подключения хранится только на этом iPhone и не может быть скопирован. Ваши данные не передаются в интернет.</p>
      </div>
    </Sheet>
  )
}

const KIND: Record<ServerBackup['kind'], string> = { weekly: 'Еженедельная', manual: 'Создана вручную', 'pre-restore': 'Перед восстановлением' }

function BackupsSheet({ open, onClose, onRestored }: { open: boolean; onClose: () => void; onRestored?: () => void }) {
  const [list, setList] = useState<ServerBackup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ meta: ServerBackup; backup: Backup; plan: RestorePlan } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) { setPicked(null); return }
    setList(null); setError(null)
    listServerBackups().then(setList, (e) => setError((e as Error).message))
  }, [open])
  const choose = async (meta: ServerBackup) => {
    if (busy || !meta.valid) return
    setBusy(true)
    try {
      const raw = await fetchServerBackup(meta.file)
      const backup = parseBackup(JSON.stringify(raw))
      setPicked({ meta, backup, plan: planRestore(backup) })
    } catch (e) { toast((e as Error).message) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!picked || busy) return
    setBusy(true)
    try {
      await createServerBackup('pre-restore') // protective copy of the current state on the PC
      const r = await restoreFromBackup(picked.backup) // + local snapshot for «Вернуть данные до восстановления»
      toast(`Восстановлено: вернулось ${r.restored}, изменено ${r.changed}`)
      setPicked(null); onClose(); onRestored?.()
      void syncNow()
    } catch (e) { toast((e as Error).message || 'Не удалось восстановить. Данные не изменены.') }
    finally { setBusy(false) }
  }
  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose() }} title="Копии на компьютере" full>
      <div className="px-4 pt-3">
        {!picked ? <>
          {error && <p className="flex gap-2 px-1 py-6 text-[15px] text-amber"><AlertTriangle size={17} className="mt-0.5 shrink-0" /> {error}</p>}
          {!error && !list && <p className="py-12 text-center text-[15px] text-mist">Загружаем список…</p>}
          {list && !list.length && <p className="py-12 text-center text-[15px] text-mist">Копий пока нет. Первая появится после синхронизации.</p>}
          {list && list.length > 0 && (
            <Card className="divide-y divide-line overflow-hidden">
              {list.map((b) => (
                <button key={b.file} disabled={busy || !b.valid} onClick={() => choose(b)} className="press flex w-full items-center gap-3 px-4 py-3 text-left disabled:opacity-50">
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-medium">{b.createdAt ? new Date(b.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : b.file}</p>
                    <p className="text-[13px] text-mist">{b.valid && b.counts ? `${KIND[b.kind]}, ${ops(b.counts.operations)}, ${cls(b.counts.clients)}` : 'Файл повреждён'}</p>
                  </div>
                  <ChevronRight size={18} className="text-fog" />
                </button>
              ))}
            </Card>
          )}
          <p className="mt-3 px-1 text-[13px] text-fog">Копии создаются автоматически раз в неделю и хранятся 30 дней на компьютере.</p>
        </> : (
          <Card className="space-y-3 p-4">
            <p className="text-[17px] font-semibold">Восстановить копию?</p>
            <p className="text-[14px] text-mist">
              Копия от {new Date(picked.meta.createdAt!).toLocaleString('ru-RU')}: {ops(picked.backup.operations.filter((o) => !o.deletedAt).length)}, {cls(picked.backup.clients.filter((c) => !c.deletedAt).length)}.
            </p>
            <ul className="space-y-1 text-[14px]">
              <li>Вернётся: <b>{picked.plan.restored}</b></li>
              <li>Вернётся к версии из копии: <b>{picked.plan.changed}</b></li>
              <li>Без изменений: {picked.plan.unchanged}</li>
              {picked.plan.newer > 0 && <li className="text-mist">Добавлено позже и останется: {picked.plan.newer}</li>}
            </ul>
            <p className="text-[13px] text-mist">Перед восстановлением текущее состояние сохранится копией на компьютере и на iPhone («Вернуть данные до восстановления» в настройках).</p>
            <PrimaryButton disabled={busy || picked.plan.items.length === 0} onClick={confirm}>{busy ? 'Восстанавливаем…' : picked.plan.items.length ? 'Восстановить' : 'Данные уже совпадают'}</PrimaryButton>
            <button disabled={busy} onClick={() => setPicked(null)} className="press h-12 w-full rounded-2xl font-medium text-mist">Назад</button>
          </Card>
        )}
      </div>
    </Sheet>
  )
}

function describe(c: Conflict, data: Operation | Client | Category) {
  if (c.entity === 'operation') {
    const o = data as Operation
    return `${o.deletedAt ? 'Удалена: ' : ''}${o.title}, ${o.type === 'income' ? '+' : '−'}${fmt(o.amount, o.currency)}, ${dayLabel(o.date).toLowerCase()}${o.note ? `, «${o.note}»` : ''}`
  }
  return `${(data as Client).name}${data.deletedAt ? ' (удалён)' : ''}`
}

function ConflictsSheet({ open, onClose, list }: { open: boolean; onClose: () => void; list: Conflict[] }) {
  const [busy, setBusy] = useState(false)
  const act = async (c: Conflict, choice: 'kept' | 'other') => {
    if (busy) return
    setBusy(true)
    try { await resolveConflict(c, choice); toast(choice === 'kept' ? 'Оставлена текущая версия' : 'Выбрана другая версия') }
    catch (e) { toast((e as Error).message) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (open && !list.length) onClose() }, [open, list.length, onClose])
  return (
    <Sheet open={open} onClose={onClose} title="Изменено на двух устройствах" full>
      <div className="space-y-3 px-4 pt-3">
        <p className="px-1 text-[14px] text-mist">Запись изменили одновременно на разных устройствах. Сохранена более новая версия, вторая не потеряна — выберите, какую оставить.</p>
        {list.map((c) => (
          <Card key={c.id} className="space-y-3 p-4">
            <div className="rounded-2xl bg-white/6 p-3"><p className="text-[12px] text-mist">Сейчас</p><p className="text-[15px]">{describe(c, c.kept.data)}</p></div>
            <div className="rounded-2xl bg-white/6 p-3"><p className="text-[12px] text-mist">Другая версия</p><p className="text-[15px]">{describe(c, c.other.data)}</p></div>
            <div className="grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={() => act(c, 'kept')} className="press h-12 rounded-2xl bg-white/10 font-medium">Оставить</button>
              <button disabled={busy} onClick={() => act(c, 'other')} className="press h-12 rounded-2xl bg-white/10 font-medium text-iris">Взять другую</button>
            </div>
          </Card>
        ))}
      </div>
    </Sheet>
  )
}
