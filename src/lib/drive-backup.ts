import { useSyncExternalStore } from 'react'
import { buildBackup, parseBackup } from './backup'
import { db, onDataChanged, setMeta } from './db'
import { DriveClient, DriveError, FOLDER_ID, FOLDER_NAME, type DriveFile } from './google-drive'
import { GOOGLE_CLIENT_ID, loadGoogleIdentity, requestDriveAccess } from './google-auth'
import { pickDriveFolder } from './google-picker'

interface AccountBackup {
  folderId?: string
  fileId?: string
  digest?: string
  lastSuccess?: string
  folderPending?: boolean
  filePending?: boolean
  headRevision?: string
  day?: string
  cleanupPending?: boolean
}

interface DriveState {
  enabled: boolean
  ready: boolean
  connected: boolean
  busy: boolean
  lastSuccess?: string
  error?: string
  folderId?: string
  folderRequired?: boolean
  reviewRequired?: boolean
}

let state: DriveState = { enabled: false, ready: false, connected: false, busy: false }
const listeners = new Set<() => void>()
const update = (patch: Partial<DriveState>) => {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useDriveBackup() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => state)
}

let credentials: { token: string; expiresAt: number } | undefined
let controller = new AbortController()
let accountId = ''
let deviceId = ''
let generation = 0
let running = false
let changedDuringSave = false
let paused = false
let timer: ReturnType<typeof setTimeout> | undefined
let retryDelay = 5000
let initialized: Promise<void> | undefined
let reviewedFile: DriveFile | undefined
const owner = randomId()

/** Local calendar days, with UTC arithmetic to avoid DST-length-day errors. */
export function backupDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function retentionCutoff(day: string) {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 29)
  return date.toISOString().slice(0, 10)
}

async function snapshotDigest(backup: Awaited<ReturnType<typeof buildBackup>>) {
  const { exportedAt: _exportedAt, ...data } = backup
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const daily = (file: DriveFile, day: string) => !file.trashed && file.appProperties?.role === 'daily' && file.appProperties.day === day && file.parents?.includes(FOLDER_ID)

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function accountKey() { return `driveBackup:account:${accountId}` }

async function accountSettings(): Promise<AccountBackup> {
  return await (await db()).get('meta', accountKey()) as AccountBackup | undefined ?? {}
}

function client() {
  if (!credentials || credentials.expiresAt <= Date.now() + 30000) {
    credentials = undefined
    update({ connected: false, error: 'Подключите Google Drive повторно, чтобы продолжить резервное копирование.' })
    throw new DriveError('Требуется повторное подключение Google Drive.', 401)
  }
  return new DriveClient(credentials.token, controller.signal)
}

function report(error: unknown) {
  // Never display/log raw OAuth responses, HTTP bodies, tokens or financial data.
  update({ error: error instanceof Error ? error.message : 'Не удалось сохранить копию в Google Drive.' })
  if (error instanceof DriveError && error.status === 401) {
    credentials = undefined
    update({ connected: false })
  }
}

function schedule(delay = 5000) {
  clearTimeout(timer)
  if (!state.enabled || !credentials || paused) return
  timer = setTimeout(() => { timer = undefined; void saveDriveBackup() }, delay)
}

/** Lease in existing meta store coordinates tabs even on Safari without Web Locks. */
async function lease(acquire: boolean) {
  const tx = (await db()).transaction('meta', 'readwrite')
  const current = await tx.store.get('driveBackup:lease') as { owner: string; until: number } | undefined
  let acquired = false
  if (acquire && (!current || current.owner === owner || current.until < Date.now())) {
    await tx.store.put({ owner, until: Date.now() + 300000 }, 'driveBackup:lease')
    acquired = true
  } else if (!acquire && current?.owner === owner) {
    await tx.store.delete('driveBackup:lease')
  }
  await tx.done
  return acquired
}

export function initDriveBackup() {
  if (!initialized) initialized = (async () => {
    const d = await db()
    const tx = d.transaction('meta', 'readwrite')
    deviceId = await tx.store.get('driveBackup:device') as string ?? randomId()
    await tx.store.put(deviceId, 'driveBackup:device')
    await tx.done
    const enabled = await d.get('meta', 'driveBackup:enabled') === true
    const lastSuccess = await d.get('meta', 'driveBackup:lastSuccess') as string | undefined
    update({ enabled, lastSuccess })
    onDataChanged(() => {
      if (running) changedDuringSave = true
      schedule()
    })
    window.addEventListener('online', () => schedule(500))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule(500)
    })
    // Also discovers committed changes made in another tab; unchanged snapshots never upload.
    setInterval(() => {
      if (document.visibilityState === 'visible' && !running && !timer) schedule(500)
    }, 30000)
  })()
  return initialized
}

export async function prepareDrive() {
  try {
    await initDriveBackup()
    await loadGoogleIdentity()
    update({ ready: true })
  } catch (error) { report(error) }
}

export function connectDrive() {
  if (state.busy) return
  // This call must precede any await so Safari allows the OAuth popup.
  const access = requestDriveAccess()
  const session = ++generation
  update({ busy: true, error: undefined })
  void (async () => {
    try {
      const nextCredentials = await access
      if (session !== generation) return
      await establishConnection(nextCredentials, session)
    } catch (error) {
      if (session === generation) {
        credentials = undefined
        update({ connected: false })
        report(error)
      }
    } finally { if (session === generation) update({ busy: false }) }
  })()
}

async function establishConnection(access: { token: string; expiresAt: number }, session: number) {
  controller.abort()
  controller = new AbortController()
  credentials = access
  const nextAccount = await client().account()
  if (session !== generation) return
  accountId = nextAccount
  const settings = await accountSettings()
  if (session !== generation) return
  await setMeta('driveBackup:enabled', true)
  if (session !== generation) return
  update({ enabled: true, connected: true, lastSuccess: settings.lastSuccess, folderId: undefined, folderRequired: false, reviewRequired: false })
  retryDelay = 5000
  try { if (await findFolder(client(), settings, accountKey())) schedule() }
  catch (error) { report(error); schedule() }
}

async function findFolder(drive: DriveClient, settings: AccountBackup, key: string) {
  try {
    // A known folder ID is tried directly; never fall back to a same-name folder.
    const folder = await drive.file(FOLDER_ID)
    if (folder.trashed || folder.name !== FOLDER_NAME || folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Указанная папка Financy Backup не найдена или находится в корзине. Другие папки не используются.')
    if (folder.capabilities?.canAddChildren === false) throw new Error('Нет права добавлять файлы в указанную папку. Нужен аккаунт с правом редактора этой папки.')
    settings.folderId = FOLDER_ID
    settings.folderPending = false
    await setMeta(key, settings)
    update({ folderId: FOLDER_ID, folderRequired: false, error: undefined })
    return FOLDER_ID
  } catch (error) {
    if (!(error instanceof DriveError) || ![403, 404].includes(error.status)) throw error
    update({ folderRequired: true, folderId: undefined, error: `Google Drive вернул ${error.status} для указанной папки. Доступ drive.file не подтверждён: выберите именно эту папку через Google Picker. Другие папки создаваться не будут.` })
  }
}

async function findBackup(drive: DriveClient, settings: AccountBackup, folderId: string, key: string, day: string) {
  if (settings.day !== day) {
    settings.day = day
    settings.fileId = undefined; settings.headRevision = undefined; settings.digest = undefined; settings.filePending = false
    update({ reviewRequired: false })
  }
  const pendingId = settings.filePending ? settings.fileId : undefined
  if (settings.fileId) {
    try {
      const file = await drive.file(settings.fileId)
      if (daily(file, day) && file.appProperties?.financy === 'financy-backup-v1') return file
    } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 404) throw error
    }
    settings.fileId = undefined
    settings.headRevision = undefined
    settings.digest = undefined
  }
  const candidates = (await drive.backups(folderId)).filter((file) => daily(file, day))
  if (candidates.length === 1) {
    settings.fileId = candidates[0].id
    settings.filePending = false
    await setMeta(key, settings)
    return drive.file(settings.fileId)
  }
  if (candidates.length > 1) {
    update({ reviewRequired: true, error: 'За этот день найдено несколько копий. Выберите и объедините нужную копию перед автосохранением. Существующие дубликаты не удалены.' })
    return
  }
  settings.fileId = pendingId ?? await drive.generatedId()
  settings.filePending = true
  await setMeta(key, settings)
}

export async function selectDriveFolder() {
  if (!credentials) return
  const session = generation
  update({ busy: true, error: undefined })
  try {
    const id = await pickDriveFolder(credentials.token)
    if (!id || session !== generation) return
    if (id !== FOLDER_ID) throw new Error('Выбрана другая папка. Нужна именно указанная папка Financy Backup.')
    const folder = await client().file(id)
    if (folder.trashed || folder.name !== FOLDER_NAME || folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Указанная папка недоступна.')
    const settings = await accountSettings()
    await setMeta(accountKey(), { ...settings, folderId: id, folderPending: false, fileId: undefined, headRevision: undefined, digest: undefined })
    update({ folderRequired: false, folderId: id, reviewRequired: false })
    schedule(500)
  } catch (error) { if (session === generation) report(error) }
  finally { if (session === generation) update({ busy: false }) }
}

export async function disconnectDrive() {
  ++generation
  clearTimeout(timer)
  credentials = undefined
  controller.abort()
  accountId = ''
  paused = false
  update({ enabled: false, connected: false, busy: false, error: undefined, folderId: undefined, folderRequired: false, reviewRequired: false })
  try { await setMeta('driveBackup:enabled', false) } catch {
    update({ error: 'Копирование в этой вкладке остановлено. Не удалось сохранить настройку отключения на устройстве.' })
  }
}

export async function saveDriveBackup() {
  if (running || paused || !state.enabled || !credentials) return
  if (!navigator.onLine || document.visibilityState !== 'visible') {
    update({ error: 'Копия будет сохранена при открытом приложении и доступном интернете.' })
    return
  }
  running = true
  changedDuringSave = false
  const session = generation
  let locked = false
  let succeeded = false
  try {
    if (await (await db()).get('meta', 'driveBackup:enabled') !== true) {
      await disconnectDrive()
      return
    }
    const drive = client()
    const key = accountKey()
    locked = await lease(true)
    if (!locked) { schedule(10000); return }
    if (paused || session !== generation) return
    update({ busy: true })
    const settings = await accountSettings()
    const folderId = await findFolder(drive, settings, key)
    if (!folderId || paused || session !== generation) return
    const backup = await buildBackup()
    const digest = await snapshotDigest(backup)
    const day = backupDay()
    // Opening the app on a new day does not manufacture unchanged copies.
    if (settings.day && settings.day !== day && digest === settings.digest) { succeeded = true; update({ error: undefined }); return }
    const file = await findBackup(drive, settings, folderId, key, day)
    if (!settings.fileId || state.reviewRequired) return
    if (file && file.headRevisionId !== settings.headRevision) {
      const remote = parseBackup(await drive.download(file.id))
      if (await snapshotDigest(remote) !== digest) {
        update({ reviewRequired: true, error: 'Копия Drive найдена или изменена с другого устройства. Сначала объедините её с локальными данными.' })
        return
      }
      // Also recovers a lost upload response or local settings without another file.
      settings.headRevision = file.headRevisionId
      settings.digest = digest
      settings.filePending = false
      settings.lastSuccess = file.modifiedTime ?? settings.lastSuccess
      await setMeta(key, settings)
      if (settings.lastSuccess) await setMeta('driveBackup:lastSuccess', settings.lastSuccess)
    }
    if (file && !file.headRevisionId) throw new Error('Drive не вернул версию файла. Сохранение приостановлено.')
    if (digest === settings.digest && file) {
      succeeded = true
      update({ error: undefined, lastSuccess: settings.lastSuccess })
      if (settings.cleanupPending) {
        if (await snapshotDigest(parseBackup(await drive.download(file.id))) !== digest) throw new Error('Копия изменилась. Старые файлы сохранены.')
        await finishRetention(drive, file, day, settings, key, session)
      }
      return
    }
    if (paused || session !== generation) return
    if (backupDay() !== day) { schedule(500); return }
    const uploaded = await drive.upload(settings.fileId, folderId, deviceId, JSON.stringify(backup), file?.headRevisionId, day)
    if (session !== generation) return
    // A successful HTTP response alone is insufficient to start retention cleanup.
    if (await snapshotDigest(parseBackup(await drive.download(uploaded.id))) !== digest) throw new Error('Содержимое копии не прошло проверку. Старые копии сохранены.')
    if (session !== generation) return
    settings.digest = digest
    settings.headRevision = uploaded.headRevisionId
    settings.filePending = false
    settings.lastSuccess = new Date().toISOString()
    settings.cleanupPending = true
    await setMeta(key, settings)
    await setMeta('driveBackup:lastSuccess', settings.lastSuccess)
    update({ lastSuccess: settings.lastSuccess, error: undefined })
    succeeded = true
    retryDelay = 5000
    await finishRetention(drive, uploaded, day, settings, key, session)
  } catch (error) {
    if (session === generation) {
      report(error)
      retryDelay = Math.min(retryDelay * 2, 60000)
      if (!(error instanceof DriveError) || error.status === 0 || error.status >= 500 || error.status === 429) schedule(retryDelay)
    }
  } finally {
    if (locked) await lease(false).catch(() => {})
    running = false
    if (session === generation && succeeded && changedDuringSave) schedule()
    if (session === generation) update({ busy: false })
  }
}

export async function listDriveBackups() {
  paused = true
  clearTimeout(timer)
  try {
    const settings = await accountSettings()
    const drive = client()
    if (!await findFolder(drive, settings, accountKey())) throw new Error('Нет доступа к указанной папке Financy Backup.')
    return (await drive.backups(FOLDER_ID)).sort((a, b) => (b.appProperties?.day ?? b.modifiedTime ?? '').localeCompare(a.appProperties?.day ?? a.modifiedTime ?? ''))
  } catch (error) {
    finishDriveRestore()
    report(error)
    throw error
  }
}

export async function downloadDriveBackup(id: string, revisionId?: string) {
  try {
    const file = await client().file(id)
    if (!file.parents?.includes(FOLDER_ID) || file.trashed || file.appProperties?.financy !== 'financy-backup-v1') throw new Error('Копия находится вне указанной папки Financy Backup.')
    const backup = parseBackup(revisionId ? await client().revisionText(id, revisionId) : await client().download(id))
    reviewedFile = file
    return backup
  } catch (error) {
    report(error)
    throw error
  }
}

export function finishDriveRestore() {
  reviewedFile = undefined
  paused = false
  schedule()
}

export async function completeDriveRestore() {
  try {
    if (reviewedFile) {
      const settings = await accountSettings()
      if (daily(reviewedFile, backupDay())) {
        const file = await client().file(reviewedFile.id)
        if (file.headRevisionId !== reviewedFile.headRevisionId) throw new Error('Копия Drive изменилась во время восстановления. Выберите её повторно.')
        await setMeta(accountKey(), { ...settings, folderId: FOLDER_ID, day: backupDay(), fileId: file.id, filePending: false, headRevision: file.headRevisionId, digest: undefined })
        update({ reviewRequired: false, error: undefined })
      }
    }
  } catch (error) { update({ reviewRequired: true }); report(error) }
  finally { finishDriveRestore() }
}

async function finishRetention(drive: DriveClient, file: DriveFile, day: string, settings: AccountBackup, key: string, session: number) {
  try {
    if (await cleanupDailyBackups(drive, file, day, session)) {
      if (session !== generation) return
      settings.cleanupPending = false
      await setMeta(key, settings)
    }
  } catch {
    if (session === generation) update({ error: 'Новая копия сохранена. Не удалось завершить проверку старых копий; непроверенные файлы оставлены в Drive. Проверка повторится.' })
  }
}

async function cleanupDailyBackups(drive: DriveClient, saved: DriveFile, day: string, session: number) {
  const cutoff = retentionCutoff(day)
  const files = await drive.backups(FOLDER_ID)
  if (files.filter((file) => daily(file, day)).length > 1) {
    update({ error: 'Найдены копии за один день с разных устройств. Файлы сохранены; выберите копию для объединения.' })
    return false
  }
  for (const file of files) {
    const date = file.appProperties?.day
    if (file.id === saved.id || file.appProperties?.role !== 'daily' || !date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= cutoff ||
      file.name !== `financy-backup-${date}.json` || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) continue
    if (paused || session !== generation) return false
    parseBackup(await drive.download(file.id))
    const current = await drive.file(saved.id)
    if (current.trashed || current.headRevisionId !== saved.headRevisionId) throw new Error('Новая копия изменилась. Очистка остановлена.')
    if (paused || session !== generation) return false
    await drive.trashDaily(file, cutoff)
  }
  return true
}

export const driveConfigured = !!GOOGLE_CLIENT_ID
