import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { actions, initStore, waitForWrites } from './lib/store'
import { toast } from './lib/toast'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { offerUpdate, setUpdateInstaller, watchUpdates } from './lib/updates'
import { initSync } from './lib/sync'

type Boot = { stage: (s: string) => void; done: () => void; fail: (title: string, err: unknown) => void }
const boot = (window as unknown as { __boot?: Boot }).__boot
boot?.stage('js-loaded')

// Service worker is optional: on an untrusted (self-signed) certificate iOS refuses it,
// and that must never stop the app from starting.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      const update = registerSW({
        immediate: true,
        onNeedRefresh: offerUpdate,
        onOfflineReady: () => toast('Готово к работе без интернета'),
        onRegisteredSW: (_url, reg) => { if (reg) watchUpdates(reg) },
        onRegisterError: (e) => console.warn('SW registration failed', e),
      })
      setUpdateInstaller(() => update(true))
    })
    .catch((e) => console.warn('SW unavailable', e))
}

if (import.meta.env.DEV) {
  // dev-only test hook (stripped from production builds)
  Promise.all([import('./lib/store'), import('./lib/backup')]).then(([store, backup]) => {
    ;(window as unknown as Record<string, unknown>).__finance = { ...store, backup }
  })
}

const root = createRoot(document.getElementById('root')!)
boot?.stage('opening-storage')

Promise.race([
  initStore(),
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Хранилище не ответило за 12 секунд')), 12000)),
])
  .then(() => {
    let calendarDay = new Date().toDateString()
    const refreshData = () => {
      if (document.visibilityState !== 'visible') return
      calendarDay = new Date().toDateString()
      void waitForWrites().then(() => actions.reload()).catch(() => {})
    }
    document.addEventListener('visibilitychange', refreshData)
    setInterval(() => { if (calendarDay !== new Date().toDateString()) refreshData() }, 60000)
    void initSync().catch((e) => console.warn('sync unavailable', e))
    boot?.stage('rendering')
    root.render(
      <StrictMode>
        <AppErrorBoundary><App /></AppErrorBoundary>
      </StrictMode>,
    )
    boot?.done()
  })
  .catch((e) => {
    console.error(e)
    boot?.fail('Не удалось открыть хранилище на устройстве', e)
  })
