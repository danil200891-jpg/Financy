import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Briefcase, Camera, Sparkles, ShoppingBasket, Coffee, ShoppingBag, Car, Home, Repeat, Heart, Tag,
  Plane, Gift, UserRound, GraduationCap, Dumbbell, Smartphone, Zap, PawPrint, Receipt, Wallet, ChevronLeft, ScanLine, ImageUp, Keyboard,
} from 'lucide-react'
import type { Category, Client, Operation } from '../lib/types'
import { dayLabel, fmt, timeLabel } from '../lib/format'

export const ICONS: Record<string, typeof Tag> = {
  briefcase: Briefcase, camera: Camera, sparkles: Sparkles, basket: ShoppingBasket, coffee: Coffee,
  bag: ShoppingBag, car: Car, home: Home, repeat: Repeat, heart: Heart, tag: Tag, plane: Plane,
  gift: Gift, edu: GraduationCap, sport: Dumbbell, phone: Smartphone, bolt: Zap, pet: PawPrint,
  receipt: Receipt, wallet: Wallet, user: UserRound,
}
export { ChevronLeft, ScanLine, ImageUp, Keyboard }

let scrollLocks = 0
let previousOverflow = ''
export function lockBodyScroll() {
  if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--scrollLocks === 0) document.body.style.overflow = previousOverflow
  }
}

export function CategoryIcon({ cat, size = 44 }: { cat?: Category | null; size?: number }) {
  const I = ICONS[cat?.icon ?? 'tag'] ?? Tag
  const color = cat?.color ?? '#8b90a6'
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[14px]"
      style={{ width: size, height: size, background: `linear-gradient(145deg, ${color}33, ${color}12)`, boxShadow: `inset 0 0 0 1px ${color}26` }}
    >
      <I size={size * 0.45} color={color} strokeWidth={1.9} />
    </div>
  )
}

export function Avatar({ client, size = 44 }: { client: Pick<Client, 'name' | 'color'>; size?: number }) {
  const initials = client.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-display font-medium"
      style={{
        width: size, height: size, fontSize: size * 0.32, color: client.color,
        background: `radial-gradient(circle at 30% 25%, ${client.color}40, ${client.color}10 70%)`,
        boxShadow: `inset 0 0 0 1px ${client.color}30`,
      }}
    >
      {initials}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, className = '' }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className={`glass relative flex rounded-2xl p-1 ${className}`}>
      <div
        className="absolute top-1 bottom-1 rounded-xl bg-white/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-transform duration-300 ease-[var(--ease-spring)]"
        style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`relative z-10 min-w-0 flex-1 px-1 py-2 text-[14px] leading-tight font-medium transition-colors ${o.value === value ? 'text-ink' : 'text-mist'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ScreenHeader({ title, right, sub }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <header className="pt-safe flex items-end justify-between px-5 pb-4">
      <div>
        {sub && <p className="mb-1 text-[15px] text-mist">{sub}</p>}
        <h1 className="font-display text-[30px] leading-none font-semibold tracking-[-0.02em]">{title}</h1>
      </div>
      {right}
    </header>
  )
}

export function IconButton({ children, onClick, label }: { children: ReactNode; onClick?: () => void; label: string }) {
  return (
    <button aria-label={label} onClick={onClick} className="glass press grid h-11 w-11 place-items-center rounded-full text-ink">
      {children}
    </button>
  )
}

export function OpRow({ op, cat, client, onClick, showDate }: {
  op: Operation; cat?: Category | null; client?: Client | null; onClick?: () => void; showDate?: boolean
}) {
  const income = op.type === 'income'
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3.5 px-4 py-3 text-left">
      {client ? <Avatar client={client} /> : <CategoryIcon cat={cat} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-medium">{op.title}</p>
        <p className="truncate text-[13px] text-mist">
          {cat?.name ?? 'Без категории'}
          {showDate ? `, ${dayLabel(op.date).toLowerCase()}` : `, ${timeLabel(op.date)}`}
        </p>
      </div>
      <p className={`num shrink-0 text-[16px] font-semibold ${income ? 'text-income' : 'text-ink'}`}>
        {income ? '+' : '−'}
        {fmt(op.amount, op.currency)}
      </p>
    </button>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`glass rounded-[26px] ${className}`}>{children}</div>
}

/** Bottom sheet with drag-to-dismiss on the grabber. */
export function Sheet({ open, onClose, children, title, full }: {
  open: boolean; onClose: () => void; children: ReactNode; title?: string; full?: boolean
}) {
  const [dy, setDy] = useState(0)
  const [keyboardInset, setKeyboardInset] = useState(0)
  const start = useRef<number | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const unlock = lockBodyScroll()
    const viewport = window.visualViewport
    const resize = () => setKeyboardInset(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0)
    resize()
    viewport?.addEventListener('resize', resize)
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    document.addEventListener('keydown', keyDown)
    return () => { unlock(); document.removeEventListener('keydown', keyDown); viewport?.removeEventListener('resize', resize) }
  }, [open])
  useEffect(() => {
    if (!open) setDy(0)
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50" style={{ bottom: keyboardInset }}>
      <div className="anim-fade absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Добавление операции'}
        className={`glass-strong anim-sheet absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[520px] flex-col rounded-t-[32px] ${full ? 'top-[max(env(safe-area-inset-top),16px)]' : 'max-h-[92%]'}`}
        style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: start.current === null ? 'transform 300ms var(--ease-spring)' : 'none' }}
      >
        <div
          className="flex shrink-0 touch-none flex-col items-center pt-2.5 pb-1"
          onPointerDown={(e) => { start.current = e.clientY; (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
          onPointerMove={(e) => { if (start.current !== null) setDy(Math.max(0, e.clientY - start.current)) }}
          onPointerUp={() => { const d = dy; start.current = null; if (d > 110) onClose(); else setDy(0) }}
          onPointerCancel={() => { start.current = null; setDy(0) }}
        >
          <div className="h-1.5 w-10 rounded-full bg-white/20" />
          {title && <h2 className="mt-3 text-[17px] font-semibold">{title}</h2>}
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+16px)]">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 grid h-16 w-16 place-items-center rounded-3xl bg-white/5">
        <Receipt className="text-mist" />
      </div>
      <p className="text-[17px] font-semibold">{title}</p>
      <p className="mt-1 text-[15px] text-mist">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function PrimaryButton({ children, onClick, disabled, className = '' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`press h-14 w-full rounded-[18px] bg-[linear-gradient(120deg,#7c8cff,#9f6bff)] text-[17px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(124,140,255,0.8)] disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  )
}
