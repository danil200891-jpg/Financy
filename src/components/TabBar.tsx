import { createPortal } from 'react-dom'
import { BarChart3, Clock3, House, Users, Wallet } from 'lucide-react'

export type Tab = 'home' | 'history' | 'clients' | 'analytics' | 'planning'

const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: 'home', label: 'Главная', Icon: House },
  { id: 'history', label: 'История', Icon: Clock3 },
  { id: 'clients', label: 'Клиенты', Icon: Users },
  { id: 'planning', label: 'Планирование', Icon: Wallet },
  { id: 'analytics', label: 'Аналитика', Icon: BarChart3 },
]

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const item = (t: (typeof TABS)[number]) => {
    const active = t.id === tab
    return (
      <button
        key={t.id}
        onClick={() => onTab(t.id)}
        aria-label={t.label}
        className={`bottom-nav-item flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1 transition-colors ${active ? 'text-ink' : 'text-fog'}`}
        aria-current={active ? 'page' : undefined}
      >
        <t.Icon size={24} strokeWidth={active ? 2.2 : 1.8} />
        <span className="max-w-full whitespace-nowrap px-0.5 text-[10px] leading-tight font-medium">{t.id === 'planning' ? 'Планы' : t.label}</span>
      </button>
    )
  }
  return createPortal(
    <nav className="bottom-nav pointer-events-none fixed inset-0 z-40 flex items-end justify-center px-3">
      <div aria-hidden="true" className="bottom-nav-fade" />
      <div className="bottom-nav-surface pointer-events-auto relative mx-auto flex w-full max-w-[520px] shrink-0 items-stretch rounded-[28px] p-1">
        {TABS.map(item)}
      </div>
    </nav>, document.body
  )
}
