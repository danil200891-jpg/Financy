// Used by install.ps1: sets backupDir/openssl in config.json, keeping serverId and everything else.
// Usage: node write-config.mjs <config.json> <backupDir> <openssl>
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadJson, saveJson } from './lib/files.mjs'

const [path, backupDir, openssl] = process.argv.slice(2)
if (!path || !backupDir || !openssl) { console.error('usage: write-config.mjs <config.json> <backupDir> <openssl>'); process.exit(2) }
mkdirSync(dirname(path), { recursive: true })
const cfg = loadJson(path, () => ({}))
saveJson(path, { ...cfg, backupDir, openssl })
