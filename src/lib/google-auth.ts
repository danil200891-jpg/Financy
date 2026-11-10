export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

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
  return (window as unknown as { google?: GoogleIdentity }).google
}

let loading: Promise<void> | undefined

export function loadGoogleIdentity() {
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
  const google = identity()
  if (!google || !GOOGLE_CLIENT_ID) return Promise.reject(new Error('Подождите загрузки Google OAuth.'))
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      include_granted_scopes: false,
      callback: (response) => {
        if (response.error || !response.access_token || !response.scope?.split(' ').includes(DRIVE_SCOPE)) {
          reject(new Error('Доступ к Google Drive не предоставлен. Подключите его повторно.'))
          return
        }
        const lifetime = Number(response.expires_in ?? 0)
        if (!Number.isFinite(lifetime) || lifetime <= 30) {
          reject(new Error('Google не выдал действующий доступ. Повторите подключение.'))
          return
        }
        resolve({ token: response.access_token, expiresAt: Date.now() + lifetime * 1000 })
      },
      error_callback: () => reject(new Error('Окно Google закрыто или заблокировано. Повторите подключение.')),
    })
    client.requestAccessToken({ prompt: 'select_account' })
  })
}
