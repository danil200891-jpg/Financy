import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight, Database, FileJson, FileSpreadsheet, FlaskConical, Plus, RotateCcw, Shapes, Trash2, Undo2, Upload, WifiOff,
} from 'lucide-react'
import { actions, useStore, waitForWrites } from '../lib/store'
import { exportCSV, exportJSON, getLastBackup, getPreRestore, parseBackup, restore, undoRestore, type Backup } from '../lib/backup'
import { toast } from '../lib/toast'
import { dayLabel, fmt, plural } from '../lib/format'
import type { OpType } from '../lib/types'
import { Card, CategoryIcon, ChevronLeft, ICONS, IconButton, PrimaryButton, Segmented, Sheet } from '../components/ui'
import { GoogleDriveBackup } from '../components/GoogleDriveBackup'
import { SyncSection } from '../components/SyncSection'
import { finishDriveRestore, completeDriveRestore } from '../lib/drive-backup'

const PALETTE = ['#3fe0c5', '#7c8cff', '#9f6bff', '#ffc56b', '#ff9f6b', '#ff6b81', '#6bc5ff', '#5ee08a', '#ff7ad9']

function CategoriesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cats = useStore((s) => s.categories)
  const [type, setType] = useState<OpType>('expense')
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('tag')
  const [color, setColor] = useState(PALETTE[0])
  const [busy, setBusy] = useState(false)
  return (
    <Sheet open={open} onClose={onClose} title="Категории" full>
      <div className="px-4 pt-3">
        <Segmented value={type} onChange={setType} options={[{ value: 'expense', label: 'Расходы' }, { value: 'income', label: 'Доходы' }]} />
        <Card className="mt-4 divide-y divide-line overflow-hidden">
          {cats.filter((c) => c.type === type && !c.archived).map((c) => (
            <div key={c.id} className="flex items-center gap-3.5 px-4 py-3">
              <CategoryIcon cat={c} size={40} />
              <p className="flex-1 text-[16px] font-medium">{c.name}</p>
              <button aria-label={`Удалить ${c.name}`} onClick={async () => {
                if (!window.confirm(`Удалить категорию «${c.name}»? Операции сохранятся без этой категории.`)) return
                try { actions.removeCategory(c.id); await waitForWrites(); toast(`Категория «${c.name}» удалена`) }
                catch { /* The store restores failed changes. */ }
              }} className="press p-2 text-fog">
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </Card>

        {cats.some((c) => c.type === type && c.archived) && <>
          <p className="mt-6 mb-2 px-1 text-[15px] font-medium text-mist">Скрытые</p>
          <Card className="divide-y divide-line overflow-hidden">
            {cats.filter((c) => c.type === type && c.archived).map((c) => (
              <div key={c.id} className="flex items-center gap-3.5 px-4 py-3">
                <CategoryIcon cat={c} size={40} />
                <p className="flex-1 text-[16px] font-medium text-mist">{c.name}</p>
                <button onClick={() => actions.updateCategory(c.id, { archived: false })} className="press rounded-xl bg-white/8 px-3 py-2 text-[14px] font-medium text-iris">Показать</button>
              </div>
            ))}
          </Card>
        </>}

        <p className="mt-6 mb-2 px-1 text-[15px] font-medium text-mist">Новая категория</p>
        <Card className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <CategoryIcon cat={{ id: '', name, type, icon, color }} size={48} />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" className="h-12 min-w-0 flex-1 rounded-xl bg-white/6 px-3.5 outline-none placeholder:text-fog" />
          </div>
          <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8">
            {Object.keys(ICONS).map((k) => {
              const I = ICONS[k]
              return (
                <button key={k} aria-label={k} onClick={() => setIcon(k)} className={`grid aspect-square place-items-center rounded-xl ${icon === k ? 'bg-white/15 text-ink' : 'text-mist'}`}>
                  <I size={18} />
                </button>
              )
            })}
          </div>
          <div className="no-scrollbar flex gap-2 overflow-x-auto py-1">
            {PALETTE.map((c) => (
              <button key={c} aria-label={`Цвет ${c}`} onClick={() => setColor(c)} className="h-11 w-11 shrink-0 rounded-full" style={{ background: c, boxShadow: c === color ? `0 0 0 3px #12141f, 0 0 0 5px ${c}` : undefined }} />
            ))}
          </div>
          <PrimaryButton disabled={!name.trim() || busy} onClick={async () => {
            if (busy) return
            setBusy(true)
            try { actions.addCategory({ name: name.trim(), type, icon, color }); await waitForWrites(); toast(`Категория «${name.trim()}» добавлена`); setName('') }
            catch { /* Keep the category draft available. */ }
            finally { setBusy(false) }
          }}>
            <span className="inline-flex items-center gap-2"><Plus size={20} /> Добавить категорию</span>
          </PrimaryButton>
        </Card>
      </div>
    </Sheet>
  )
}

function TrashSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const deleted = useStore((s) => s.deleted)
  const [sure, setSure] = useState(false)
  return (
    <Sheet open={open} onClose={onClose} title="Недавно удалённые" full>
      <div className="px-4 pt-3">
        {deleted.length === 0 ? (
          <p className="py-12 text-center text-[15px] text-mist">Корзина пуста</p>
        ) : (
          <>
            <Card className="divide-y divide-line overflow-hidden">
              {deleted.map((o) => (
                <div key={o.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-medium">{o.title}</p>
                    <p className="num text-[13px] text-mist">{o.type === 'income' ? '+' : '−'}{fmt(o.amount)}, удалена {dayLabel(o.deletedAt!).toLowerCase()}</p>
                  </div>
                  <button onClick={() => actions.restoreOperation(o.id)} className="press rounded-xl bg-white/8 px-3 py-2 text-[14px] font-medium text-iris">Вернуть</button>
                </div>
              ))}
            </Card>
            <button
              onClick={async () => {
                if (!sure) { setSure(true); return }
                try { await actions.purgeDeleted(); setSure(false); toast('Корзина очищена') }
                catch { toast('Не удалось очистить корзину. Данные сохранены, попробуйте снова.') }
              }}
              className={`press mt-4 h-14 w-full rounded-[18px] text-[16px] font-medium ${sure ? 'bg-expense text-white' : 'text-expense'}`}
            >
              {sure ? `Удалить навсегда (${deleted.length})` : 'Очистить корзину'}
            </button>
          </>
        )}
      </div>
    </Sheet>
  )
}

function Dialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="anim-fade fixed inset-0 z-[75] grid place-items-center bg-black/60 px-6" onClick={onClose}>
      <div className="glass-strong w-full max-w-[340px] rounded-[26px] p-5" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

type Row = { Icon: typeof Database; label: string; hint?: string; onClick: () => void; danger?: boolean }

export function Settings({ onBack }: { onBack: () => void }) {
  const ops = useStore((s) => s.operations)
  const clients = useStore((s) => s.clients)
  const deleted = useStore((s) => s.deleted)
  const [cats, setCats] = useState(false)
  const [trash, setTrash] = useState(false)
  const [pending, setPending] = useState<Backup | null>(null)
  const [fromDrive, setFromDrive] = useState(false)
  const [wipe, setWipe] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [usage, setUsage] = useState<string | null>(null)
  const [lastBackup, setLastBackup] = useState<string | undefined>()
  const mutation = useRef(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getPreRestore().then((b) => setCanUndo(!!b)).catch(() => {})
    getLastBackup().then(setLastBackup).catch(() => {})
    navigator.storage?.estimate?.().then((e) => e.usage != null && setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} МБ`)).catch(() => {})
  }, [pending])

  const run = async (fn: () => Promise<string>, ok: string) => {
    try {
      const r = await fn()
      if (r !== 'cancelled') toast(ok)
      return r !== 'cancelled'
    } catch (e) {
      toast((e as Error).message || 'Не получилось. Попробуйте ещё раз.')
      return false
    }
  }

  const doRestore = async (mode: 'merge' | 'replace') => {
    if (!pending || mutation.current) return
    mutation.current = true
    setBusy(true)
    try {
      const s = await restore(pending, mode)
      setPending(null)
      if (fromDrive) await completeDriveRestore()
      setFromDrive(false)
      toast(
        mode === 'replace'
          ? `Восстановлено ${s.added} ${plural(s.added, 'операция', 'операции', 'операций')}`
          : `Добавлено ${s.added}, обновлено ${s.updated}, дубликатов пропущено ${s.skippedDuplicates}`,
      )
    } catch (e) {
      toast((e as Error).message)
    } finally { mutation.current = false; setBusy(false) }
  }

  const groups: { group: string; items: Row[] }[] = [
    {
      group: 'Учёт',
      items: [
        { Icon: Shapes, label: 'Категории', onClick: () => setCats(true) },
        { Icon: RotateCcw, label: 'Недавно удалённые', hint: deleted.length ? String(deleted.length) : undefined, onClick: () => setTrash(true) },
      ],
    },
    {
      group: 'Резервная копия',
      items: [
        {
          Icon: FileJson, label: 'Сохранить резервную копию', hint: lastBackup ? dayLabel(lastBackup) : 'JSON',
          onClick: () => run(exportJSON, 'Резервная копия готова').then(() => getLastBackup().then(setLastBackup)),
        },
        { Icon: Upload, label: 'Восстановить из копии', hint: 'JSON', onClick: () => fileRef.current?.click() },
        ...(canUndo ? [{ Icon: Undo2, label: 'Вернуть данные до восстановления', onClick: () => {
          if (window.confirm('Вернуть состояние до восстановления? Более поздние изменения будут отменены. Сначала сохраните новую JSON-копию, если они нужны.')) {
            void run(async () => ((await undoRestore()) ? 'ok' : 'cancelled'), 'Данные возвращены').then((success) => { if (success) setCanUndo(false) })
          }
        } }] : []),
        { Icon: FileSpreadsheet, label: 'Экспорт операций', hint: 'CSV', onClick: () => run(exportCSV, 'Файл CSV готов') },
      ],
    },
    {
      group: 'Данные',
      items: [
        { Icon: FlaskConical, label: 'Добавить демо-данные', onClick: () => { const n = actions.loadDemo(); toast(`Добавлено ${n} демо-операций`) } },
        { Icon: Trash2, label: 'Удалить все данные', onClick: () => setWipe(true), danger: true },
      ],
    },
  ]

  return (
    <div className="anim-push fixed inset-0 z-45 overflow-y-auto bg-abyss">
      <div className="mx-auto max-w-[520px] pb-[calc(env(safe-area-inset-bottom)+40px)]">
        <div className="pt-safe flex items-center gap-3 px-4 pb-4">
          <IconButton label="Назад" onClick={onBack}>
            <ChevronLeft size={22} />
          </IconButton>
          <h1 className="font-display text-[24px] font-semibold tracking-[-0.02em]">Настройки</h1>
        </div>

        <div className="space-y-6 px-4">
          <Card className="flex items-center gap-4 p-4">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-income/12 text-income">
              <Database size={22} />
            </div>
            <div className="flex-1">
              <p className="text-[16px] font-medium">Данные хранятся на этом устройстве</p>
              <p className="text-[13px] text-mist">
                {ops.length} {plural(ops.length, 'операция', 'операции', 'операций')}, {clients.length} {plural(clients.length, 'клиент', 'клиента', 'клиентов')}
                {usage ? `, ${usage}` : ''}
              </p>
            </div>
          </Card>

          {groups.map((g) => (
            <section key={g.group}>
              <p className="mb-2 px-1 text-[15px] font-medium text-mist">{g.group}</p>
              <Card className="divide-y divide-line overflow-hidden">
                {g.items.map((it) => (
                  <button key={it.label} onClick={it.onClick} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
                    <it.Icon size={20} className={it.danger ? 'text-expense' : 'text-iris'} />
                    <span className={`flex-1 text-[16px] ${it.danger ? 'text-expense' : ''}`}>{it.label}</span>
                    {it.hint && <span className="text-[13px] text-fog">{it.hint}</span>}
                    <ChevronRight size={18} className="text-fog" />
                  </button>
                ))}
              </Card>
            </section>
          ))}

          <SyncSection onRestored={() => getPreRestore().then((b) => setCanUndo(!!b)).catch(() => {})} />

          <GoogleDriveBackup onRestore={(backup) => { setFromDrive(true); setPending(backup) }} />

          <Card className="space-y-3 p-4 text-[14px] text-mist">
            <p className="flex gap-3"><WifiOff size={18} className="mt-0.5 shrink-0" /> Работает без интернета, включая распознавание чеков, после первой загрузки.</p>
            <p>Safari и приложение на экране «Домой» хранят данные раздельно. Пользуйтесь установленной версией и регулярно сохраняйте резервную копию в «Файлы» или iCloud Drive.</p>
            <p className="num text-[12px] text-fog">Версия {__APP_VERSION__}</p>
          </Card>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          try {
            setFromDrive(false)
            setPending(parseBackup(await f.text()))
          } catch (err) {
            toast((err as Error).message)
          }
        }}
      />

      {pending && (
        <Dialog onClose={() => { if (busy) return; setPending(null); if (fromDrive) finishDriveRestore(); setFromDrive(false) }}>
          <p className="text-[17px] font-semibold">Восстановить копию?</p>
          <p className="mt-1 text-[14px] text-mist">
            Копия от {new Date(pending.exportedAt).toLocaleString('ru-RU')}: {pending.operations.filter((o) => !o.deletedAt).length} операций, {pending.clients.filter((c) => !c.deletedAt).length} клиентов.
          </p>
          <div className="mt-5 space-y-2">
            <button disabled={busy} onClick={() => doRestore('merge')} className="press w-full rounded-2xl bg-white/10 p-3.5 text-left">
              <p className="text-[16px] font-semibold">Объединить</p>
              <p className="text-[13px] text-mist">Добавить новое, дубликаты пропустить</p>
            </button>
            {!fromDrive && <button disabled={busy} onClick={() => doRestore('replace')} className="press w-full rounded-2xl bg-white/10 p-3.5 text-left">
              <p className="text-[16px] font-semibold text-amber">Заменить всё</p>
              <p className="text-[13px] text-mist">Текущие данные заменятся копией. Это можно отменить в настройках.</p>
            </button>}
            <button disabled={busy} onClick={() => { setPending(null); if (fromDrive) finishDriveRestore(); setFromDrive(false) }} className="press h-12 w-full rounded-2xl font-medium text-mist">Отмена</button>
          </div>
        </Dialog>
      )}

      {wipe && (
        <Dialog onClose={() => setWipe(false)}>
          <p className="text-[17px] font-semibold">Удалить все данные?</p>
          <p className="mt-1 text-[14px] text-mist">Операции, клиенты, свои категории и история изменений удалятся с устройства без возможности восстановления. Сначала сохраните резервную копию.</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button onClick={() => setWipe(false)} className="press h-12 rounded-2xl bg-white/8 font-medium">Отмена</button>
            <button disabled={busy} onClick={async () => {
              if (mutation.current) return
              mutation.current = true; setBusy(true)
              try { await actions.wipeAll(); setWipe(false); toast('Все данные удалены') }
              catch { toast('Не удалось выполнить удаление. Данные сохранены, попробуйте снова.') }
              finally { mutation.current = false; setBusy(false) }
            }} className="press h-12 rounded-2xl bg-expense font-semibold text-white">Удалить</button>
          </div>
        </Dialog>
      )}

      <CategoriesSheet open={cats} onClose={() => setCats(false)} />
      <TrashSheet open={trash} onClose={() => setTrash(false)} />
    </div>
  )
}
