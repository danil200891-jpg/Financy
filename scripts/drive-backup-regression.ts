// Browser regression suite. Run only in a fresh isolated origin with synthetic data.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Settings } from '../src/screens/Settings'
import { actions, initStore } from '../src/lib/store'
import { backupSnapshot, db } from '../src/lib/db'
import { buildBackup } from '../src/lib/backup'
import { connectDrive, disconnectDrive, initDriveBackup, saveDriveBackup, selectDriveFolder, backupDay, retentionCutoff, downloadDriveBackup, completeDriveRestore, listDriveBackups, finishDriveRestore } from '../src/lib/drive-backup'
import { DRIVE_SCOPE, driveOriginError } from '../src/lib/google-auth'
import { pickDriveFolder } from '../src/lib/google-picker'
import { DriveClient, FOLDER_ID } from '../src/lib/google-drive'

type MockFile = { id: string; name: string; mimeType: string; appProperties?: Record<string, string>; size?: string; modifiedTime?: string; body?: string; parents?: string[]; headRevisionId?: string; trashed?: boolean; version?: string }
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
  check(!!driveOriginError('https://192.168.100.156:4444') && !driveOriginError('http://localhost:4173') && !driveOriginError('https://danil200891-jpg.github.io'), 'OAuth origin validation failed')
  check(retentionCutoff('2026-03-30') === '2026-03-01' && retentionCutoff('2024-03-01') === '2024-02-01', 'Calendar retention failed across DST/leap year')
  const RealDate = Date
  let clock = new RealDate(2026, 2, 30, 12).getTime()
  class Clock extends RealDate { constructor(value?: string | number) { super(value ?? clock) } static now() { return clock } }
  Object.defineProperty(window, 'Date', { configurable: true, value: Clock })
  const files = new Map<string, MockFile>()
  files.set(FOLDER_ID, { id: FOLDER_ID, name: 'Financy Backup', mimeType: 'application/vnd.google-apps.folder' })
  let folderAccessible = true
  const originalFetch = window.fetch
  let nextId = 0
  let uploads = 0
  let uploadStatus = 0
  let loseCreateResponse = false
  let lifetime = 3600
  let oauthCallbacks = 0
  let failAbout = false
  let oauthFailure: 'denied' | 'closed' | undefined
  let failTrash = false
  let resumableId = ''
  let revisionNumber = 0
  const revisionFiles = new Map<string, { id: string; body: string; modifiedTime: string; keepForever: boolean }[]>()
  const revise = (file: MockFile) => {
    const revision = { id: `revision-${++revisionNumber}`, body: file.body!, modifiedTime: new Date(1700000000000 + revisionNumber * 1000).toISOString(), keepForever: true }
    file.headRevisionId = revision.id
    file.version = String(revisionNumber)
    revisionFiles.set(file.id, [...revisionFiles.get(file.id) ?? [], revision])
  }
  const syntheticToken = 'synthetic-test-credential'
  Object.defineProperty(window, 'google', { configurable: true, value: { accounts: { oauth2: {
    initTokenClient(config: { scope: string; include_granted_scopes: boolean; callback: (result: object) => void; error_callback: () => void }) {
      check(config.scope === DRIVE_SCOPE && config.include_granted_scopes === false, 'Unexpected OAuth permissions')
      return { requestAccessToken() {
        oauthCallbacks++
        setTimeout(() => oauthFailure === 'closed' ? config.error_callback() : config.callback(oauthFailure === 'denied' ? { error: 'access_denied' } : { access_token: syntheticToken, expires_in: lifetime, scope: DRIVE_SCOPE }), 0)
      } }
    },
  } } } })
  let pickerChoice: string | undefined
  let pickerFailure = false
  let pickerCallback: ((data: object) => void) | undefined
  class MockView {
    setMode(value: string) { check(value === 'list', 'Picker should not require thumbnail access'); return this }
    setIncludeFolders(value: boolean) { check(value, 'Picker omitted folders'); return this }
    setSelectFolderEnabled(value: boolean) { check(value, 'Picker cannot select a folder'); return this }
    setMimeTypes(value: string) { check(value === 'application/vnd.google-apps.folder', 'Picker permits non-folders'); return this }
  }
  class MockPicker {
    addView() { return this }
    setOAuthToken(value: string) { check(value === syntheticToken, 'Picker lacks scoped token'); return this }
    setDeveloperKey(value: string) { check(value === 'synthetic-picker-key', 'Unexpected Picker key'); return this }
    setAppId(value: string) { check(value === '12345', 'Incorrect Picker app project'); return this }
    setOrigin(value: string) { check(value === location.origin, 'Incorrect Picker origin'); return this }
    setLocale() { return this }
    setTitle(value: string) { check(value.includes('Financy Backup'), 'Picker does not identify the required folder'); return this }
    setCallback(callback: (data: object) => void) { pickerCallback = callback; return this }
    build() { return { setVisible(visible: boolean) { if (!visible) return; if (pickerChoice === FOLDER_ID) folderAccessible = true; pickerCallback!({ action: pickerFailure ? 'error' : pickerChoice ? 'picked' : 'cancel', docs: pickerChoice ? [{ id: pickerChoice }] : [] }) } } }
  }
  Object.assign((window as unknown as { google: object }).google, { picker: { DocsView: MockView, PickerBuilder: MockPicker } })
  check(await pickDriveFolder(syntheticToken) === undefined, 'Picker cancellation did not cancel')
  pickerChoice = 'synthetic-selected-folder'
  check(await pickDriveFolder(syntheticToken) === pickerChoice, 'Picker did not return granted folder')
  pickerFailure = true
  let pickerError = ''
  try { await pickDriveFolder(syntheticToken) } catch (error) { pickerError = (error as Error).message }
  check(pickerError.includes('одного Google Drive API недостаточно') && !pickerError.includes(syntheticToken), 'Picker key error did not explain restrictions safely')
  pickerFailure = false
  console.log('PASS folder-only Google Picker, scoped credentials, origin, selection and cancellation')
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    check(url.origin === 'https://www.googleapis.com', 'Unexpected network origin in Drive test')
    check(new Headers(init.headers).get('Authorization') === `Bearer ${syntheticToken}`, 'Missing header authentication')
    check(!url.href.includes(syntheticToken), 'Credential leaked into URL')
    const result = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
    if (url.pathname.endsWith('/about')) return failAbout ? result({}, 401) : result({ user: { permissionId: 'synthetic-account' } })
    if (url.pathname.endsWith('/generateIds')) return result({ ids: [`synthetic-${++nextId}`] })
    if (url.pathname.includes('/revisions')) {
      const parts = url.pathname.split('/')
      const fileId = parts[4]
      const revisionId = parts[6]
      const revisions = revisionFiles.get(fileId) ?? []
      if (!revisionId) return result({ revisions: revisions.map(({ body: _body, ...revision }) => revision) })
      const revision = revisions.find((item) => item.id === revisionId)
      if (!revision) return result({}, 404)
      if (init.method === 'DELETE') {
        check(revisionId !== files.get(fileId)?.headRevisionId, 'Attempted to delete current revision')
        check(revision.keepForever, 'Unverified revision deletion')
        throw new Error('Revision deletion must not be used for daily retention')
        return new Response(null, { status: 204 })
      }
      if (init.method === 'PATCH') { revision.keepForever = true; return result(revision) }
      if (url.searchParams.get('alt') === 'media') return new Response(revision.body)
      return result(revision)
    }
    if (url.pathname === '/drive/v3/files' && (!init.method || init.method === 'GET')) {
      const folders = url.searchParams.get('q')?.includes('application/vnd.google-apps.folder')
      const parent = url.searchParams.get('q')?.match(/'([^']+)' in parents/)?.[1]
      return result({ files: [...files.values()].filter((file) => !file.trashed && (folders ? file.mimeType.endsWith('folder') : file.mimeType === 'application/json' && file.appProperties?.financy === 'financy-backup-v1' && (!parent || file.parents?.includes(parent)))).map(({ body: _body, ...file }) => file) })
    }
    if (url.pathname === '/drive/v3/files' && init.method === 'POST') {
      throw new Error('No folders may be created')
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
        file.body = String(init.body); file.size = String(file.body.length); uploads++; revise(file)
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
      revise(files.get(id)!)
      uploads++
      if (loseCreateResponse) { loseCreateResponse = false; throw new TypeError('Synthetic network interruption') }
      return result({ id })
    }
    const id = decodeURIComponent(url.pathname.split('/').pop()!)
    if (id === FOLDER_ID && !folderAccessible) return result({}, 404)
    const file = files.get(id)
    if (!file) return result({}, 404)
    if (init.method === 'PATCH') {
      const patch = JSON.parse(String(init.body))
      if (patch.trashed && failTrash) { failTrash = false; return result({}, 503) }
      Object.assign(file, patch); return result(file)
    }
    if (url.searchParams.get('alt') === 'media') return new Response(file.body, { headers: { 'Content-Type': 'application/json' } })
    return result(file, 200, { ETag: file.headRevisionId ?? file.id })
  }
  try {
    await initStore()
    await (await db()).put('meta', { folderId: 'synthetic-previous-folder' }, 'driveBackup:account:synthetic-account')
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
    await until(() => document.body.textContent!.includes('Доступ к указанной папке подтверждён'))
    check(files.size === 1, 'Login created an extra folder or bypassed debounce')
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
    console.log('PASS direct fixed-folder access, drive.file scope, debounce, snapshot/history, unchanged-data skip, same-day file update')

    folderAccessible = false
    const beforeFolderError = JSON.stringify(await backupSnapshot())
    await saveDriveBackup()
    check(document.body.textContent!.includes('Google Drive вернул 404'), 'Missing fixed-folder access did not require a grant')
    check(files.size === 2 && JSON.stringify(await backupSnapshot()) === beforeFolderError, 'Inaccessible folder changed local data or created a folder')
    pickerChoice = 'synthetic-wrong-folder'; await selectDriveFolder()
    check(document.body.textContent!.includes('Выбрана другая папка'), 'Another Picker folder accepted')
    pickerChoice = FOLDER_ID; await selectDriveFolder(); await saveDriveBackup()
    check(files.size === 2, 'Picker grant created another backup or folder')
    console.log('PASS inaccessible folder, exact-ID Picker grant, wrong-folder rejection, no new folders and unchanged IndexedDB')

    actions.updateOperation(operation.id, { note: 'Synthetic lost update response' }); await backupSnapshot()
    loseCreateResponse = true
    await saveDriveBackup()
    const lostResponseCount = uploads
    await saveDriveBackup()
    check(uploads === lostResponseCount && files.size === 2, 'Lost update response caused another file or upload')
    console.log('PASS lost-response recovery verifies existing JSON without duplicate upload')

    const localBefore = JSON.stringify(await backupSnapshot())
    const remote = await buildBackup()
    remote.operations = [{ ...remote.operations[0], id: 'synthetic-remote-only', title: 'Synthetic cloud-only operation' }]
    files.set('synthetic-remote', { ...backupFile, id: 'synthetic-remote', appProperties: { ...backupFile.appProperties, role: 'legacy' }, name: 'Synthetic restore.json', body: JSON.stringify(remote), size: '1000' })
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
    window.dispatchEvent(new Event('online'))
    await until(() => uploads === offlineCount + 1)
    check(uploads === offlineCount + 1, 'Offline change did not upload after online event')
    uploadStatus = 503
    actions.updateOperation(operation.id, { note: 'Synthetic retry' }); await backupSnapshot()
    const beforeFailure = JSON.stringify(await backupSnapshot())
    await saveDriveBackup(); check(JSON.stringify(await backupSnapshot()) === beforeFailure, 'Failed upload changed local data')
    await saveDriveBackup(); check(files.size === 3, 'Retry created extra copies')
    console.log('PASS offline recovery and transient upload failure preserve IndexedDB')

    const dailyCount = () => [...files.values()].filter((file) => !file.trashed && file.appProperties?.role === 'daily').length
    const previousDay = backupDay()
    const previousUploads = uploads
    clock += 86400000
    await disconnectDrive(); connectDrive()
    await until(() => document.body.textContent!.includes('Автокопирование подключено'))
    await saveDriveBackup()
    check(uploads === previousUploads, 'Unchanged day transition manufactured a copy')
    actions.updateOperation(operation.id, { note: 'Synthetic next-day change' }); await backupSnapshot(); await saveDriveBackup()
    check(dailyCount() === 2 && [...files.values()].some((file) => file.appProperties?.day === previousDay), 'New day overwrote prior daily backup')
    const today = backupDay()
    for (let age = 2; age <= 35; age++) {
      const date = new RealDate(clock); date.setDate(date.getDate() - age)
      const day = backupDay(date)
      files.set(`synthetic-old-${age}`, { ...backupFile, id: `synthetic-old-${age}`, name: `financy-backup-${day}.json`, appProperties: { ...backupFile.appProperties, role: 'daily', day } })
    }
    const retentionSnapshot = JSON.stringify(await backupSnapshot())
    uploadStatus = 503
    actions.updateOperation(operation.id, { note: 'Synthetic retention failure' }); await backupSnapshot(); await saveDriveBackup()
    check(![...files.values()].some((file) => file.trashed), 'Failed upload deleted old backups')
    failTrash = true
    await saveDriveBackup()
    const afterRetentionUpload = uploads
    check(![...files.values()].some((file) => file.trashed), 'Cleanup failure fixture did not retain files')
    await saveDriveBackup()
    check(uploads === afterRetentionUpload, 'Cleanup retry uploaded an unchanged backup')
    check(dailyCount() === 30 && [...files.values()].filter((file) => file.trashed).length === 6, 'Retention did not retain exactly 30 calendar days')
    check(!files.get('synthetic-remote')!.trashed, 'Legacy backup removed by retention')
    check(JSON.stringify(await backupSnapshot()) !== retentionSnapshot, 'Synthetic retention fixture did not update local note')
    check([...files.values()].filter((file) => file.trashed).every((file) => file.appProperties!.day < retentionCutoff(today)), 'Recent backup trashed')
    console.log('PASS next-day changes create one new file; 30 calendar days, DST/leap boundaries, cleanup only after verified upload; legacy files preserved')
    const accountKey = 'driveBackup:account:synthetic-account'
    const originalSettings = await (await db()).get('meta', accountKey) as { folderId: string; fileId: string }
    const fileCount = files.size
    await (await db()).put('meta', {}, accountKey)
    await saveDriveBackup()
    const recovered = await (await db()).get('meta', accountKey) as { folderId: string; fileId: string }
    check(recovered.folderId === originalSettings.folderId && recovered.fileId === originalSettings.fileId, 'Settings loss did not rediscover canonical folder/file')
    check(files.size === fileCount, 'Settings loss created duplicate folders/files')
    check(uploads > 0 && recovered.folderId === FOLDER_ID, 'Recovered folder is not the configured ID')
    console.log('PASS settings-loss recovery rediscovers the same folder and daily file without duplicate upload')

    const current = files.get(recovered.fileId)!
    files.set('synthetic-duplicate', { ...current, id: 'synthetic-duplicate' })
    await (await db()).put('meta', {}, accountKey)
    const beforeDuplicate = uploads
    await saveDriveBackup()
    check(document.body.textContent!.includes('несколько копий') && uploads === beforeDuplicate, 'Ambiguous daily copies silently overwritten')
    await listDriveBackups(); await downloadDriveBackup(current.id); await completeDriveRestore()
    check(files.has('synthetic-duplicate') && !files.get('synthetic-duplicate')!.trashed, 'Duplicate deleted without review')
    console.log('PASS duplicate-day detection pauses writes without deleting existing copies')

    const persisted = JSON.stringify(await (await db()).getAll('meta'))
    check(!persisted.includes(syntheticToken), 'Credential persisted in IndexedDB')
    await disconnectDrive()
    const stopped = uploads
    actions.updateOperation(operation.id, { note: 'Synthetic disconnected change' }); await backupSnapshot()
    await wait(5500); check(uploads === stopped, 'Upload continued after disconnect')
    const oauthBeforeErrors = oauthCallbacks
    oauthFailure = 'denied'; connectDrive()
    await until(() => document.body.textContent!.includes('Доступ к Google Drive не предоставлен'))
    oauthFailure = 'closed'; connectDrive()
    await until(() => document.body.textContent!.includes('Окно Google закрыто или заблокировано'))
    oauthFailure = undefined
    failAbout = true; connectDrive()
    await until(() => document.body.textContent!.includes('Срок доступа истёк'))
    failAbout = false; lifetime = 31; connectDrive()
    await until(() => document.body.textContent!.includes('Автокопирование подключено'))
    clock += 2000; await saveDriveBackup()
    check(document.body.textContent!.includes('Требуется повторное подключение'), 'Expired token did not require user action')
    check(oauthCallbacks === oauthBeforeErrors + 4, 'Unexpected automatic OAuth popup')
    await disconnectDrive()
    console.log('PASS disconnect, safe 401 handling, expiry requires user gesture, no persisted credentials')

    const large = new DriveClient(syntheticToken, new AbortController().signal)
    const recoveredId = await large.generatedId()
    const beforeLostResponse = files.size
    loseCreateResponse = true
    let interrupted = false
    try { await large.upload(recoveredId, FOLDER_ID, 'synthetic-device', '{}', undefined, today) } catch { interrupted = true }
    check(interrupted && files.has(recoveredId), 'Lost-response fixture did not create a remote file')
    await large.upload(recoveredId, FOLDER_ID, 'synthetic-device', '{}', undefined, today)
    check(files.size === beforeLostResponse + 1, 'Lost create response produced duplicate files')
    console.log('PASS competing-tab lease and lost create response retry retain one file')
    const largeId = await large.generatedId()
    await large.upload(largeId, FOLDER_ID, 'synthetic-device', JSON.stringify({ note: 'x'.repeat(6 * 1024 * 1024) }), undefined, today)
    check(files.get(largeId)?.body?.length! > 5 * 1024 * 1024, 'Large resumable upload failed')
    check(original.includes(operation.id), 'Synthetic fixture missing')
    console.log('PASS backups larger than 5 MB use resumable upload')
    return 'All Google Drive regression checks passed'
  } finally {
    await disconnectDrive()
    window.fetch = originalFetch
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    Object.defineProperty(window, 'Date', { configurable: true, value: RealDate })
  }
}
