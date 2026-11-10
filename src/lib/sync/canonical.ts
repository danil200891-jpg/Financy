// Same rules as sync-server/lib/canonical.mjs: sorted keys, `undefined` dropped.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
export async function sha256(text: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

// Records are immutable objects in the store, so a hash can be cached per object.
const cache = new WeakMap<object, Promise<string>>()
export function hashRecord(record: object) {
  let h = cache.get(record)
  if (!h) { h = sha256(canonical(record)); cache.set(record, h) }
  return h
}
