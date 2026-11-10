// Crash-safe JSON files: write to a temp file, fsync, keep the previous good copy, then rename.
// Every file is wrapped with a SHA-256 of its content so a torn or edited file is detected on load.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { canonical, sha256 } from './canonical.mjs'

export function writeFileDurable(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export function saveJson(path, payload) {
  const text = JSON.stringify({ sha256: sha256(canonical(payload)), payload })
  if (existsSync(path)) {
    // keep the last good version next to it (overwritten on each save, never deleted)
    try { writeFileDurable(`${path}.prev`, readFileSync(path, 'utf8')) } catch { /* best effort */ }
  }
  writeFileDurable(path, text)
}

function readVerified(path) {
  const wrapped = JSON.parse(readFileSync(path, 'utf8'))
  if (!wrapped || sha256(canonical(wrapped.payload)) !== wrapped.sha256) throw new Error(`integrity check failed: ${path}`)
  return wrapped.payload
}

/** Loads a file saved by saveJson; falls back to the previous good copy if the main one is damaged. */
export function loadJson(path, fallback, log = () => {}) {
  if (!existsSync(path) && !existsSync(`${path}.prev`)) return fallback()
  try {
    return readVerified(path)
  } catch (e) {
    log(`WARN ${e.message}; trying previous copy`)
    if (existsSync(`${path}.prev`)) return readVerified(`${path}.prev`)
    throw e
  }
}

export function removeIfExists(path) {
  try { rmSync(path, { force: true }) } catch { /* ignore */ }
}
