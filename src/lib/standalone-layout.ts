/** Keep installed PWA root scroll bounds independent of the selected screen. */
export function initStandaloneLayout() {
  const mode = matchMedia('(display-mode: standalone)')
  const update = () => document.documentElement.classList.toggle('standalone-app', mode.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)
  update()
  mode.addEventListener('change', update)
  return () => { mode.removeEventListener('change', update); document.documentElement.classList.remove('standalone-app') }
}
