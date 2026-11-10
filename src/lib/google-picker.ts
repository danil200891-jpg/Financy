import { GOOGLE_CLIENT_ID } from './google-auth'

export const PICKER_KEY = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined
const APP_ID = import.meta.env.VITE_GOOGLE_PROJECT_NUMBER || GOOGLE_CLIENT_ID?.split('-')[0]
interface PickerResult { action: string; docs?: { id: string }[] }
interface PickerView {
  setIncludeFolders(value: boolean): PickerView
  setSelectFolderEnabled(value: boolean): PickerView
  setMimeTypes(value: string): PickerView
  setMode(mode: string): PickerView
}
interface PickerBuilder {
  addView(view: PickerView): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setOrigin(origin: string): PickerBuilder
  setLocale(locale: string): PickerBuilder
  setTitle(title: string): PickerBuilder
  setCallback(callback: (data: PickerResult) => void): PickerBuilder
  build(): { setVisible(value: boolean): void }
}
interface PickerWindow {
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void }
  google?: { picker?: { DocsView: new () => PickerView; PickerBuilder: new () => PickerBuilder } }
}
let loading: Promise<void> | undefined
const globals = () => window as unknown as PickerWindow
const CONFIG_ERROR = 'Google Picker не открылся. В проекте financy-backup включите Google Picker API; в API restrictions ключа разрешите Google Picker API (одного Google Drive API недостаточно). В Website restrictions разрешите http://localhost:4173/*, https://danil200891-jpg.github.io/* и https://docs.google.com/*. API key и OAuth Client ID должны принадлежать одному проекту.'

export function loadPicker() {
  if (!PICKER_KEY || !APP_ID) return Promise.reject(new Error('Для выбора папки настройте Google Picker API key.'))
  if (globals().google?.picker) return Promise.resolve()
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true; clearTimeout(timer); loading = undefined; script.remove()
      reject(new Error(CONFIG_ERROR))
    }
    const timer = setTimeout(fail, 20000)
    const start = () => globals().gapi?.load('picker', {
      callback: () => { if (!globals().google?.picker) return fail(); settled = true; clearTimeout(timer); resolve() }, onerror: fail,
      timeout: 15000, ontimeout: () => { clearTimeout(timer); fail() },
    })
    const begin = () => { try { start() } catch { fail() } }
    if (globals().gapi) begin()
    else {
      script.src = 'https://apis.google.com/js/api.js'
      script.onload = begin
      script.onerror = () => { clearTimeout(timer); fail() }
      document.head.appendChild(script)
    }
  })
  return loading
}

export async function pickDriveFolder(token: string) {
  await loadPicker()
  const picker = globals().google!.picker!
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false
    let dialog: ReturnType<PickerBuilder['build']> | undefined
    const finish = (id?: string, error?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      try { dialog?.setVisible(false) } catch { /* Keep the result usable if Google's iframe has already closed. */ }
      if (error) reject(new Error(error))
      else resolve(id)
    }
    const timer = setTimeout(() => finish(undefined, 'Окно Google Picker не ответило. Закройте его и повторите выбор папки. Проверьте ограничения API key.'), 180000)
    try {
    const view = new picker.DocsView().setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setMode('list')
    dialog = new picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(PICKER_KEY!)
      .setAppId(APP_ID!).setOrigin(location.origin).setLocale('ru').setTitle('Выберите существующую папку Financy Backup').setCallback((result) => {
        if (result.action === 'picked') finish(result.docs?.[0]?.id)
        if (result.action === 'cancel') finish()
        if (result.action === 'error') finish(undefined, CONFIG_ERROR)
      }).build()
    if (settled) dialog.setVisible(false)
    else dialog.setVisible(true)
    } catch { finish(undefined, CONFIG_ERROR) }
  })
}
