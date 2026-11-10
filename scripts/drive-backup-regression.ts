// Browser regression suite. Run only in a fresh isolated origin with synthetic data.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Settings } from '../src/screens/Settings'
import { actions, initStore } from '../src/lib/store'
import { backupSnapshot, db } from '../src/lib/db'
import { buildBackup } from '../src/lib/backup'
import { connectDrive, disconnectDrive, initDriveBackup, saveDriveBackup } from '../src/lib/drive-backup'
import { DRIVE_SCOPE } from '../src/lib/google-auth'
import { DriveClient } from '../src/lib/google-drive'

type MockFile = { id: string; name: string; mimeType: string; appProperties?: Record<string, string>; size?: string; modifiedTime?: string; body?: string }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await test()) return; await wait(50) }
  throw new Error('Timed out waiting for test condition')
}
function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text || node.querySelector('p')?.textContent?.trim() === text)
  check(button && !button.disabled, `Missing enabled button ${text}`)
  button.click()
}

export async function runDriveRegression() {
  const files = new Map<string, MockFile>()
  const originalFetch = window.fetch
  let nextId = 0
  let uploads = 0
  let uploadStatus = 0
  let loseCreateResponse = false
  let lifetime = 3600
  let oauthCallbacks = 0
  let failAbout = false
  let resumableId = ''
  const syntheticToken = 'synthetic-test-credential'
  Object.defineProperty(window, 'google', { configurable: true, value: { accounts: { oauth2: {
    initTokenClient(config: { scope: string; include_granted_scopes: boolean; callback: (result: object) => void }) {
      check(config.scope === DRIVE_SCOPE && config.include_granted_scopes === false, 'Unexpected OAuth permissions')
      return { requestAccessToken() {
        oauthCallbacks++
        setTimeout(() => config.callback({ access_token: syntheticToken, expires_in: lifetime, scope: DRIVE_SCOPE }), 0)
      } }
    },
  } } } })
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    check(url.origin === 'https://www.googleapis.com', 'Unexpected network origin in Drive test')
    check(new Headers(init.headers).get('Authorization') === `Bearer ${syntheticToken}`, 'Missing header authentication')
    check(!url.href.includes(syntheticToken), 'Credential leaked into URL')
    const result = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
    if (url.pathname.endsWith('/about')) return failAbout ? result({}, 401) : result({ user: { permissionId: 'synthetic-account' } })
    if (url.pathname.endsWith('/generateIds')) return result({ ids: [`synthetic-${++nextId}`] })
    if (url.pathname === '/drive/v3/files' && (!init.method || init.method === 'GET')) {
      const folders = url.searchParams.get('q')?.includes('application/vnd.google-apps.folder')
      return result({ files: [...files.values()].filter((file) => folders ? file.mimeType.endsWith('folder') : file.mimeType === 'application/json').map(({ body: _body, ...file }) => file) })
    }
    if (url.pathname === '/drive/v3/files' && init.method === 'POST') {
      const file = JSON.parse(String(init.body)) as MockFile
      if (files.has(file.id)) return result({}, 409)
      files.set(file.id, file)
      return result({ id: file.id })
    }
    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      if (uploadStatus) { const status = uploadStatus; uploadStatus = 0; return result({}, status) }
      if (url.searchParams.get('uploadType') === 'resumable') {
        const metadata = JSON.parse(String(init.body)) as MockFile
        resumableId = metadata.id ?? url.pathname.split('/').pop()!
        if (metadata.id) files.set(metadata.id, metadata)
        return result({}, 200, { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic' })
      }
      if (init.method === 'PUT') {
        const file = files.get(resumableId)!
        file.body = String(init.body); file.size = String(file.body.length); uploads++
        return result({ id: file.id })
      }
      const boundary = new Headers(init.headers).get('Content-Type')!.split('boundary=')[1]
      const parts = (await (init.body as Blob).text()).split(`--${boundary}`)
      const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim()) as MockFile
      const body = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
      const id = metadata.id ?? url.pathname.split('/').pop()!
      const current = files.get(id)
      if (init.method === 'POST' && current) return result({}, 409)
      files.set(id, { ...current, ...metadata, id, body, size: String(body.length), modifiedTime: new Date().toISOString() })
      uploads++
      if (loseCreateResponse) { loseCreateResponse = false; throw new TypeError('Synthetic network interruption') }
      return result({ id })
    }
    const id = decodeURIComponent(url.pathname.split('/').pop()!)
    const file = files.get(id)
    if (!file) return result({}, 404)
    if (url.searchParams.get('alt') === 'media') return new Response(file.body, { headers: { 'Content-Type': 'application/json' } })
    return result(file)
  }
  try {
    await initStore()
    await initDriveBackup()
    const root = document.createElement('div'); document.body.appendChild(root)
    createRoot(root).render(createElement(Settings, { onBack() {} }))
    await until(() => !![...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Подключить Google Drive' && !node.disabled))
    const client = actions.addClient('Synthetic Drive client', '#7c8cff')
    const operation = actions.addOperation({ type: 'income', amount: 12345, currency: 'EUR', title: 'Synthetic Drive operation', date: '2026-01-01T12:00:00Z', clientId: client.id, categoryId: 'c-work', source: 'manual' })
    await backupSnapshot()
    const original = JSON.stringify(await backupSnapshot())
    click('Подключить Google Drive')
    await until(() => document.body.textContent!.includes('Автокопирование подключено'))
    check(uploads === 0, 'Upload ran before debounce')
    actions.updateOperation(operation.id, { note: 'Synthetic note 1' })
    actions.updateOperation(operation.id, { note: 'Synthetic note 2' })
    await until(() => uploads === 1)
    const backupFile = [...files.values()].find((file) => file.mimeType === 'application/json')!
    const saved = JSON.parse(backupFile.body!)
    check(saved.operations[0].note === 'Synthetic note 2' && saved.history.length === 4, 'Backup snapshot lost data/history')
    await saveDriveBackup(); check(uploads === 1, 'Unchanged data uploaded again')
    check(files.size === 2, 'Unexpected backup/folder proliferation')
    actions.addOperation({ ...operation, title: 'Synthetic second operation' })
    await backupSnapshot()
    await saveDriveBackup()
    check(Number(uploads) === 2 && files.size === 2, 'Changed data did not update the same file')
    const lockedCount = uploads
    await (await db()).put('meta', { owner: 'synthetic-other-tab', until: Date.now() + 60000 }, 'driveBackup:lease')
    actions.updateOperation(operation.id, { note: 'Synthetic competing tab' }); await backupSnapshot()
    await saveDriveBackup(); check(uploads === lockedCount, 'Concurrent tab ignored the backup lease')
    await (await db()).put('meta', { owner: 'synthetic-other-tab', until: 0 }, 'driveBackup:lease')
    await saveDriveBackup()
    console.log('PASS Drive scope, debounce, persisted snapshot/history, unchanged-data skip, single rolling file')

    const localBefore = JSON.stringify(await backupSnapshot())
    const remote = await buildBackup()
    remote.operations = [{ ...remote.operations[0], id: 'synthetic-remote-only', title: 'Synthetic cloud-only operation' }]
    files.set('synthetic-remote', { ...backupFile, id: 'synthetic-remote', name: 'Synthetic restore.json', body: JSON.stringify(remote), size: '1000' })
    click('Восстановить из Google Drive')
    await until(() => !![...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic restore.json')))
    ;[...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic restore.json'))!.click()
    await until(() => document.body.textContent!.includes('Восстановить копию?'))
    check(JSON.stringify(await backupSnapshot()) === localBefore, 'Preview changed local data')
    check(![...document.querySelectorAll('button')].some((node) => node.textContent?.includes('Заменить всё')), 'Cloud restore exposes replacement')
    click('Отмена')
    check(JSON.stringify(await backupSnapshot()) === localBefore, 'Cancel changed local data')
    click('Восстановить из Google Drive')
    await until(() => !![...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic restore.json')))
    ;[...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic restore.json'))!.click()
    await until(() => document.body.textContent!.includes('Восстановить копию?'))
    click('Объединить')
    await until(async () => (await backupSnapshot()).operations.some((item) => item.id === 'synthetic-remote-only'))
    const after = await backupSnapshot()
    check(after.operations.some((item) => item.id === operation.id), 'Restore lost existing operation')
    check(JSON.stringify(await (await db()).get('meta', 'preRestore')).includes(operation.id), 'Missing undo snapshot')
    console.log('PASS Drive restore selection, preview, cancellation, confirmation, merge preserves existing records and undo snapshot')

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const offlineCount = uploads
    actions.updateOperation(operation.id, { note: 'Synthetic offline change' }); await backupSnapshot()
    await saveDriveBackup(); check(uploads === offlineCount, 'Offline upload attempted')
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    await saveDriveBackup(); check(uploads === offlineCount + 1, 'Offline change did not upload after recovery')
    uploadStatus = 503
    actions.updateOperation(operation.id, { note: 'Synthetic retry' }); await backupSnapshot()
    const beforeFailure = JSON.stringify(await backupSnapshot())
    await saveDriveBackup(); check(JSON.stringify(await backupSnapshot()) === beforeFailure, 'Failed upload changed local data')
    await saveDriveBackup(); check(files.size === 3, 'Retry created extra copies')
    console.log('PASS offline recovery and transient upload failure preserve IndexedDB')

    const persisted = JSON.stringify(await (await db()).getAll('meta'))
    check(!persisted.includes(syntheticToken), 'Credential persisted in IndexedDB')
    await disconnectDrive()
    const stopped = uploads
    actions.updateOperation(operation.id, { note: 'Synthetic disconnected change' }); await backupSnapshot()
    await wait(5500); check(uploads === stopped, 'Upload continued after disconnect')
    failAbout = true; connectDrive()
    await until(() => document.body.textContent!.includes('Срок доступа истёк'))
    failAbout = false; lifetime = 31; connectDrive()
    await until(() => document.body.textContent!.includes('Автокопирование подключено'))
    await wait(1200); await saveDriveBackup()
    check(document.body.textContent!.includes('Требуется повторное подключение'), 'Expired token did not require user action')
    check(oauthCallbacks === 3, 'Unexpected automatic OAuth popup')
    await disconnectDrive()
    console.log('PASS disconnect, safe 401 handling, expiry requires user gesture, no persisted credentials')

    const large = new DriveClient(syntheticToken, new AbortController().signal)
    const recoveredId = await large.generatedId()
    const beforeLostResponse = files.size
    loseCreateResponse = true
    let interrupted = false
    try { await large.upload(recoveredId, 'synthetic-folder', 'synthetic-device', '{}') } catch { interrupted = true }
    check(interrupted && files.has(recoveredId), 'Lost-response fixture did not create a remote file')
    await large.upload(recoveredId, 'synthetic-folder', 'synthetic-device', '{}')
    check(files.size === beforeLostResponse + 1, 'Lost create response produced duplicate files')
    console.log('PASS competing-tab lease and lost create response retry retain one file')
    const largeId = await large.generatedId()
    await large.upload(largeId, 'synthetic-folder', 'synthetic-device', JSON.stringify({ note: 'x'.repeat(6 * 1024 * 1024) }))
    check(files.get(largeId)?.body?.length! > 5 * 1024 * 1024, 'Large resumable upload failed')
    check(original.includes(operation.id), 'Synthetic fixture missing')
    console.log('PASS backups larger than 5 MB use resumable upload')
    return 'All Google Drive regression checks passed'
  } finally {
    await disconnectDrive()
    window.fetch = originalFetch
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  }
}
