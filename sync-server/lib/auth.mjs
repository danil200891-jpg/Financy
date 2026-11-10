// Device authorisation.
// Pairing: the PC shows a one-time 6-digit code (10 minutes, 5 attempts). The phone sends the code
// with the PUBLIC half of a P-256 key it generated; the private half never leaves the phone
// (non-extractable WebCrypto key). The server stores only public keys — no tokens or passwords.
// Every sync request is signed: ECDSA-SHA256 over method, path, time, nonce and body hash.
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from 'node:crypto'

export const SIG_VERSION = 'FINANCY1'
const SKEW_MS = 5 * 60 * 1000
const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

export function stringToSign(method, path, time, nonce, bodyHash) {
  return [SIG_VERSION, method.toUpperCase(), path, time, nonce, bodyHash].join('\n')
}
export const bodyHash = (body) => createHash('sha256').update(body ?? '').digest('hex')

export class Pairing {
  code = null
  expiresAt = 0
  attempts = 0
  start(now = Date.now()) {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.expiresAt = now + CODE_TTL_MS
    this.attempts = 0
    return { code: this.code, expiresAt: new Date(this.expiresAt).toISOString() }
  }
  cancel() { this.code = null }
  active(now = Date.now()) { return !!this.code && now < this.expiresAt }
  /** @returns 'ok' | 'expired' | 'wrong' | 'locked' */
  check(code, now = Date.now()) {
    if (!this.active(now)) return 'expired'
    const a = Buffer.from(String(code ?? '').replace(/\D/g, '').padEnd(6, 'x').slice(0, 6))
    const b = Buffer.from(this.code)
    if (timingSafeEqual(a, b)) { this.code = null; return 'ok' }
    if (++this.attempts >= MAX_ATTEMPTS) { this.code = null; return 'locked' }
    return 'wrong'
  }
}

export function validPublicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.d) return false
  try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }); return true } catch { return false }
}

export const newDeviceId = () => `dev-${randomBytes(9).toString('base64url')}`

export class Verifier {
  seen = new Map() // nonce → expiry
  keys = new Map() // deviceId → KeyObject
  /**
   * @returns {{ ok: true, device } | { ok: false, reason }}
   */
  check(devices, req, path, body, now = Date.now()) {
    const id = req.headers['x-financy-device']
    const time = Number(req.headers['x-financy-time'])
    const nonce = String(req.headers['x-financy-nonce'] ?? '')
    const sig = String(req.headers['x-financy-signature'] ?? '')
    const device = devices.find((d) => d.id === id && !d.revoked)
    if (!device) return { ok: false, reason: 'unknown-device' }
    if (!Number.isFinite(time) || Math.abs(now - time) > SKEW_MS) return { ok: false, reason: 'clock' }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || this.seen.has(`${id}:${nonce}`)) return { ok: false, reason: 'replay' }
    let key = this.keys.get(id)
    if (!key) {
      const { x, y } = device.publicKey
      key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' })
      this.keys.set(id, key)
    }
    const data = Buffer.from(stringToSign(req.method, path, String(time), nonce, bodyHash(body)))
    let good = false
    try { good = verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64')) } catch { good = false }
    if (!good) return { ok: false, reason: 'signature' }
    this.seen.set(`${id}:${nonce}`, now + 2 * SKEW_MS)
    if (this.seen.size > 5000) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k)
    return { ok: true, device }
  }
  forget(id) { this.keys.delete(id) }
}
