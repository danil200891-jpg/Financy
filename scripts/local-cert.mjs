// Creates a local, free HTTPS setup for testing on iPhone over Wi-Fi:
//   .cert/ca.crt      – root certificate to install on the iPhone (public part only)
//   .cert/ca.key      – root private key, NEVER share it, stays on this computer
//   .cert/server.crt  – certificate for this computer's LAN IP + localhost
//   .cert/server.key
// The root is name-constrained: it can only vouch for localhost and private 192.168.x.x / 10.x
// addresses, so even if its key leaked it could not impersonate real websites.
// Requires `openssl` (ships with Git for Windows).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

const dir = '.cert'
mkdirSync(dir, { recursive: true })
const p = (f) => join(dir, f)
const ssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'inherit'] })

const ips = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
  .map((i) => i.address)
if (!ips.length) throw new Error('No LAN IPv4 address found — connect to Wi-Fi first')

if (!existsSync(p('ca.crt')) || process.argv.includes('--new-ca')) {
  writeFileSync(p('ca.cnf'), `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Finance Local Dev CA
O = Finance (local testing)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:localhost, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:127.0.0.0/255.0.0.0
`)
  ssl('req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825', '-keyout', p('ca.key'), '-out', p('ca.crt'), '-config', p('ca.cnf'))
  console.log('Created root CA:', p('ca.crt'))
}

// Apple requirements for TLS server certs: SAN with the host, EKU serverAuth, SHA-256, RSA ≥ 2048, ≤ 825 days
writeFileSync(p('server.cnf'), `[req]
distinguished_name = dn
prompt = no
[dn]
CN = Finance local (${ips[0]})
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1, ${ips.map((ip) => `IP:${ip}`).join(', ')}
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
`)
ssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', p('server.key'), '-out', p('server.csr'), '-config', p('server.cnf'))
ssl('x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-days', '397', '-sha256', '-extfile', p('server.cnf'), '-extensions', 'v3', '-out', p('server.crt'))
console.log('Server certificate for', ['localhost', ...ips].join(', '))
