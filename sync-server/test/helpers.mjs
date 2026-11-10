// Test client that speaks the same protocol as the app (src/lib/sync/*).
import { request } from 'node:https'
import { webcrypto, createHash, randomBytes } from 'node:crypto'
import { hashRecord } from '../lib/canonical.mjs'

const { subtle } = webcrypto

export function httpsJson(port, ca, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const req = request({ host: '127.0.0.1', servername: 'localhost', port, method, path, ca, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, json, text }) })
    })
    req.on('error', reject)
    req.end(data)
  })
}

export async function makeDevice(getPort, ca, origin = 'https://example.github.io') {
  const port = () => (typeof getPort === 'function' ? getPort() : getPort)
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const jwk = await subtle.exportKey('jwk', keys.publicKey)
  const device = {
    keys, jwk, id: null, origin,
    async pair(code) {
      const r = await httpsJson(port(), ca, 'POST', '/pair', { code, deviceName: 'Test iPhone', publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }, { Origin: origin })
      if (r.status === 200) device.id = r.json.deviceId
      return r
    },
    async signed(method, path, body, { time = Date.now(), nonce = randomBytes(18).toString('base64url'), tamper = false } = {}) {
      const text = body === undefined ? '' : JSON.stringify(body)
      const bodyHash = createHash('sha256').update(text).digest('hex')
      const sts = ['FINANCY1', method, path, String(time), nonce, bodyHash].join('\n')
      const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(sts))).toString('base64')
      return httpsJson(port(), ca, method, path, tamper ? text.replace('1', '2') : text, {
        Origin: origin, 'X-Financy-Device': device.id, 'X-Financy-Time': String(time), 'X-Financy-Nonce': nonce, 'X-Financy-Signature': sig,
      })
    },
  }
  return device
}

export const change = (data, baseRev = 0, entity = 'operation') => ({ entity, id: data.id, baseRev, hash: hashRecord(data), data })
export const op = (id, over = {}) => ({ id, type: 'income', amount: 1000, currency: 'EUR', title: 'Test', categoryId: null, clientId: null, date: '2026-11-01T10:00:00.000Z', source: 'manual', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', deletedAt: null, ...over })
