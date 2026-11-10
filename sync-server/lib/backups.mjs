// Full backups of the synced data in the backup folder (default D:\Financy-Backups).
// Format = the app's own JSON backup (app "finance-pwa", version 1), so a file can also be
// imported by hand in Настройки → «Восстановить из копии». Extra fields: createdBy, kind, counts,
// sync metadata and an integrity hash.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonical, sha256 } from './canonical.mjs'
import { snapshot } from './engine.mjs'
import { writeFileDurable } from './files.mjs'

export const CREATED_BY = 'financy-sync-server'
export const WEEK_MS = 7 * 864e5
export const RETENTION_MS = 30 * 864e5
const NAME_RE = /^financy-backup-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(weekly|manual|pre-restore)\.json$/
const KINDS = ['weekly', 'manual', 'pre-restore']

const pad = (n) => String(n).padStart(2, '0')
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

export function buildBackup(db, kind, now = new Date()) {
  const data = snapshot(db)
  const body = {
    app: 'finance-pwa', version: 1, createdBy: CREATED_BY, kind, exportedAt: now.toISOString(), serverId: db.serverId,
    counts: {
      operations: data.operations.filter((o) => !o.deletedAt).length,
      clients: data.clients.filter((c) => !c.deletedAt).length,
      categories: data.categories.filter((c) => !c.deletedAt).length,
      deleted: data.operations.filter((o) => o.deletedAt).length,
    },
    ...data,
    history: [],
    sync: { seq: db.seq, records: Object.fromEntries(Object.entries(db.records).map(([k, r]) => [k, { rev: r.rev, hash: r.hash }])) },
  }
  return { ...body, integrity: { algorithm: 'sha256', hash: sha256(canonical(body)) } }
}

export function verifyBackup(b) {
  if (!b || b.app !== 'finance-pwa' || b.createdBy !== CREATED_BY || !b.integrity) return false
  const { integrity, ...body } = b
  return integrity.algorithm === 'sha256' && sha256(canonical(body)) === integrity.hash
}

/** Writes, reads back and verifies a backup. Throws if anything does not match; the old copies stay. */
export function createBackup(dir, db, kind, now = new Date()) {
  if (!KINDS.includes(kind)) throw new Error('unknown backup kind')
  mkdirSync(dir, { recursive: true })
  const backup = buildBackup(db, kind, now)
  let name = `financy-backup-${stamp(now)}-${kind}.json`
  for (let i = 1; existsSync(join(dir, name)); i++) name = `financy-backup-${stamp(new Date(now.getTime() + i * 1000))}-${kind}.json`
  const path = join(dir, name)
  writeFileDurable(path, JSON.stringify(backup, null, 1))
  const back = JSON.parse(readFileSync(path, 'utf8'))
  if (!verifyBackup(back) || back.integrity.hash !== backup.integrity.hash) {
    rmSync(path, { force: true })
    throw new Error('backup verification failed')
  }
  return { file: name, createdAt: backup.exportedAt, kind, counts: backup.counts, hash: backup.integrity.hash }
}

/** Only files with our exact name pattern are considered — anything else in the folder is never touched. */
export function listBackups(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir)) {
    const m = NAME_RE.exec(file)
    if (!m) continue
    const path = join(dir, file)
    let info = { file, kind: m[2], createdAt: null, counts: null, valid: false, size: 0 }
    try {
      info.size = statSync(path).size
      const b = JSON.parse(readFileSync(path, 'utf8'))
      info = { ...info, createdAt: b.exportedAt, counts: b.counts, valid: verifyBackup(b) }
    } catch { /* listed as damaged */ }
    out.push(info)
  }
  return out.sort((a, b) => (b.createdAt ?? b.file).localeCompare(a.createdAt ?? a.file))
}

export function readBackup(dir, file) {
  if (!NAME_RE.test(file)) throw new Error('not a Financy backup')
  const b = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  if (!verifyBackup(b)) throw new Error('backup is damaged')
  return b
}

/**
 * Removes Financy backups older than 30 days. Called only right after a new backup was created
 * and verified. The newest valid backup and the one just made are always kept.
 */
export function pruneBackups(dir, keepFile, now = new Date()) {
  const list = listBackups(dir)
  const newestValid = list.find((b) => b.valid)?.file
  const removed = []
  for (const b of list) {
    if (b.file === keepFile || b.file === newestValid || !b.valid) continue // damaged files are left for a human to look at
    const t = Date.parse(b.createdAt)
    if (Number.isFinite(t) && now.getTime() - t > RETENTION_MS) {
      rmSync(join(dir, b.file), { force: true })
      removed.push(b.file)
    }
  }
  return removed
}

/**
 * Weekly schedule. A backup is due 7 days after the last one; it is made only once fresh data has
 * arrived from a device since this server started (so a PC that was off makes it after the phone syncs).
 */
export function backupDue(state, now = Date.now()) {
  const last = state.lastBackupAt ? Date.parse(state.lastBackupAt) : 0
  const synced = state.lastDeviceSyncAt ? Date.parse(state.lastDeviceSyncAt) : 0
  return now - last >= WEEK_MS && synced >= state.startedAt && synced > 0
}
