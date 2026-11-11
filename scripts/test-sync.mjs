// Two-device sync regression: real sync server (temporary folder, loopback only) + two isolated
// browser origins acting as "iPhone" and "PC browser". No user data or real folders are touched.
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { build } from 'vite'
import { startServer } from '../sync-server/server.mjs'

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p) => p && existsSync(p))
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable')
mkdirSync('node_modules/.cache', { recursive: true })
const work = mkdtempSync(resolve('node_modules/.cache/sync-regression-'))
// a free port, not 47821: an installed Financy Sync on this PC must stay untouched
const syncPort = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
await build({
  configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __APP_VERSION__: JSON.stringify('sync-regression'), 'import.meta.env.VITE_SYNC_TEST_PORT': JSON.stringify(String(syncPort)) },
  build: { outDir: join(work, 'bundle'), lib: { entry: resolve('scripts/sync-regression.ts'), formats: ['es'], fileName: () => 'test.js' } },
})
const bundle = readFileSync(join(work, 'bundle', 'test.js'))
const web = createServer((req, res) => {
  if (req.url.startsWith('/test.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); return }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>sync</title>')
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const webPort = web.address().port

const home = join(work, 'server-home')
const startSync = () => startServer({ home, quiet: true, noExit: true, bindHost: '127.0.0.1', port: syncPort, httpPort: 0, adminPort: 0, hosts: ['localhost'], config: { backupDir: join(home, 'backups') } })
let server = await startSync()
const admin = (method, path) => new Promise((res, rej) => {
  const r = request({ host: '127.0.0.1', port: server.ports.admin, method, path, headers: { 'X-Financy-Admin': '1' } }, (x) => { let t = ''; x.on('data', (c) => (t += c)); x.on('end', () => res(JSON.parse(t))) })
  r.on('error', rej); r.end()
})

const profile = join(work, 'profile')
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--ignore-certificate-errors',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
const sockets = []
let failed = false
const check = (ok, msg) => { if (!ok) throw new Error(`FAIL ${msg}`) }
try {
  const activePort = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(activePort); i++) await new Promise((r) => setTimeout(r, 100))
  const debugPort = readFileSync(activePort, 'utf8').split('\n')[0]
  // two pages on two origins = two separate IndexedDB databases = two devices
  const open = async (origin) => {
    const t = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/`)}`, { method: 'PUT' })).json()
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    sockets.push(ws)
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    let seq = 0
    const pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.method === 'Runtime.exceptionThrown') console.log('page error', m.params.exceptionDetails.exception?.description)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    })
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    await cdp('Runtime.enable')
    await new Promise((r) => setTimeout(r, 300))
    const run = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: `(async () => { const api = window.api; return ${expr} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result.value
    }
    await run(`import('/test.js').then(() => window.api.init())`)
    run.activate = () => cdp('Page.bringToFront')
    return run
  }
  const phone = await open(`http://127.0.0.1:${webPort}`)
  const pc = await open(`http://localhost:${webPort}`)
  const code = async () => (await admin('POST', '/api/pair')).code

  // 1. first sync: phone data reaches the PC
  const a = await phone(`api.add('MVP', 35000)`)
  const b = await phone(`api.add('Nova', 12000)`)
  await phone(`api.pair('localhost', '${await code()}')`)
  check(await phone('api.keyIsSafe()'), 'private key is extractable')
  let st = await phone('api.status()')
  check(st.phase === 'idle' && st.pending === 0 && st.lastSyncAt, `first sync status ${JSON.stringify(st)}`)
  check(Object.keys(server.db.records).filter((k) => k.startsWith('operation:')).length === 2, 'server did not receive operations')
  console.log('PASS pairing with non-extractable key, first sync phone → PC')

  // 2. second device receives everything, edits propagate both ways
  await pc(`api.pair('localhost', '${await code()}')`)
  check(JSON.stringify(await pc('api.live()')) === JSON.stringify(await phone('api.live()')), 'second device did not get the same data')
  await pc(`api.edit('${b}', { title: 'Nova Agency' })`); await pc('api.sync()'); await phone('api.sync()')
  check((await phone(`api.op('${b}')`)).title === 'Nova Agency', 'edit from PC did not reach phone')
  const hist = await phone(`api.history('${b}')`)
  check(hist.some((h) => h.via === 'sync'), 'synced change missing from history')
  console.log('PASS second device full download, two-way edits, history entries for synced changes')

  // 3. Wi-Fi gone: phone keeps working, then catches up
  await server.stop()
  const c = await phone(`api.add('Offline income', 500)`)
  st = await phone('api.sync()')
  check(st.phase === 'offline' && st.pending === 1, `offline status ${JSON.stringify(st)}`)
  check(await phone(`api.op('${c}')`), 'offline operation not stored locally')
  server = await startSync()
  st = await phone('api.sync()')
  check(st.phase === 'idle' && st.pending === 0, `reconnect status ${JSON.stringify(st)}`)
  st = await pc('api.sync()')
  check(await pc(`api.op('${c}')`), `offline operation did not reach PC after reconnect ${JSON.stringify(st)} server has ${Object.keys(server.db.records).filter((k) => k.includes(c)).length}`)
  console.log('PASS offline save, offline status with pending count, automatic catch-up after reconnect')

  // 4. lost acknowledgement → same operation sent again → no duplicate
  const before = Object.keys(server.db.records).length
  await phone('api.forgetAcks()')
  check(await phone('api.pending()') > 0, 'nothing pending after lost acks')
  st = await phone('api.sync()')
  check(st.pending === 0 && Object.keys(server.db.records).length === before, 'resend created duplicates')
  check((await phone('api.live()')).length === 3 && (await pc('api.live()')).length === 3, 'duplicate operations appeared')
  console.log('PASS resending already-delivered operations is idempotent (no duplicates)')

  // 5. simultaneous edits on two devices
  await phone(`api.edit('${a}', { note: 'аванс' })`)
  await pc(`api.edit('${a}', { title: 'MVP Studio' })`)
  await phone('api.sync()'); await pc('api.sync()'); await phone('api.sync()')
  const pa = await phone(`api.op('${a}')`); const ca = await pc(`api.op('${a}')`)
  check(pa.note === 'аванс' && pa.title === 'MVP Studio' && ca.note === 'аванс' && ca.title === 'MVP Studio', 'different-field edits did not merge')
  check(!(await phone('api.conflicts()')).length, 'field merge reported a conflict')
  await phone(`api.edit('${a}', { amount: 40000 })`)
  await new Promise((r) => setTimeout(r, 20))
  await pc(`api.edit('${a}', { amount: 45000 })`)
  await phone('api.sync()'); await pc('api.sync()'); await phone('api.sync()')
  const p2 = await phone(`api.op('${a}')`); const c2 = await pc(`api.op('${a}')`)
  check(p2.amount === 45000 && c2.amount === 45000, `same-field conflict: phone ${p2.amount}, pc ${c2.amount}`)
  const conflicts = await phone('api.conflicts()')
  check(conflicts.length === 1 && conflicts[0].other.data.amount === 40000, 'conflict with both versions not reported')
  await phone(`api.resolve('other')`); await pc('api.sync()'); await phone('api.sync()')
  check((await phone(`api.op('${a}')`)).amount === 40000 && (await pc(`api.op('${a}')`)).amount === 40000, 'choosing the other version failed')
  check(!(await phone('api.conflicts()')).length, 'resolved conflict still listed')
  console.log('PASS simultaneous edits: field merge, newer wins with both versions kept, user can pick the other one')

  // 6. deletion propagates as a soft delete
  await phone(`api.remove('${c}')`); await phone('api.sync()'); await pc('api.sync()')
  check((await pc(`api.op('${c}')`)).deletedAt && !(await pc('api.live()')).some((o) => o.id === c), 'deletion did not propagate')
  console.log('PASS deletions propagate as recoverable soft deletes')

  // 7. local write failure while applying synced data → nothing lost, retried
  await phone(`api.edit('${a}', { title: 'MVP Final' })`); await phone('api.sync()')
  await pc('api.failNextWrite()')
  st = await pc('api.sync()')
  check(st.phase === 'error', 'local write failure not reported')
  check((await pc(`api.op('${a}')`)).title !== 'MVP Final', 'failed write applied anyway')
  st = await pc('api.sync()')
  check(st.phase === 'idle' && (await pc(`api.op('${a}')`)).title === 'MVP Final', 'retry after failed local write did not recover')
  console.log('PASS failed local write is reported, not acknowledged, and recovered on retry')

  // 8. backups on the PC: list, preview, protective copy, restore as edits
  const made = await phone('api.makeBackup()')
  await phone(`api.edit('${a}', { amount: 1 })`); await phone(`api.remove('${b}')`); await phone('api.sync()')
  const list = await phone('api.backups()')
  check(list.some((x) => x.file === made.file && x.valid && x.counts.operations === 2), 'backup list wrong')
  const r = await phone(`api.restore('${made.file}')`)
  check(r.restored === 1 && r.changed === 1, `restore plan ${JSON.stringify(r)}`)
  check((await phone(`api.op('${a}')`)).amount === 40000 && !(await phone(`api.op('${b}')`)).deletedAt, 'restore did not bring data back')
  check((await phone('api.backups()')).some((x) => x.kind === 'pre-restore'), 'no protective copy before restore')
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc(`api.op('${a}')`)).amount === 40000 && !(await pc(`api.op('${b}')`)).deletedAt, 'restored data did not sync to PC')
  console.log('PASS PC backups: list with counts, protective copy, restore applied as syncable edits')

  // New planning is negotiated; old devices never receive unknown kinds.
  await phone("api.planSave({id:'synthetic-balance',kind:'balance',amount:100000,at:new Date().toISOString()})")
  await phone("api.planSave({id:'synthetic-rent',kind:'envelope',name:'Synthetic rent',mode:'obligation',target:75000,priority:1,frequency:'monthly',due:'2026-11-20',state:'active'})")
  await phone("api.planSave({id:'synthetic-goal',kind:'envelope',name:'Synthetic goal',mode:'goal',target:50000,priority:2,frequency:'once',state:'active'})")
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.plan()')).length === 3, 'Planning definitions not synced')
  await phone("api.draftReserve('synthetic-rent-reserve',75000,'synthetic-rent')")
  check((await phone('api.planMoney()')).reserved === 0, 'Pending reserve counted before confirmation')
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserved === 75000, 'Confirmed reserve not delivered')
  await phone("api.draftReserve('synthetic-concurrent-phone',20000,'synthetic-goal')")
  await pc("api.draftReserve('synthetic-concurrent-pc',20000,'synthetic-goal')")
  await phone('api.sync()'); await pc('api.sync()'); await phone('api.sync()')
  check((await pc('api.planMoney()')).reserved === 95000, 'Concurrent reserves exceeded funds')
  check((await pc('api.plan()')).some((r) => r.id === 'synthetic-concurrent-pc' && r.status === 'rejected'), 'Stale reserve did not require review')
  console.log('PASS planning definitions and confirmations sync; concurrent allocation cannot over-reserve')
  await pc('api.legacyMode(true)')
  await pc("api.draftReserve('synthetic-legacy-pending',100,'synthetic-goal')")
  await pc("api.add('Synthetic legacy-capability income',100)")
  st = await pc('api.sync()')
  check(st.planningSupported === false && st.phase === 'idle', 'Legacy capability mode broke ordinary sync')
  check((await pc('api.plan()')).find((r) => r.id === 'synthetic-legacy-pending').status === 'pending', 'Legacy server confirmed a reserve')
  await pc('api.legacyMode(false)'); await pc('api.sync()'); await phone('api.sync()')
  check((await pc('api.plan()')).find((r) => r.id === 'synthetic-legacy-pending').status === 'confirmed', 'Pending request did not resume after capability upgrade')
  console.log('PASS old-server compatibility: ordinary operations continue, reserve waits for capability upgrade')
  const payment = await phone("api.payReserve('synthetic-rent')")
  const freeBeforePay = (await pc('api.planMoney()')).free
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).free === freeBeforePay && (await pc('api.planMoney()')).reserves['synthetic-rent'] === 0, 'Reserve payment double-debited free balance')
  await phone(`api.edit('${payment}', {amount:50000})`); await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves['synthetic-rent'] === 25000, 'Edited payment reserve wrong')
  await phone(`api.remove('${payment}')`); await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves['synthetic-rent'] === 75000, 'Deleted payment did not restore reserve')
  const planBackup = await phone('api.makeBackup()')
  check((await phone('api.backups()')).some((b) => b.file === planBackup.file && b.valid), 'Planning backup not verified')
  await phone(`api.restore('${planBackup.file}')`); await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves['synthetic-rent'] === 75000, 'Planning backup restore duplicated reserve')
  console.log('PASS linked payment edit/delete, v2 PC backup and restore without double reserve')
  const beforeSimple = await phone('api.planMoney()')
  const simple = await phone('api.createSimple()')
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves[simple.id] === 1000, 'Atomic initial reserve did not sync')
  const operationsBeforeClose = JSON.stringify(await phone('api.live()'))
  await phone('api.closeSimple(' + JSON.stringify(simple.id) + ')'); await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves[simple.id] === 0 && (await pc('api.planMoney()')).free === beforeSimple.free, 'Closing plan did not release reserve across devices')
  check((await pc('api.plan()')).find((r) => r.id === simple.id)?.state === 'closed' && JSON.stringify(await phone('api.live()')) === operationsBeforeClose, 'Closing plan removed financial operations or journal')
  console.log('PASS simple-plan atomic initial reserve and safe close/release sync without income or expense')

  // Automatic reserve confirmation includes bounded stale-revision retry; no manual sync call.
  const waitAutomaticReserve = async (expected) => {
    for (let n = 0; n < 120; n++) {
      if ((await phone('api.planMoney()')).reserves['synthetic-goal'] === expected) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('Automatic reserve did not confirm: ' + JSON.stringify({expected, status: await phone('api.status()'), money: await phone('api.planMoney()'), events: await phone("api.plan().filter(r=>r.kind==='movement').map(r=>({id:r.id,status:r.status,reason:r.reason}))")}))
  }
  await phone.activate()
  let goalReserve = (await phone('api.planMoney()')).reserves['synthetic-goal']
  await phone('api.staleOnce()')
  await phone("api.reserveAutomatic(100, 'synthetic-goal')")
  await waitAutomaticReserve(goalReserve + 100)
  check(!(await phone('api.plan()')).some((r) => r.kind === 'movement' && r.reason?.includes('Конфликт команды')), 'Transient stale revision required manual review')
  await server.stop()
  goalReserve = (await phone('api.planMoney()')).reserves['synthetic-goal']
  await phone("api.reserveAutomatic(100, 'synthetic-goal')")
  check((await phone('api.planMoney()')).reserves['synthetic-goal'] === goalReserve, 'Offline reserve was shown as confirmed')
  server = await startSync()
  await phone("Promise.resolve(window.dispatchEvent(new Event('online')))")
  await waitAutomaticReserve(goalReserve + 100)
  await pc('api.sync()')
  check((await pc('api.planMoney()')).reserves['synthetic-goal'] === goalReserve + 100, 'Automatic reconnect duplicated or lost reserve')
  console.log('PASS automatic reserve confirmation, stale retry and offline → online catch-up without manual confirmation')

  // 9. server restart keeps everything
  const total = Object.keys(server.db.records).length
  await server.stop(); server = await startSync()
  check(Object.keys(server.db.records).length === total, 'server lost records on restart')
  st = await phone('api.sync()')
  check(st.phase === 'idle' && st.pending === 0, 'sync after server restart failed')
  console.log('PASS server restart keeps data; sync continues')

  // 10. invoices: issued on the phone reach the PC; numbers stay unique across devices
  const { clientId } = await phone('api.invSetup()')
  const code1 = await phone(`api.invIssue('${clientId}', 'Sesión A')`)
  check(code1 === 'F-0026', `first invoice code ${code1}`)
  st = await phone('api.sync()')
  check(st.phase === 'idle' && st.pending === 0 && await phone('api.invoicingSupported()'), `invoice sync status ${JSON.stringify(st)}`)
  await pc('api.sync()')
  const pcInv = await pc('api.invList()')
  check(pcInv.some((i) => i.code === 'F-0026' && i.status === 'issued'), 'issued invoice did not reach the PC')
  check((await pc(`api.invCanIssueHere('${clientId}')`)).some((p) => p.includes('другом устройстве')), 'PC may issue numbers of the phone series')
  await pc('api.invForgeDuplicate()')
  st = await pc('api.sync()')
  check(st.rejected > 0, 'server accepted a duplicate invoice number')
  await phone('api.sync()')
  check(!(await phone('api.invList()')).some((i) => i.id === 'inv-forged'), 'duplicate number reached the phone')
  check(await phone(`api.invIssue('${clientId}', 'Sesión B')`) === 'F-0027', 'second invoice code')
  await phone('api.sync()'); await pc('api.sync()')
  check((await pc('api.invList()')).some((i) => i.code === 'F-0027'), 'second invoice did not reach the PC')
  console.log('PASS invoices sync phone → PC; series issued from one device; server rejects a duplicate number')

  // 11. balance corrections: reach the PC once, never applied twice, new operations move both balances
  await phone('api.sync()'); await pc('api.sync()')
  const b0 = await phone('api.balance()')
  await phone(`api.balanceSet(${(b0 ?? 0) - 4000}, 'Комиссия банка')`)
  await phone('api.sync()'); await pc('api.sync()')
  check(await pc('api.balance()') === (b0 ?? 0) - 4000, 'correction did not reach the PC')
  const serverBalances = () => Object.values(server.db.records).filter((r) => r.entity === 'planning' && r.data.kind === 'balance').length
  const n1 = serverBalances()
  await phone('api.forgetAcks()'); await phone('api.sync()'); await pc('api.sync()')
  check(serverBalances() === n1 && (await pc('api.balanceHistory()')).length === (await phone('api.balanceHistory()')).length, 'resent correction duplicated')
  check(await phone('api.balance()') === (b0 ?? 0) - 4000, 'resend applied the correction twice')
  await pc(`api.add('Расход на ПК', 1000)`)
  await pc('api.sync()'); await phone('api.sync()')
  check(await phone('api.balance()') === await pc('api.balance()'), 'balances differ after a new operation')
  console.log('PASS balance correction syncs phone → PC once; resend does not apply it twice; later operations move both balances equally')
  console.log('All sync regressions passed')
} catch (e) {
  failed = true
  console.error(e.message)
} finally {
  for (const s of sockets) s.close()
  browser.kill()
  web.close()
  await server.stop()
  await new Promise((r) => setTimeout(r, 300))
  try { if (!realpathSync(work).startsWith(realpathSync(resolve('node_modules/.cache')) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe test cleanup path'); rmSync(work, { recursive: true, force: true }) } catch { /* Chrome may still hold the profile */ }
  process.exit(failed ? 1 : 0)
}
