import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

let current: Toast | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const ls = new Set<() => void>()
const emit = () => ls.forEach((l) => l())

/** `ms = 0` keeps the toast until the user acts (used for "new version available"). */
export function toast(text: string, action?: Toast['action'], ms = action ? 5000 : 2600) {
  current = { id: Date.now(), text, action }
  clearTimeout(timer)
  if (ms > 0) timer = setTimeout(() => { current = null; emit() }, ms)
  emit()
}

export function dismissToast() {
  current = null
  emit()
}

export const useToast = () =>
  useSyncExternalStore(
    (l) => { ls.add(l); return () => ls.delete(l) },
    () => current,
  )
