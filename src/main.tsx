import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { actions, initStore, waitForWrites } from './lib/store'
import { toast } from './lib/toast'
import { AppErrorBoundary } from './components/AppErrorBoundary'
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
        // new version downloaded in the background → ask; data in IndexedDB is not affected
        onNeedRefresh: () => toast('Доступна новая версия', { label: 'Обновить', run: async () => {
          if (document.querySelector('[role="dialog"]') && !window.confirm('Открыта форма. Обновление закроет её без сохранения незавершённого ввода. Обновить сейчас?')) return false
          await waitForWrites()
          await update(true)
        } }, 0),
        onOfflineReady: () => toast('Готово к работе без интернета'),
        onRegisteredSW: (_url, reg) => {
          if (!reg) return
          // installed iPhone apps can stay open for days: check for updates hourly and when reopened
          setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000)
          document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}))
        },
        onRegisterError: (e) => console.warn('SW registration failed', e),
      })
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
