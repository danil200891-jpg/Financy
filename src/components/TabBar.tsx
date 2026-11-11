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
        className={`bottom-nav-item flex min-h-[64px] min-w-0 flex-1 flex-col items-center gap-1 pt-2 pb-1 transition-colors ${active ? 'text-ink' : 'text-fog'}`}
        aria-current={active ? 'page' : undefined}
      >
        <t.Icon size={24} strokeWidth={active ? 2.2 : 1.8} />
        <span className="max-w-full whitespace-nowrap px-0.5 text-[10px] leading-tight font-medium">{t.id === 'planning' ? 'Планы' : t.label}</span>
      </button>
    )
  }
  return createPortal(
    <nav className="bottom-nav fixed inset-x-0 bottom-0 z-40 px-3">
      <div className="glass-strong bottom-nav-surface relative mx-auto flex max-w-[520px] items-end rounded-[28px] px-1 pb-1.5">
        {TABS.map(item)}
      </div>
    </nav>, document.body
  )
}
