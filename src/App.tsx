import { useState } from 'react'
import { TabBar, type Tab } from './components/TabBar'
import { Home } from './screens/Home'
import { History } from './screens/History'
import { Clients } from './screens/Clients'
import { ClientDetail } from './screens/ClientDetail'
import { Analytics } from './screens/Analytics'
import { Settings } from './screens/Settings'
import { AddSheet, type AddMode } from './screens/AddSheet'
import { EditSheet } from './screens/EditSheet'
import { dismissToast, useToast } from './lib/toast'

export interface Nav {
  openAdd: (mode?: AddMode) => void
  openEdit: (opId: string) => void
  openClient: (id: string) => void
  openSettings: () => void
  goTab: (t: Tab) => void
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [add, setAdd] = useState<AddMode | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [clientId, setClientId] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)

  const nav: Nav = {
    openAdd: (m = 'text') => {
      setAdd(m)
      // Keep the native file picker in the original user gesture on iOS.
      if (m === 'upload') (document.getElementById('receipt-image-input') as HTMLInputElement | null)?.click()
    },
    openEdit: setEditId,
    openClient: setClientId,
    openSettings: () => setSettings(true),
    goTab: (t) => { setTab(t); window.scrollTo({ top: 0 }) },
  }

  return (
    <div className="mx-auto min-h-full max-w-[520px] pb-[calc(env(safe-area-inset-bottom)+110px)]">
      {/* status-bar blur so content never collides with the notch / Dynamic Island */}
      <div className="fixed inset-x-0 top-0 z-30 h-[env(safe-area-inset-top)] bg-abyss/75 backdrop-blur-xl" />
      <main key={tab} className="anim-screen">
        {tab === 'home' && <Home nav={nav} />}
        {tab === 'history' && <History nav={nav} />}
        {tab === 'clients' && <Clients nav={nav} />}
        {tab === 'analytics' && <Analytics nav={nav} />}
      </main>

      <TabBar tab={tab} onTab={nav.goTab} onAdd={() => nav.openAdd('text')} />

      {clientId && <ClientDetail id={clientId} nav={nav} onBack={() => setClientId(null)} />}
      {settings && <Settings onBack={() => setSettings(false)} />}

      <AddSheet mode={add} onMode={setAdd} onClose={() => setAdd(null)} />
      <EditSheet id={editId} onClose={() => setEditId(null)} />
      <Toaster />
    </div>
  )
}

function Toaster() {
  const t = useToast()
  if (!t) return null
  return (
    <div key={t.id} role="status" className="anim-fade glass-strong fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+100px)] z-[80] mx-auto flex max-w-[480px] items-center gap-3 rounded-2xl py-2 pr-2 pl-4 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.8)]">
      <p className="flex-1 py-1.5 text-[15px]">{t.text}</p>
      {t.action && (
        <button onClick={async () => {
          try { if (await t.action!.run() !== false) dismissToast(t.id) }
          catch { /* A failed action leaves its prompt available for retry. */ }
        }} className="press rounded-xl bg-white/10 px-3.5 py-2 text-[15px] font-semibold text-iris">
          {t.action.label}
        </button>
      )}
    </div>
  )
}
