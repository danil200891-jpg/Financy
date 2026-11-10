const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_NAME = 'Financy Backup'
const MARKER = 'financy-backup-v1'

export interface DriveFile {
  id: string
  name: string
  modifiedTime?: string
  size?: string
  mimeType?: string
  trashed?: boolean
  appProperties?: Record<string, string>
}

export class DriveError extends Error {
  constructor(message: string, public status = 0) { super(message) }
}

/** Session-bound client. Credentials are passed only through the Authorization header. */
export class DriveClient {
  constructor(private token: string, private signal: AbortSignal) {}

  private async request(url: string, init: RequestInit = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.signal.addEventListener('abort', abort, { once: true })
    if (this.signal.aborted) controller.abort()
    const timer = setTimeout(abort, 30000)
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      })
      if (!response.ok) {
        if (response.status === 401) throw new DriveError('Срок доступа истёк. Подключите Google Drive повторно.', 401)
        if (response.status === 403) throw new DriveError('Google Drive отклонил запрос. Проверьте разрешение drive.file и свободное место.', 403)
        throw new DriveError(`Ошибка Google Drive (${response.status}). Повторите попытку.`, response.status)
      }
      // Keep timeout/disconnect cancellation active until the response body is read.
      const body = response.status === 204 ? null : await response.arrayBuffer()
      return new Response(body, { status: response.status, headers: response.headers })
    } catch (error) {
      if (error instanceof DriveError) throw error
      throw new DriveError('Не удалось связаться с Google Drive. Проверьте интернет и повторите попытку.')
    } finally {
      clearTimeout(timer)
      this.signal.removeEventListener('abort', abort)
    }
  }

  async account() {
    const response = await this.request(`${API}/about?fields=user(permissionId)`)
    const data = await response.json() as { user?: { permissionId?: string } }
    if (!data.user?.permissionId) throw new DriveError('Не удалось определить аккаунт Google Drive.')
    return data.user.permissionId
  }

  private async list(q: string) {
    const files: DriveFile[] = []
    let pageToken = ''
    do {
      const query = new URLSearchParams({
        q, spaces: 'drive', pageSize: '100', fields: 'nextPageToken,files(id,name,modifiedTime,size,mimeType,trashed,appProperties)',
        orderBy: 'modifiedTime desc',
      })
      if (pageToken) query.set('pageToken', pageToken)
      const response = await this.request(`${API}/files?${query}`)
      const data = await response.json() as { files?: DriveFile[]; nextPageToken?: string }
      files.push(...data.files ?? [])
      pageToken = data.nextPageToken ?? ''
    } while (pageToken)
    return files
  }

  async folders() {
    return this.list(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${FOLDER_NAME}'`)
  }

  async backups() {
    const files = await this.list(`trashed = false and mimeType = 'application/json' and appProperties has { key='financy' and value='${MARKER}' }`)
    return files.filter((file) => Number(file.size) > 0)
  }

  async generatedId() {
    const response = await this.request(`${API}/files/generateIds?count=1&space=drive&type=files`)
    const data = await response.json() as { ids?: string[] }
    if (!data.ids?.[0]) throw new DriveError('Не удалось подготовить файл Google Drive.')
    return data.ids[0]
  }

  async file(id: string) {
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,appProperties`)
    return response.json() as Promise<DriveFile>
  }

  async createFolder(id: string) {
    try {
      await this.request(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      })
    } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 409) throw error
      const file = await this.file(id)
      if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || file.name !== FOLDER_NAME) throw new DriveError('Папка резервных копий недоступна.')
    }
  }

  async upload(id: string, folderId: string, deviceId: string, json: string) {
    let existing: DriveFile | undefined
    try { existing = await this.file(id) } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 404) throw error
    }
    if (existing && (existing.trashed || existing.appProperties?.financy !== MARKER || existing.appProperties?.device !== deviceId)) {
      throw new DriveError('Файл резервной копии недоступен. Существующие файлы не изменены.')
    }
    const boundary = `financy-${Date.now().toString(36)}`
    const metadata = existing
      ? { mimeType: 'application/json' }
      : { id, name: `financy-backup-${deviceId}.json`, parents: [folderId], mimeType: 'application/json', appProperties: { financy: MARKER, device: deviceId } }
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`, json, `\r\n--${boundary}--`,
    ])
    if (body.size > 5 * 1024 * 1024) {
      const response = await this.request(`${UPLOAD}/files${existing ? `/${encodeURIComponent(id)}` : ''}?uploadType=resumable&fields=id`, {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      })
      const location = response.headers.get('Location')
      if (!location || !location.startsWith(`${UPLOAD}/files`)) throw new DriveError('Google Drive не выдал адрес загрузки.')
      await this.request(location, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json })
      return
    }
    await this.request(`${UPLOAD}/files${existing ? `/${encodeURIComponent(id)}` : ''}?uploadType=multipart&fields=id`, {
      method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })
  }

  async download(id: string) {
    const file = await this.file(id)
    if (file.trashed || file.appProperties?.financy !== MARKER || file.mimeType !== 'application/json') {
      throw new DriveError('Выбранный файл не является резервной копией Financy.')
    }
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)
    return response.text()
  }
}
