// Inspect staged bytes, including renamed files and names containing whitespace.
import { execFileSync } from 'node:child_process'

export function sensitiveContent(text) {
  return /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(text)
    || /"app"\s*:\s*"finance-pwa"/.test(text)
    || /^\uFEFF?Дата;Время;Тип;Сумма/m.test(text)
    || /(?:gh[pousr]_|github_pat_|sk_live_|AKIA)[A-Za-z0-9_]{12,}/.test(text)
}

const names = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
let blocked = false
for (const name of names) {
  const content = execFileSync('git', ['show', `:${name}`], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8')
  const privatePath = /(?:^|\/)(?:\.cert|backups)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem|crt|p12|pfx|csr|srl|csv)$/i.test(name)
  if ((privatePath && !name.endsWith('.env.example')) || sensitiveContent(content)) {
    console.error(`pre-commit: blocked ${JSON.stringify(name)} — sensitive path or content`)
    blocked = true
  }
}
if (blocked) {
  console.error('Remove sensitive files from the index before committing.')
  process.exitCode = 1
}
