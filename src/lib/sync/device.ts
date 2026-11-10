// This device's identity for the PC sync server.
// The private key is a NON-EXTRACTABLE WebCrypto key kept in IndexedDB: it can sign requests but
// its bytes can never be read, exported, logged or included in a backup.
import * as DB from '../db'
import { sha256 } from './canonical'

export const SYNC_PORT = 47821
export const CA_PORT = 47820

export interface PairedDevice {
  deviceId: string
  serverId: string
  serverName: string
  hosts: string[]
  lastHost: string | null
  privateKey: CryptoKey
  pairedAt: string
}

export const getDevice = () => DB.getMeta<PairedDevice>('syncDevice')
export const saveDevice = (d: PairedDevice) => DB.setMeta('syncDevice', d)

/** «https://192.168.1.5:47821/», « Desktop.local » → «192.168.1.5», «desktop.local» */
export function cleanHost(input: string) {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\s+/g, '')
}
export const validHost = (h: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(h) || h === 'localhost'
export const baseUrl = (host: string) => `https://${host}:${SYNC_PORT}`

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export async function request(url: string, init: RequestInit & { timeout?: number } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeout ?? 10000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'omit', mode: 'cors' })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new HttpError(res.status, body?.error ?? String(res.status))
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function signed<T = unknown>(device: PairedDevice, host: string, method: 'GET' | 'POST', path: string, body?: unknown, timeout?: number): Promise<T> {
  const text = body === undefined ? '' : JSON.stringify(body)
  const time = String(Date.now())
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)))
  const sts = ['FINANCY1', method, path, time, nonce, await sha256(text)].join('\n')
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(sts))
  return request(baseUrl(host) + path, {
    method, timeout, body: method === 'POST' ? text : undefined,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      'X-Financy-Device': device.deviceId, 'X-Financy-Time': time, 'X-Financy-Nonce': nonce, 'X-Financy-Signature': b64(sig),
    },
  })
}

export function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  return /Windows/.test(ua) ? 'Браузер Windows' : /Mac/.test(ua) ? 'Браузер Mac' : 'Браузер'
}

export interface PingInfo { app: string; serverId: string; name: string; hosts: string[] }
export const ping = (host: string, timeout = 4000) => request(`${baseUrl(host)}/ping`, { timeout }) as Promise<PingInfo>

/** Pairs this device with the code shown on the PC. Nothing secret is sent: only the public key. */
export async function pairWith(host: string, code: string): Promise<PairedDevice> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const r = await request(`${baseUrl(host)}/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.replace(/\D/g, ''), deviceName: deviceName(), publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }),
  })
  const device: PairedDevice = {
    deviceId: r.deviceId, serverId: r.serverId, serverName: r.name, hosts: [...new Set([host, ...(r.hosts ?? [])])], lastHost: host,
    privateKey: keys.privateKey, pairedAt: new Date().toISOString(),
  }
  await saveDevice(device) // structured clone keeps the key non-extractable
  return device
}
