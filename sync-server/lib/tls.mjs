// Local HTTPS for the iPhone. A private root certificate ("Financy Sync CA") is created once and
// installed on the iPhone by the user. It is name-constrained to *.local, localhost and private
// IPv4 ranges, so even if its key leaked it could not impersonate a real website.
// The server certificate is re-issued automatically when the PC's LAN IP or name changes.
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'

const PRIVATE = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./]

export function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && PRIVATE.some((re) => re.test(i.address)))
    .map((i) => i.address)
}

export const localName = () => `${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}.local`

export function findOpenssl(configured) {
  const candidates = [configured, process.env.FINANCY_OPENSSL, 'openssl',
    'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe']
  for (const c of candidates.filter(Boolean)) {
    try { execFileSync(c, ['version'], { stdio: 'ignore', windowsHide: true }); return c } catch { /* next */ }
  }
  throw new Error('openssl not found (it ships with Git for Windows)')
}

export class Certs {
  constructor(dir, openssl) {
    this.dir = dir
    this.openssl = openssl
    mkdirSync(dir, { recursive: true })
  }
  p(f) { return join(this.dir, f) }
  ssl(...args) { execFileSync(this.openssl, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) }

  ensureCA() {
    if (existsSync(this.p('ca.crt')) && existsSync(this.p('ca.key'))) return false
    writeFileSync(this.p('ca.cnf'), `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Financy Sync CA
O = Financy (this computer only)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:local, permitted;DNS:localhost, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:127.0.0.0/255.0.0.0
`)
    this.ssl('req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', this.p('ca.key'), '-out', this.p('ca.crt'), '-config', this.p('ca.cnf'))
    rmSync(this.p('ca.cnf'), { force: true })
    return true
  }

  /** Hosts the current server certificate is valid for, or null if it must be (re)issued. */
  leafHosts() {
    if (!existsSync(this.p('server.crt')) || !existsSync(this.p('server.key'))) return null
    try {
      const cert = new X509Certificate(readFileSync(this.p('server.crt')))
      if (Date.parse(cert.validTo) - Date.now() < 30 * 864e5) return null
      if (!cert.checkIssued(new X509Certificate(readFileSync(this.p('ca.crt'))))) return null
      return (cert.subjectAltName ?? '').split(', ').map((s) => s.replace(/^(DNS|IP Address):/, ''))
    } catch { return null }
  }

  /** @returns true when a new certificate was written */
  ensureLeaf(hosts = [localName(), ...lanAddresses()]) {
    this.ensureCA()
    const want = ['localhost', '127.0.0.1', ...hosts]
    const have = this.leafHosts()
    if (have && want.every((h) => have.includes(h))) return false
    const dns = want.filter((h) => !/^\d+\.\d+\.\d+\.\d+$/.test(h))
    const ips = want.filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h))
    // Apple: SAN required, EKU serverAuth, SHA-256, RSA >= 2048, at most 398 days
    writeFileSync(this.p('server.cnf'), `[req]
distinguished_name = dn
prompt = no
[dn]
CN = Financy Sync
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${[...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)].join(', ')}
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
`)
    this.ssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', this.p('server.key.new'), '-out', this.p('server.csr'), '-config', this.p('server.cnf'))
    this.ssl('x509', '-req', '-in', this.p('server.csr'), '-CA', this.p('ca.crt'), '-CAkey', this.p('ca.key'), '-set_serial', `0x${createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 16)}`,
      '-days', '397', '-sha256', '-extfile', this.p('server.cnf'), '-extensions', 'v3', '-out', this.p('server.crt.new'))
    writeFileSync(this.p('server.key'), readFileSync(this.p('server.key.new')), { mode: 0o600 })
    writeFileSync(this.p('server.crt'), readFileSync(this.p('server.crt.new')))
    for (const f of ['server.key.new', 'server.crt.new', 'server.csr', 'server.cnf']) rmSync(this.p(f), { force: true })
    return true
  }

  context() { return { key: readFileSync(this.p('server.key')), cert: readFileSync(this.p('server.crt')) } }
  caPem() { return readFileSync(this.p('ca.crt')) }
  caFingerprint() { return new X509Certificate(this.caPem()).fingerprint256 }
}
