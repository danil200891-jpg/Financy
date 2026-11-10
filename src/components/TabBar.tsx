import { BarChart3, Clock3, House, Users } from 'lucide-react'

export type Tab = 'home' | 'history' | 'clients' | 'analytics'

const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: 'home', label: 'Главная', Icon: House },
  { id: 'history', label: 'История', Icon: Clock3 },
  { id: 'clients', label: 'Клиенты', Icon: Users },
  { id: 'analytics', label: 'Аналитика', Icon: BarChart3 },
]

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const item = (t: (typeof TABS)[number]) => {
    const active = t.id === tab
    return (
      <button
        key={t.id}
        onClick={() => onTab(t.id)}
        className={`press flex flex-1 flex-col items-center gap-1 pt-2 pb-1 transition-colors ${active ? 'text-ink' : 'text-fog'}`}
        aria-current={active ? 'page' : undefined}
      >
        <t.Icon size={24} strokeWidth={active ? 2.2 : 1.8} />
        <span className="text-[11px] font-medium">{t.label}</span>
      </button>
    )
  }
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(env(safe-area-inset-bottom),10px)]">
      <div className="glass-strong relative mx-auto flex max-w-[520px] items-end rounded-[28px] px-1 pb-1.5 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.8)]">
        {TABS.map(item)}
      </div>
    </nav>
  )
}
