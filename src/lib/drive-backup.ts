import { useSyncExternalStore } from 'react'
import { buildBackup, parseBackup } from './backup'
import { db, onDataChanged, setMeta } from './db'
import { DriveClient, DriveError } from './google-drive'
import { GOOGLE_CLIENT_ID, loadGoogleIdentity, requestDriveAccess } from './google-auth'

interface AccountBackup {
  folderId?: string
  fileId?: string
  digest?: string
  lastSuccess?: string
}

interface DriveState {
  enabled: boolean
  ready: boolean
  connected: boolean
  busy: boolean
  lastSuccess?: string
  error?: string
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
const owner = randomId()

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
      controller.abort()
      controller = new AbortController()
      credentials = nextCredentials
      const nextAccountId = await client().account()
      if (session !== generation) return
      accountId = nextAccountId
      const settings = await accountSettings()
      if (session !== generation) return
      await setMeta('driveBackup:enabled', true)
      if (session !== generation) {
        await setMeta('driveBackup:enabled', state.enabled)
        return
      }
      update({ enabled: true, connected: true, lastSuccess: settings.lastSuccess })
      retryDelay = 5000
      schedule()
    } catch (error) {
      if (session === generation) {
        credentials = undefined
        update({ connected: false })
        report(error)
      }
    } finally { if (session === generation) update({ busy: false }) }
  })()
}

export async function disconnectDrive() {
  ++generation
  clearTimeout(timer)
  credentials = undefined
  controller.abort()
  accountId = ''
  paused = false
  update({ enabled: false, connected: false, busy: false, error: undefined })
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
    const backup = await buildBackup()
    const { exportedAt: _exportedAt, ...data } = backup
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))
    const digest = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
    if (digest === settings.digest) { succeeded = true; update({ error: undefined, lastSuccess: settings.lastSuccess }); return }
    if (!settings.folderId) {
      const folders = await drive.folders()
      settings.folderId = folders[0]?.id ?? await drive.generatedId()
      await setMeta(key, settings)
      if (!folders.length) await drive.createFolder(settings.folderId)
    } else {
      // Retries use the same pre-generated ID, including when a create response was lost.
      try { await drive.file(settings.folderId) } catch (error) {
        if (!(error instanceof DriveError) || error.status !== 404) throw error
        await drive.createFolder(settings.folderId)
      }
    }
    if (!settings.fileId) {
      const files = await drive.backups()
      settings.fileId = files.find((file) => file.appProperties?.device === deviceId)?.id ?? await drive.generatedId()
      await setMeta(key, settings)
    }
    if (paused || session !== generation) return
    await drive.upload(settings.fileId, settings.folderId, deviceId, JSON.stringify(backup))
    if (session !== generation) return
    settings.digest = digest
    settings.lastSuccess = new Date().toISOString()
    await setMeta(key, settings)
    await setMeta('driveBackup:lastSuccess', settings.lastSuccess)
    update({ lastSuccess: settings.lastSuccess, error: undefined })
    succeeded = true
    retryDelay = 5000
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
  try { return await client().backups() } catch (error) {
    finishDriveRestore()
    report(error)
    throw error
  }
}

export async function downloadDriveBackup(id: string) {
  try { return parseBackup(await client().download(id)) } catch (error) {
    report(error)
    throw error
  }
}

export function finishDriveRestore() {
  paused = false
  schedule()
}

export const driveConfigured = !!GOOGLE_CLIENT_ID
