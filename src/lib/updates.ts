import { useSyncExternalStore } from 'react'
import { waitForWrites } from './store'
import { toast } from './toast'

type UpdateState = { available: boolean; checking: boolean; applying: boolean; error: string | null }
let state: UpdateState = { available: false, checking: false, applying: false, error: null }
let registration: ServiceWorkerRegistration | undefined
let install: (() => Promise<void>) | undefined
let checking: Promise<void> | undefined
let lastCheck = 0
let listening = false
const listeners = new Set<() => void>()
const patch = (next: Partial<UpdateState>) => { state = { ...state, ...next }; listeners.forEach((l) => l()) }
export const useAppUpdate = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state)

export function offerUpdate() {
  patch({ available: true, error: null })
  toast('Доступна новая версия', { label: 'Обновить', run: applyUpdate }, 0)
}

/** No automatic reload: only an explicit user action can activate a waiting worker. */
export async function applyUpdate() {
  if (state.applying || !state.available || !install) return false
  if ((document.querySelector('[role="dialog"]') || document.querySelector('[data-pending-input="true"]')) && !window.confirm('Открыта форма. Обновление закроет её без сохранения незавершённого ввода. Обновить сейчас?')) return false
  patch({ applying: true, error: null })
  try {
    await waitForWrites()
    await install()
    // Workbox reloads once on controllerchange. If activation stalls, allow a deliberate retry.
    setTimeout(() => { patch({ applying: false, error: 'Обновление ещё не завершено. Проверьте подключение и повторите.' }) }, 15000)
  } catch {
    patch({ applying: false, error: 'Не удалось обновить приложение. Данные сохранены. Повторите позже.' })
    toast(state.error!)
  }
  return false
}

export function checkForUpdate(manual = false): Promise<void> {
  if (checking) return checking
  if (manual && !navigator.onLine) { patch({ error: 'Нет интернета. Проверим обновление после подключения.' }); return Promise.resolve() }
  if (manual && !registration) { patch({ error: 'Проверка обновлений пока недоступна. Повторите после запуска с интернетом.' }); return Promise.resolve() }
  if (!registration || (!manual && (document.visibilityState !== 'visible' || Date.now() - lastCheck < 15000))) return Promise.resolve()
  lastCheck = Date.now()
  patch({ checking: true, error: null })
  checking = registration.update().then(() => {
    if (registration?.waiting) offerUpdate()
  }).catch(() => {
    patch({ error: 'Не удалось проверить обновление. Повторим при подключении.' })
  }).finally(() => { checking = undefined; patch({ checking: false }) })
  return checking
}

export function setUpdateInstaller(activate: () => Promise<void>) { install = activate }
export function watchUpdates(reg: ServiceWorkerRegistration) {
  registration = reg
  if (reg.waiting) offerUpdate()
  void checkForUpdate(true)
  if (listening) return
  listening = true
  // iOS only runs these checks while the app is open or comes to the foreground.
  document.addEventListener('visibilitychange', () => { void checkForUpdate() })
  window.addEventListener('pageshow', () => { void checkForUpdate() })
  window.addEventListener('online', () => { void checkForUpdate(true) })
  setInterval(() => { void checkForUpdate() }, 60 * 60 * 1000)
}
