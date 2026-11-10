import { BarChart3, Clock3, House, Plus, Users } from 'lucide-react'

export type Tab = 'home' | 'history' | 'clients' | 'analytics'

const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: 'home', label: 'Главная', Icon: House },
  { id: 'history', label: 'История', Icon: Clock3 },
  { id: 'clients', label: 'Клиенты', Icon: Users },
  { id: 'analytics', label: 'Аналитика', Icon: BarChart3 },
]

export function TabBar({ tab, onTab, onAdd }: { tab: Tab; onTab: (t: Tab) => void; onAdd: () => void }) {
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
        {TABS.slice(0, 2).map(item)}
        <div className="flex w-[76px] shrink-0 justify-center">
          <button
            onClick={onAdd}
            aria-label="Добавить операцию"
            className="press -mt-7 mb-1 grid h-[62px] w-[62px] place-items-center rounded-[22px] bg-[linear-gradient(135deg,#7c8cff,#9f6bff_55%,#3fe0c5)] text-white shadow-[0_12px_30px_-6px_rgba(124,140,255,0.75),inset_0_1px_0_rgba(255,255,255,0.35)]"
          >
            <Plus size={30} strokeWidth={2.4} />
          </button>
        </div>
        {TABS.slice(2).map(item)}
      </div>
    </nav>
  )
}
