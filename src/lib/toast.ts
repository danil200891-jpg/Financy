import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void | boolean | Promise<void | boolean> }
}

let current: Toast | null = null
let persistent: Toast | null = null
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const ls = new Set<() => void>()
const emit = () => ls.forEach((l) => l())

/** `ms = 0` keeps the toast until the user acts (used for "new version available"). */
export function toast(text: string, action?: Toast['action'], ms = action ? 5000 : 2600) {
  current = { id: ++sequence, text, action }
  if (ms === 0) persistent = current
  clearTimeout(timer)
  if (ms > 0) timer = setTimeout(() => { current = persistent; emit() }, ms)
  emit()
}

export function dismissToast(id = current?.id) {
  if (persistent?.id === id) persistent = null
  if (current?.id === id) current = persistent
  emit()
}

export const useToast = () =>
  useSyncExternalStore(
    (l) => { ls.add(l); return () => ls.delete(l) },
    () => current,
  )
