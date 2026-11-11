// Financy local sync server for Windows (also runs on macOS/Linux for development).
//   https://<pc>:47821  sync API for paired devices (signed requests only)
//   http://<pc>:47820   only the public CA certificate + setup instructions for the iPhone
//   http://127.0.0.1:47822  admin page, reachable from this computer only
// No cloud, no dependencies. Data: %LOCALAPPDATA%\Financy-Sync, backups: D:\CODEX\Financy\Backups.
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { canonical, sha256 } from './lib/canonical.mjs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import { applyPush, commitPlanning, emptyDb, openConflicts, pull, resolveConflict, snapshot } from './lib/engine.mjs'
import { loadJson, saveJson } from './lib/files.mjs'
import { backupDue, createBackup, listBackups, pruneBackups, readBackup } from './lib/backups.mjs'
import { Pairing, Verifier, newDeviceId, validPublicJwk } from './lib/auth.mjs'
import { Certs, findOpenssl, lanAddresses, localName } from './lib/tls.mjs'

export const VERSION = '1.2.1'
const here = dirname(fileURLToPath(import.meta.url))

export function defaultHome() {
  return process.env.FINANCY_SYNC_HOME || join(process.env.LOCALAPPDATA || join(process.env.HOME || '.', '.local', 'share'), 'Financy-Sync')
}

/** Starts all listeners. Returns a handle for tests and for safe shutdown. */
export async function startServer(opts = {}) {
  const home = opts.home ?? defaultHome()
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logFile = join(home, 'logs', 'server.log')
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`
    if (!opts.quiet) process.stdout.write(line)
    try {
      if (existsSync(logFile) && statSync(logFile).size > 1024 * 1024) renameSync(logFile, `${logFile}.1`)
      appendFileSync(logFile, line)
    } catch { /* logging must never stop the server */ }
  }

  const cfgPath = join(home, 'config.json')
  // defaults fill anything missing (the installer writes only paths); a saved serverId is kept
  const config = {
    serverId: `srv-${randomBytes(9).toString('base64url')}`,
    serverName: hostname(),
    backupDir: process.env.FINANCY_BACKUP_DIR || (process.platform === 'win32' ? 'D:\\CODEX\\Financy\\Backups' : join(home, 'backups')),
    port: 47821, httpPort: 47820, adminPort: 47822,
    ...loadJson(cfgPath, () => ({}), log),
  }
  Object.assign(config, opts.config ?? {})
  saveJson(cfgPath, config)

  const devPath = join(home, 'devices.json')
  const dbPath = join(home, 'sync-db.json')
  const statePath = join(home, 'state.json')
  let devices = loadJson(devPath, () => [], log)
  let db = loadJson(dbPath, () => emptyDb(config.serverId), log)
  const state = { lastBackupAt: null, lastBackupFile: null, lastBackupError: null, lastDeviceSyncAt: null, ...loadJson(statePath, () => ({}), log), startedAt: Date.now() }
  const saveState = () => { try { const { startedAt, ...rest } = state; void startedAt; saveJson(statePath, rest) } catch (e) { log(`ERROR state save: ${e.message}`) } }

  const certs = new Certs(join(home, 'tls'), opts.openssl ?? findOpenssl(config.openssl))
  if (certs.ensureCA()) log('created root certificate Financy Sync CA')
  if (certs.ensureLeaf(opts.hosts)) log(`issued server certificate for ${[localName(), ...lanAddresses()].join(', ')}`)

  const pairing = new Pairing()
  const verifier = new Verifier()
  const hosts = () => [...new Set([...(opts.hosts ?? []), localName(), ...lanAddresses()])]

  /* ---------------- backups ---------------- */
  const makeBackup = (kind) => {
    try {
      const made = createBackup(config.backupDir, db, kind)
      state.lastBackupAt = made.createdAt
      state.lastBackupFile = made.file
      state.lastBackupError = null
      const removed = pruneBackups(config.backupDir, made.file)
      saveState()
      log(`backup ${made.file} (${made.counts.operations} operations, ${made.counts.clients} clients)${removed.length ? `; removed old: ${removed.join(', ')}` : ''}`)
      return made
    } catch (e) {
      state.lastBackupError = e.message
      saveState()
      log(`ERROR backup failed: ${e.message}`)
      throw e
    }
  }
  const maybeBackup = () => {
    if (!Object.keys(db.records).length || !backupDue(state)) return
    try { makeBackup('weekly') } catch { /* retried on the next check */ }
  }
  const backupTimer = setInterval(maybeBackup, opts.backupCheckMs ?? 10 * 60 * 1000)

  /* ---------------- helpers ---------------- */
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
    res.end(text)
  }
  const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  const parse = (text) => { try { return JSON.parse(text || '{}') } catch { throw Object.assign(new Error('bad json'), { status: 400 }) } }
  const origins = () => new Set(devices.filter((d) => !d.revoked && d.origin).map((d) => d.origin))
  const cors = (req, open) => {
    const origin = req.headers.origin
    if (!origin || (!open && !origins().has(origin))) return {}
    return {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'content-type, x-financy-device, x-financy-time, x-financy-nonce, x-financy-signature',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600',
      'Access-Control-Allow-Private-Network': 'true',
    }
  }
  const saveDevices = () => saveJson(devPath, devices)

  /* ---------------- sync API (HTTPS) ---------------- */
  const api = async (req, res) => {
    const url = new URL(req.url, 'https://x')
    const path = url.pathname
    const open = path === '/ping' || path === '/pair'
    const h = cors(req, open)
    if (req.method === 'OPTIONS') return send(res, 204, '', h)
    try {
      if (path === '/ping' && req.method === 'GET')
        return send(res, 200, { app: 'financy-sync', capabilities: ['planning-v2', 'invoicing-v1'], version: VERSION, serverId: config.serverId, name: config.serverName, hosts: hosts(), time: Date.now() }, h)

      if (path === '/pair' && req.method === 'POST') {
        const body = parse(await readBody(req, 64 * 1024))
        if (!validPublicJwk(body.publicKey)) return send(res, 400, { error: 'bad-key' }, h)
        const result = pairing.check(body.code)
        if (result !== 'ok') { log(`pairing refused (${result}) from ${req.socket.remoteAddress}`); return send(res, 403, { error: result }, h) }
        const device = {
          id: newDeviceId(), name: String(body.deviceName ?? 'iPhone').slice(0, 60), publicKey: { kty: 'EC', crv: 'P-256', x: body.publicKey.x, y: body.publicKey.y },
          origin: req.headers.origin ?? null, pairedAt: new Date().toISOString(), lastSeenAt: null, revoked: false,
        }
        devices = [...devices, device]
        saveDevices()
        log(`paired device ${device.name} (${device.id}) origin ${device.origin}`)
        return send(res, 200, { deviceId: device.id, serverId: config.serverId, name: config.serverName, hosts: hosts() }, { ...h, ...cors(req, true) })
      }

      const raw = req.method === 'POST' ? await readBody(req) : ''
      const auth = verifier.check(devices, req, path + url.search, raw)
      if (!auth.ok) { log(`refused ${req.method} ${path}: ${auth.reason} from ${req.socket.remoteAddress}`); return send(res, 401, { error: auth.reason }, h) }
      const device = auth.device
      const touch = () => { device.lastSeenAt = new Date().toISOString(); state.lastDeviceSyncAt = device.lastSeenAt; try { saveDevices() } catch { /* not critical */ } }

      if (path === '/sync/push' && req.method === 'POST') {
        const body = parse(raw)
        if (!Array.isArray(body.changes) || body.changes.length > 2000) return send(res, 400, { error: 'bad-changes' }, h)
        const next = applyPush(db, device.id, body.changes)
        if (next.changed) {
          try { saveJson(dbPath, next.db) } catch (e) {
            log(`ERROR could not save sync data: ${e.message}`)
            return send(res, 503, { error: 'storage' }, h) // nothing acknowledged → the phone keeps its changes and retries
          }
          db = next.db
        }
        const counts = next.results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {})
        if (next.changed || counts.rejected) log(`push from ${device.name}: ${JSON.stringify(counts)}`)
        touch(); saveState()
        setImmediate(maybeBackup)
        return send(res, 200, { results: next.results, seq: db.seq }, h)
      }
      if (path === '/planning/commit' && req.method === 'POST') {
        const command = parse(raw)
        const result = commitPlanning(db, device.id, command.event, command.baseSeq)
        if (result.error) return send(res, 409, { error: result.error }, h)
        if (result.db !== db) { saveJson(dbPath, result.db); db = result.db }
        touch(); saveState()
        return send(res, 200, { record: result.record, seq: db.seq }, h)
      }
      if (path === '/sync/pull' && req.method === 'GET') {
        const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500))
        touch()
        return send(res, 200, { ...pull(db, since, limit, url.searchParams.get('planning') === '2', url.searchParams.get('invoicing') === '1'), serverId: config.serverId }, h)
      }
      if (path === '/sync/status' && req.method === 'GET') {
        return send(res, 200, {
          serverId: config.serverId, name: config.serverName, version: VERSION, seq: db.seq, hosts: hosts(),
          lastBackupAt: state.lastBackupAt, lastBackupError: state.lastBackupError, conflicts: openConflicts(db).filter((c) => url.searchParams.get('planning') === '2' || c.entity !== 'planning'),
        }, h)
      }
      if (path === '/sync/conflicts/resolve' && req.method === 'POST') {
        const r = resolveConflict(db, String(parse(raw).id ?? ''))
        if (!r.ok) return send(res, 404, { error: 'not-found' }, h)
        saveJson(dbPath, r.db); db = r.db
        return send(res, 200, { ok: true }, h)
      }
      if (path === '/backups' && req.method === 'GET') return send(res, 200, { backups: listBackups(config.backupDir), dir: config.backupDir }, h)
      if (path === '/backups/file' && req.method === 'GET') {
        const backup = readBackup(config.backupDir, String(url.searchParams.get('name') ?? ''))
        if (url.searchParams.get('invoicing') === '1') return send(res, 200, backup, h)
        // An older app can still restore its known data. Never expose record kinds it does not know.
        if (url.searchParams.get('planning') === '2') {
          const { invoicing: _inv, integrity: _i, ...known } = backup
          known.version = 2
          return send(res, 200, { ...known, integrity: { algorithm: 'sha256', hash: sha256(canonical(known)) } }, h)
        }
        const { planning: _planning, invoicing: _invoicing, integrity: _integrity, ...legacy } = backup
        legacy.version = 1
        return send(res, 200, { ...legacy, integrity: { algorithm: 'sha256', hash: sha256(canonical(legacy)) } }, h)
      }
      if (path === '/backups' && req.method === 'POST') {
        const kind = parse(raw).kind === 'pre-restore' ? 'pre-restore' : 'manual'
        return send(res, 200, makeBackup(kind), h)
      }
      return send(res, 404, { error: 'not-found' }, h)
    } catch (e) {
      log(`ERROR ${req.method} ${path}: ${e.message}`)
      return send(res, e.status ?? 500, { error: e.status ? e.message : 'server' }, h)
    }
  }

  /* ---------------- CA download (plain HTTP, public certificate only) ---------------- */
  const caPage = (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/ca.crt') {
      return send(res, 200, certs.caPem().toString(), { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="Financy-Sync-CA.crt"' })
    }
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Financy Sync</title><body style="margin:0;background:#06070D;color:#F2F3F8;font:16px/1.5 -apple-system,system-ui,sans-serif;padding:28px 20px">
<h1 style="font-size:24px;margin:0 0 8px">Сертификат Financy</h1>
<p style="color:#8B90A6">Нужен один раз, чтобы iPhone безопасно соединялся с этим компьютером.</p>
<ol style="padding-left:20px"><li>Нажмите кнопку ниже → «Разрешить».</li><li>«Настройки» → «Профиль загружен» → «Установить».</li>
<li>«Настройки» → «Основные» → «Об этом устройстве» → «Доверие сертификатам» → включите «Financy Sync CA».</li>
<li>Вернитесь в Financy → «Настройки» → «Подключить компьютер».</li></ol>
<a href="/ca.crt" style="display:block;margin-top:22px;padding:15px;border-radius:16px;text-align:center;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(120deg,#7c8cff,#9f6bff)">Скачать сертификат</a>
<p style="color:#8B90A6;font-size:13px;margin-top:18px">Отпечаток SHA-256: ${certs.caFingerprint()}</p></body>`)
    }
    return send(res, 404, 'not found')
  }

  /* ---------------- admin (127.0.0.1 only) ---------------- */
  const adminHtml = () => readFileSync(join(here, 'admin.html'), 'utf8')
  let stopping = null
  const admin = async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(res, 421, 'wrong host') // DNS-rebinding guard
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' })
      return res.end(adminHtml())
    }
    // a custom header forces a CORS preflight, which we never answer → other websites cannot call this
    if (req.headers['x-financy-admin'] !== '1') return send(res, 403, { error: 'forbidden' })
    try {
      const raw = req.method === 'POST' ? await readBody(req, 64 * 1024) : ''
      const p = url.pathname
      if (p === '/api/status') return send(res, 200, {
        version: VERSION, serverName: config.serverName, serverId: config.serverId, hosts: hosts(), ports: { sync: ports.sync, ca: ports.ca },
        backupDir: config.backupDir, home, seq: db.seq, counts: Object.fromEntries(Object.entries(snapshot(db)).map(([k, v]) => [k, v.filter((r) => !r.deletedAt).length])), state, pairing: pairing.active() ? { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() } : null,
        devices: devices.map(({ publicKey, ...d }) => { void publicKey; return d }), conflicts: openConflicts(db).length, caFingerprint: certs.caFingerprint(),
      })
      if (p === '/api/pair' && req.method === 'POST') { const r = pairing.start(); log('pairing code issued'); return send(res, 200, r) }
      if (p === '/api/pair/cancel' && req.method === 'POST') { pairing.cancel(); return send(res, 200, { ok: true }) }
      if (p === '/api/devices/revoke' && req.method === 'POST') {
        const id = parse(raw).id
        devices = devices.map((d) => (d.id === id ? { ...d, revoked: true, revokedAt: new Date().toISOString() } : d))
        verifier.forget(id); saveDevices(); log(`device ${id} disconnected`)
        return send(res, 200, { ok: true })
      }
      if (p === '/api/backups') return send(res, 200, { backups: listBackups(config.backupDir) })
      if (p === '/api/backup-now' && req.method === 'POST') return send(res, 200, makeBackup('manual'))
      if (p === '/api/log') { try { return send(res, 200, readFileSync(logFile, 'utf8').split('\n').slice(-80).join('\n')) } catch { return send(res, 200, '') } }
      if (p === '/api/stop' && req.method === 'POST') { send(res, 200, { ok: true }); setTimeout(() => handle.stop(0), 50); return }
      return send(res, 404, { error: 'not-found' })
    } catch (e) {
      log(`ERROR admin ${url.pathname}: ${e.message}`)
      return send(res, e.status ?? 500, { error: e.message })
    }
  }

  const https = createHttps({ ...certs.context(), minVersion: 'TLSv1.2' }, (req, res) => void api(req, res))
  const http = createHttp(caPage)
  const adminServer = createHttp((req, res) => void admin(req, res))
  for (const s of [https, http, adminServer]) { s.requestTimeout = 30000; s.headersTimeout = 15000; s.keepAliveTimeout = 5000 }
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port) })
  })
  // FINANCY_BIND_HOST=127.0.0.1 keeps a test run off the LAN (no firewall prompt)
  const bindHost = opts.bindHost ?? process.env.FINANCY_BIND_HOST ?? '0.0.0.0'
  const ports = {
    sync: await listen(https, opts.port ?? config.port, bindHost),
    ca: await listen(http, opts.httpPort ?? config.httpPort, bindHost),
    admin: await listen(adminServer, opts.adminPort ?? config.adminPort, '127.0.0.1'),
  }

  // LAN IP changed (new router, DHCP) → new certificate, no restart needed
  const certTimer = setInterval(() => {
    try { if (certs.ensureLeaf(opts.hosts)) { https.setSecureContext({ ...certs.context(), minVersion: 'TLSv1.2' }); log(`address changed; certificate re-issued for ${hosts().join(', ')}`) } }
    catch (e) { log(`ERROR certificate update: ${e.message}`) }
  }, 60 * 1000)

  log(`Financy Sync ${VERSION} started: https://${hosts().join(`:${ports.sync}, https://`)}:${ports.sync}; admin http://127.0.0.1:${ports.admin}; backups ${config.backupDir}`)
  setImmediate(maybeBackup)

  const handle = {
    ports, home, config, certs, log,
    get db() { return db }, get devices() { return devices }, state, pairing,
    makeBackup, maybeBackup,
    stop(code) {
      if (stopping) return stopping
      clearInterval(backupTimer); clearInterval(certTimer)
      stopping = Promise.all([https, http, adminServer].map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.() })))
        .then(() => { log('stopped'); if (code !== undefined && !opts.noExit) process.exit(code) })
      return stopping
    },
  }
  return handle
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().then((h) => {
    const bye = () => void h.stop(0)
    process.on('SIGINT', bye); process.on('SIGTERM', bye)
  }).catch((e) => {
    console.error(e)
    // 3 = another copy is already running: the supervisor must not restart
    process.exit(e.code === 'EADDRINUSE' ? 3 : 1)
  })
}
