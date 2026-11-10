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
  setCallback(callback: (data: PickerResult) => void): PickerBuilder
  build(): { setVisible(value: boolean): void }
}
interface PickerWindow {
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void }
  google?: { picker?: { DocsView: new () => PickerView; PickerBuilder: new () => PickerBuilder } }
}
let loading: Promise<void> | undefined
const globals = () => window as unknown as PickerWindow

export function loadPicker() {
  if (!PICKER_KEY || !APP_ID) return Promise.reject(new Error('Для выбора папки настройте Google Picker API key.'))
  if (globals().google?.picker) return Promise.resolve()
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => { loading = undefined; script.remove(); reject(new Error('Не загрузился Google Picker. Проверьте интернет и API key.')) }
    const timer = setTimeout(fail, 20000)
    const start = () => globals().gapi?.load('picker', {
      callback: () => { clearTimeout(timer); resolve() }, onerror: () => { clearTimeout(timer); fail() },
      timeout: 15000, ontimeout: () => { clearTimeout(timer); fail() },
    })
    if (globals().gapi) start()
    else {
      script.src = 'https://apis.google.com/js/api.js'
      script.onload = start
      script.onerror = () => { clearTimeout(timer); fail() }
      document.head.appendChild(script)
    }
  })
  return loading
}

export async function pickDriveFolder(token: string) {
  await loadPicker()
  const picker = globals().google!.picker!
  return new Promise<string | undefined>((resolve) => {
    const view = new picker.DocsView().setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setMode('list')
    const dialog = new picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(PICKER_KEY!)
      .setAppId(APP_ID!).setOrigin(location.origin).setLocale('ru').setCallback((result) => {
        if (result.action === 'picked') resolve(result.docs?.[0]?.id)
        if (result.action === 'cancel') resolve(undefined)
      }).build()
    dialog.setVisible(true)
  })
}
