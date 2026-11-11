import { useEffect, useRef } from 'react'

/** One-shot arrival for newly visible cards/rows; never delays native scrolling. */
export function useScrollReveal(screen: string) {
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    const container = root.current, motion = matchMedia('(prefers-reduced-motion: reduce)')
    if (!container || motion.matches || !('IntersectionObserver' in window)) return
    const seen = new WeakSet<HTMLElement>(), pending = new Set<HTMLElement>()
    const visibleBottom = document.querySelector('.bottom-nav-surface')?.getBoundingClientRect().top ?? innerHeight
    const coveredBottom = Math.max(0, innerHeight - visibleBottom)
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target as HTMLElement
        element.dataset.scrollReveal = 'arriving'
        pending.delete(element); observer.unobserve(element)
      }
    }, { rootMargin: `0px 0px -${coveredBottom}px 0px`, threshold: 0.01 })
    const collect = (node: HTMLElement) => {
      const elements = [...(node.matches('[data-scroll-reveal]') ? [node] : []), ...node.querySelectorAll<HTMLElement>('[data-scroll-reveal]')]
      for (const element of elements) {
        if (seen.has(element)) continue
        seen.add(element)
        if (motion.matches || element.closest('[role="dialog"]') || element.querySelector('[data-scroll-reveal]') || [...element.querySelectorAll('input,textarea,select')].some((input) => getComputedStyle(input).visibility !== 'hidden')) continue
        if (element.getBoundingClientRect().top < visibleBottom) continue
        element.dataset.scrollReveal = 'pending'; pending.add(element); observer.observe(element)
      }
    }
    collect(container)
    const mutations = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) collect(node)
    })
    mutations.observe(container, { childList: true, subtree: true })
    const disable = () => {
      if (!motion.matches) return
      observer.disconnect(); pending.forEach((element) => { element.dataset.scrollReveal = '' }); pending.clear()
      container.querySelectorAll<HTMLElement>('[data-scroll-reveal="arriving"]').forEach((element) => { element.dataset.scrollReveal = '' })
    }
    motion.addEventListener('change', disable)
    return () => { mutations.disconnect(); observer.disconnect(); pending.forEach((element) => { element.dataset.scrollReveal = '' }); motion.removeEventListener('change', disable) }
  }, [screen])
  return root
}
