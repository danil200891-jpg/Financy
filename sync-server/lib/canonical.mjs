// Canonical JSON: object keys sorted, `undefined` dropped. The app (src/lib/sync/canonical.ts)
// implements the same rules, so both sides compute identical SHA-256 hashes for a record.
import { createHash } from 'node:crypto'

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
export const hashRecord = (record) => sha256(canonical(record))
