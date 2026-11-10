const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_NAME = 'Financy Backup'
export const FOLDER_ID = '13nWwLQw-6-Czl2rc75a4NwKnmIp00sp5'
const MARKER = 'financy-backup-v1'

export interface DriveFile {
  id: string
  name: string
  modifiedTime?: string
  size?: string
  mimeType?: string
  trashed?: boolean
  appProperties?: Record<string, string>
  parents?: string[]
  headRevisionId?: string
  version?: string
  etag?: string
  revisionId?: string
  capabilities?: { canAddChildren?: boolean }
}

export interface DriveRevision {
  id: string
  modifiedTime?: string
  keepForever?: boolean
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
        q, spaces: 'drive', pageSize: '100', fields: 'nextPageToken,files(id,name,modifiedTime,size,mimeType,trashed,appProperties,parents,headRevisionId,version)',
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

  async backups(folderId = FOLDER_ID) {
    if (folderId !== FOLDER_ID) throw new DriveError('Разрешена только указанная папка Financy Backup.')
    const parent = folderId ? ` and '${folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents` : ''
    const files = await this.list(`trashed = false and mimeType = 'application/json' and appProperties has { key='financy' and value='${MARKER}' }${parent}`)
    return files.filter((file) => Number(file.size) > 0)
  }

  async generatedId() {
    const response = await this.request(`${API}/files/generateIds?count=1&space=drive&type=files`)
    const data = await response.json() as { ids?: string[] }
    if (!data.ids?.[0]) throw new DriveError('Не удалось подготовить файл Google Drive.')
    return data.ids[0]
  }

  async file(id: string) {
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id,name,size,modifiedTime,mimeType,trashed,appProperties,parents,headRevisionId,version,capabilities(canAddChildren)`)
    return { ...await response.json() as DriveFile, etag: response.headers.get('ETag') ?? undefined }
  }

  async markFolder(id: string) {
    if (id !== FOLDER_ID) throw new DriveError('Выберите именно указанную папку Financy Backup. Другие папки не используются.')
    const folder = await this.file(id)
    if (folder.trashed || folder.name !== FOLDER_NAME || folder.mimeType !== 'application/vnd.google-apps.folder') throw new DriveError('Выберите папку с названием Financy Backup.')
    await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { ...folder.appProperties, financyRoot: MARKER } }),
    })
  }

  async upload(id: string, folderId: string, deviceId: string, json: string, expectedHead?: string, day?: string) {
    if (folderId !== FOLDER_ID || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DriveError('Не задана постоянная папка или день резервной копии.')
    let existing: DriveFile | undefined
    try { existing = await this.file(id) } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 404) throw error
    }
    if (existing && (existing.trashed || existing.appProperties?.financy !== MARKER || existing.appProperties.role !== 'daily' || existing.appProperties.day !== day || !existing.parents?.includes(folderId))) {
      throw new DriveError('Файл резервной копии недоступен. Существующие файлы не изменены.')
    }
    if (existing && expectedHead && existing.headRevisionId !== expectedHead) throw new DriveError('Копия в Drive изменилась. Сначала объедините её с локальными данными.', 412)
    const conditional: Record<string, string> = existing?.etag ? { 'If-Match': existing.etag } : {}
    const boundary = `financy-${Date.now().toString(36)}`
    const metadata = existing
      ? { mimeType: 'application/json', appProperties: { ...existing.appProperties, role: 'daily', day } }
      : { id, name: `financy-backup-${day}.json`, parents: [folderId], mimeType: 'application/json', appProperties: { financy: MARKER, device: deviceId, role: 'daily', day } }
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`, json, `\r\n--${boundary}--`,
    ])
    if (body.size > 5 * 1024 * 1024) {
      const response = await this.request(`${UPLOAD}/files${existing ? `/${encodeURIComponent(id)}` : ''}?uploadType=resumable&fields=id,headRevisionId`, {
        method: existing ? 'PATCH' : 'POST',
        headers: { ...conditional, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      })
      const location = response.headers.get('Location')
      if (!location || !location.startsWith(`${UPLOAD}/files`)) throw new DriveError('Google Drive не выдал адрес загрузки.')
      await this.request(location, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json })
      return this.file(id)
    }
    await this.request(`${UPLOAD}/files${existing ? `/${encodeURIComponent(id)}` : ''}?uploadType=multipart&fields=id,headRevisionId`, {
      method: existing ? 'PATCH' : 'POST', headers: { ...conditional, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })
    return this.file(id)
  }

  async revisions(fileId: string) {
    const revisions: DriveRevision[] = []
    let pageToken = ''
    do {
      const query = new URLSearchParams({ pageSize: '1000', fields: 'nextPageToken,revisions(id,modifiedTime,keepForever)' })
      if (pageToken) query.set('pageToken', pageToken)
      const response = await this.request(`${API}/files/${encodeURIComponent(fileId)}/revisions?${query}`)
      const data = await response.json() as { revisions?: DriveRevision[]; nextPageToken?: string }
      revisions.push(...data.revisions ?? [])
      pageToken = data.nextPageToken ?? ''
    } while (pageToken)
    return revisions.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '') || a.id.localeCompare(b.id))
  }

  async revisionText(fileId: string, revisionId: string) {
    const path = `${API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`
    await this.request(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepForever: true }) })
    return (await this.request(`${path}?alt=media`)).text()
  }

  async deleteRevision(fileId: string, revisionId: string) {
    await this.request(`${API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { method: 'DELETE' })
  }

  async download(id: string) {
    const file = await this.file(id)
    if (file.trashed || file.appProperties?.financy !== MARKER || file.mimeType !== 'application/json' || !file.parents?.includes(FOLDER_ID)) {
      throw new DriveError('Выбранный файл не является резервной копией Financy.')
    }
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)
    return response.text()
  }

  /** Retention is reversible and can only touch a verified app-owned daily file. */
  async trashDaily(file: DriveFile, cutoff: string) {
    const current = await this.file(file.id)
    const day = current.appProperties?.day
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff || current.trashed ||
      current.appProperties?.financy !== MARKER || current.appProperties.role !== 'daily' ||
      !current.parents?.includes(FOLDER_ID) || current.headRevisionId !== file.headRevisionId || current.version !== file.version) {
      throw new DriveError('Старая копия изменилась или не прошла проверку. Она сохранена.')
    }
    await this.request(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(current.etag ? { 'If-Match': current.etag } : {}) },
      body: JSON.stringify({ trashed: true }),
    })
  }
}
