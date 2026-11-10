// End-to-end: real HTTPS server in a temporary folder (never the real data folders).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { startServer } from '../server.mjs'
import { saveJson, loadJson } from '../lib/files.mjs'
import { change, httpsJson, makeDevice, op } from './helpers.mjs'

const home = mkdtempSync(join(tmpdir(), 'financy-sync-test-'))
const backupDir = join(home, 'backups')
const start = (extra = {}) => startServer({ home, quiet: true, noExit: true, port: 0, httpPort: 0, adminPort: 0, config: { backupDir }, backupCheckMs: 50, ...extra })
const adminCall = (port, method, path, body, header = true) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : ''
  const req = request({ host: '127.0.0.1', port, method, path, headers: header ? { 'X-Financy-Admin': '1', 'Content-Type': 'application/json' } : {} }, (res) => {
    let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t) } catch { return null } })() }))
  })
  req.on('error', reject); req.end(data)
})

test('pairing, signed sync, retries, failures, conflicts, backups and restart', async (t) => {
  let s = await start()
  const ca = s.certs.caPem()
  const port = () => s.ports.sync

  await t.test('ping is public, sync is not', async () => {
    const ping = await httpsJson(port(), ca, 'GET', '/ping')
    assert.equal(ping.json.app, 'financy-sync')
    const anon = await httpsJson(port(), ca, 'GET', '/sync/pull?since=0')
    assert.equal(anon.status, 401)
  })

  const phone = await makeDevice(port, ca)
  await t.test('pairing needs the one-time code and locks after 5 wrong attempts', async () => {
    assert.equal((await phone.pair('123456')).status, 403) // no code issued yet
    assert.equal((await adminCall(s.ports.admin, 'POST', '/api/pair', null, false)).status, 403) // CSRF guard
    let { json } = await adminCall(s.ports.admin, 'POST', '/api/pair')
    const wrong = json.code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 4; i++) assert.equal((await phone.pair(wrong)).json.error, 'wrong')
    assert.equal((await phone.pair(wrong)).json.error, 'locked')
    assert.equal((await phone.pair(json.code)).status, 403)
    ;({ json } = await adminCall(s.ports.admin, 'POST', '/api/pair'))
    const ok = await phone.pair(json.code)
    assert.equal(ok.status, 200); assert.ok(ok.json.deviceId.startsWith('dev-'))
    assert.equal((await phone.pair(json.code)).status, 403) // single use
    const stored = readFileSync(join(home, 'devices.json'), 'utf8')
    assert.ok(!stored.includes('"d"'), 'private key must never reach the server')
  })

  await t.test('signatures: tampered body, replay, clock skew and foreign origins are refused', async () => {
    const nonce = 'abcdefghijklmnopqrstuv'
    assert.equal((await phone.signed('GET', '/sync/pull?since=0', undefined, { nonce })).status, 200)
    assert.equal((await phone.signed('GET', '/sync/pull?since=0', undefined, { nonce })).json.error, 'replay')
    assert.equal((await phone.signed('GET', '/sync/pull?since=0', undefined, { time: Date.now() - 3600e3 })).json.error, 'clock')
    assert.equal((await phone.signed('POST', '/sync/push', { changes: [change(op('x1'))] }, { tamper: true })).json.error, 'signature')
    const pre = await httpsJson(port(), ca, 'OPTIONS', '/sync/push', undefined, { Origin: 'https://evil.example' })
    assert.equal(pre.headers['access-control-allow-origin'], undefined)
    const good = await httpsJson(port(), ca, 'OPTIONS', '/sync/push', undefined, { Origin: phone.origin })
    assert.equal(good.headers['access-control-allow-origin'], phone.origin)
  })

  await t.test('push is acknowledged only after saving; resending is harmless', async () => {
    const r = await phone.signed('POST', '/sync/push', { changes: [change(op('a')), change(op('b'))] })
    assert.deepEqual(r.json.results.map((x) => x.status), ['accepted', 'accepted'])
    const again = await phone.signed('POST', '/sync/push', { changes: [change(op('a'))] })
    assert.equal(again.json.results[0].status, 'same')
    assert.equal(Object.keys(loadJson(join(home, 'sync-db.json'), () => null).records).length, 2)
  })

  await t.test('a failed disk write is not acknowledged and loses nothing', async () => {
    const dbFile = join(home, 'sync-db.json')
    const good = readFileSync(dbFile)
    rmSync(dbFile); mkdirSync(dbFile) // make the next save fail
    const r = await phone.signed('POST', '/sync/push', { changes: [change(op('c'))] })
    assert.equal(r.status, 503)
    rmSync(dbFile, { recursive: true }); writeFileSync(dbFile, good)
    const pulled = await phone.signed('GET', '/sync/pull?since=0')
    assert.deepEqual(pulled.json.records.map((x) => x.id).sort(), ['a', 'b'])
    const retry = await phone.signed('POST', '/sync/push', { changes: [change(op('c'))] })
    assert.equal(retry.json.results[0].status, 'accepted')
  })

  const pc = await makeDevice(port, ca, 'http://localhost:5173')
  await t.test('second device: pulls everything, concurrent edit conflict keeps both versions', async () => {
    const { json } = await adminCall(s.ports.admin, 'POST', '/api/pair')
    await pc.pair(json.code)
    const all = await pc.signed('GET', '/sync/pull?since=0')
    assert.equal(all.json.records.length, 3)
    const revA = all.json.records.find((r) => r.id === 'a').rev
    await pc.signed('POST', '/sync/push', { changes: [change(op('a', { amount: 2000, updatedAt: '2026-11-02T00:00:00.000Z' }), revA)] })
    const r = await phone.signed('POST', '/sync/push', { changes: [change(op('a', { amount: 5000, updatedAt: '2026-11-03T00:00:00.000Z' }), revA)] })
    assert.equal(r.json.results[0].status, 'conflict')
    assert.equal(r.json.results[0].data.amount, 5000)
    const st = await phone.signed('GET', '/sync/status')
    assert.equal(st.json.conflicts.length, 1)
    assert.equal(st.json.conflicts[0].other.data.amount, 2000)
    const res = await phone.signed('POST', '/sync/conflicts/resolve', { id: st.json.conflicts[0].id })
    assert.equal(res.json.ok, true)
    assert.equal((await phone.signed('GET', '/sync/status')).json.conflicts.length, 0)
  })

  await t.test('revoked device is refused', async () => {
    await adminCall(s.ports.admin, 'POST', '/api/devices/revoke', { id: pc.id })
    assert.equal((await pc.signed('GET', '/sync/pull?since=0')).json.error, 'unknown-device')
  })

  await t.test('weekly backup after fresh data, verified, compatible with the app format', async () => {
    for (let i = 0; i < 40 && !s.state.lastBackupFile; i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(s.state.lastBackupFile, 'first backup made after the first sync')
    const list = await phone.signed('GET', '/backups')
    assert.equal(list.json.backups.length, 1); assert.equal(list.json.backups[0].valid, true)
    const file = await phone.signed('GET', `/backups/file?name=${encodeURIComponent(list.json.backups[0].file)}`)
    assert.equal(file.json.app, 'finance-pwa'); assert.equal(file.json.version, 1); assert.equal(file.json.operations.length, file.json.counts.operations); assert.ok(file.json.operations.length >= 2)
    assert.equal((await phone.signed('GET', '/backups/file?name=..%2Fdevices.json')).status, 500)
    const pre = await phone.signed('POST', '/backups', { kind: 'pre-restore' })
    assert.equal(pre.json.kind, 'pre-restore')
  })

  await t.test('retention keeps the newest copy and never touches foreign files', async () => {
    const old = (d) => `financy-backup-${d}_10-00-00-weekly.json`
    const fakeOld = JSON.parse(readFileSync(join(backupDir, readdirSync(backupDir).find((f) => f.endsWith('-weekly.json'))), 'utf8'))
    for (const d of ['2026-08-01', '2026-09-01']) {
      const { integrity, ...body } = { ...fakeOld, exportedAt: `${d}T10:00:00.000Z` }; void integrity
      const { canonical, sha256 } = await import('../lib/canonical.mjs')
      writeFileSync(join(backupDir, old(d)), JSON.stringify({ ...body, integrity: { algorithm: 'sha256', hash: sha256(canonical(body)) } }))
    }
    writeFileSync(join(backupDir, 'my-notes.json'), '{}')
    writeFileSync(join(backupDir, old('2026-07-01')), 'damaged')
    const made = (await adminCall(s.ports.admin, 'POST', '/api/backup-now')).json
    const files = readdirSync(backupDir)
    assert.ok(files.includes(made.file))
    assert.ok(!files.includes(old('2026-08-01')) && !files.includes(old('2026-09-01')), 'old copies pruned')
    assert.ok(files.includes('my-notes.json') && files.includes(old('2026-07-01')), 'foreign/damaged files kept')
  })

  await t.test('restart: data survives, overdue weekly backup runs only after the phone syncs', async () => {
    await s.stop()
    const statePath = join(home, 'state.json')
    const st = loadJson(statePath, () => ({}))
    saveJson(statePath, { ...st, lastBackupAt: new Date(Date.now() - 8 * 864e5).toISOString(), lastBackupFile: 'old' })
    s = await start()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(s.state.lastBackupFile, 'old', 'no backup before fresh data')
    assert.equal(Object.keys(s.db.records).length, 3, 'records survived restart')
    await phone.signed('GET', '/sync/pull?since=0')
    for (let i = 0; i < 40 && s.state.lastBackupFile === 'old'; i++) await new Promise((r) => setTimeout(r, 50))
    assert.notEqual(s.state.lastBackupFile, 'old', 'overdue backup made after the phone synced')
  })

  await s.stop()
  rmSync(home, { recursive: true, force: true })
  assert.ok(!existsSync(home))
})
