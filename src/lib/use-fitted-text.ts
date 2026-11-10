import { useLayoutEffect, useRef } from 'react'

/** Keep a monetary summary readable on narrow cards without splitting its digits. */
export function useFittedText<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let lastWidth = 0
    let disposed = false
    const fit = () => {
      if (!element.clientWidth || element.clientWidth === lastWidth) return
      lastWidth = element.clientWidth
      element.style.fontSize = ''
      const base = parseFloat(getComputedStyle(element).fontSize)
      if (element.scrollWidth > element.clientWidth) element.style.fontSize = `${base * element.clientWidth / element.scrollWidth}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    void document.fonts.ready.then(() => { if (!disposed) { lastWidth = 0; fit() } })
    return () => { disposed = true; observer.disconnect() }
  }, [value])
  return ref
}
