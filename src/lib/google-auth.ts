export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export function driveOriginError(origin = location.origin) {
  const url = new URL(origin)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined
  if (url.protocol !== 'https:' || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) {
    return 'Google OAuth не поддерживает этот локальный IP. На компьютере откройте http://localhost:4173/Financy/. На iPhone нужен HTTPS-домен, добавленный в Authorized JavaScript origins; данные по разным адресам хранятся отдельно.'
  }
}

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
}

interface TokenClient {
  requestAccessToken(options: { prompt: string }): void
}

interface GoogleIdentity {
  accounts: { oauth2: {
    initTokenClient(options: {
      client_id: string
      scope: string
      include_granted_scopes: boolean
      callback: (response: TokenResponse) => void
      error_callback: () => void
    }): TokenClient
  } }
}

export function identity() {
  const google = (window as unknown as { google?: GoogleIdentity }).google
  return google?.accounts?.oauth2 ? google : undefined
}

let loading: Promise<void> | undefined

export function loadGoogleIdentity() {
  const originError = driveOriginError()
  if (originError) return Promise.reject(new Error(originError))
  if (identity()) return Promise.resolve()
  if (!GOOGLE_CLIENT_ID) return Promise.reject(new Error('Не настроен Google OAuth Client ID.'))
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timer = setTimeout(() => fail(), 20000)
    const fail = () => {
      clearTimeout(timer)
      script.remove()
      loading = undefined
      reject(new Error('Не загрузился Google OAuth. Проверьте интернет и попробуйте снова.'))
    }
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => {
      if (!identity()) return fail()
      clearTimeout(timer)
      resolve()
    }
    script.onerror = fail
    document.head.appendChild(script)
  })
  return loading
}

/** Called directly by a button after the SDK has loaded, preserving the iOS gesture. */
export function requestDriveAccess(): Promise<{ token: string; expiresAt: number }> {
  const originError = driveOriginError()
  if (originError) return Promise.reject(new Error(originError))
  const google = identity()
  if (!google || !GOOGLE_CLIENT_ID) return Promise.reject(new Error('Подождите загрузки Google OAuth.'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: string, access?: { token: string; expiresAt: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (access) resolve(access)
      else reject(new Error(error))
    }
    const timer = setTimeout(() => finish('Google не ответил. Закройте окно входа и подключитесь повторно.'), 120000)
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      include_granted_scopes: false,
      callback: (response) => {
        if (response.error || !response.access_token || !response.scope?.split(' ').includes(DRIVE_SCOPE)) {
          finish('Доступ к Google Drive не предоставлен. Подключите его повторно.')
          return
        }
        const lifetime = Number(response.expires_in ?? 0)
        if (!Number.isFinite(lifetime) || lifetime <= 30) {
          finish('Google не выдал действующий доступ. Повторите подключение.')
          return
        }
        finish(undefined, { token: response.access_token, expiresAt: Date.now() + lifetime * 1000 })
      },
      error_callback: () => finish('Окно Google закрыто или заблокировано. Разрешите popup для этого HTTPS-сайта в Safari и повторите подключение.'),
    })
    client.requestAccessToken({ prompt: 'select_account' })
  })
}
