// Run invoice regressions in an isolated profile. No user database is opened.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join, extname, sep } from 'node:path'
import { build } from 'vite'

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((path) => path && existsSync(path))
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable')
mkdirSync('node_modules/.cache', { recursive: true })
const work = mkdtempSync(resolve('node_modules/.cache/invoice-regression-'))
const output = join(work, 'bundle')
await build({
  configFile: false, logLevel: 'error',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'), __APP_VERSION__: JSON.stringify('invoice-regression'),
  },
  build: { outDir: output, lib: { entry: resolve('scripts/invoice-regression.ts'), formats: ['es'], fileName: () => 'test.js' } },
})
const bundle = readFileSync(join(output, 'test.js'))
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]).slice(1)
  if (!name) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="root"></div>'); return }
  const root = name.startsWith('ocr/') ? resolve('public') : output
  const file = resolve(root, name)
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404).end(); return }
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip' }
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
  res.end(name === 'test.js' ? bundle : readFileSync(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const profile = join(work, 'profile')
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let socket
try {
  const activePort = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(activePort); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  const debugPort = readFileSync(activePort, 'utf8').split('\n')[0]
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.consoleAPICalled') console.log(...message.params.args.map((argument) => argument.value ?? argument.description))
    if (message.id) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(request.timer)
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
    }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => reject(new Error(`Browser command timed out: ${method}`)), 120000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Madrid' })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const result = await cdp('Runtime.evaluate', {
    expression: "import('/test.js').then(module => module.runInvoiceRegression())", awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  console.log(result.result.value)
  // restarts: a separate, empty origin; each navigation is a full app restart (memory cleared, IndexedDB kept)
  for (const phase of ['restartPhase1', 'restartPhase2', 'restartPhase3']) {
    await cdp('Page.navigate', { url: `http://localhost:${port}/` })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const r = await cdp('Runtime.evaluate', { expression: `import('/test.js').then(module => module.${phase}())`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    console.log(`PASS restart ${r.result.value}`)
  }
  if (process.env.INVOICE_PDF_OUT) {
    const pdf = await cdp('Runtime.evaluate', { expression: "import('/test.js').then(module => module.samplePdfBase64())", awaitPromise: true, returnByValue: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.INVOICE_PDF_OUT, Buffer.from(pdf.result.value, 'base64'))
    console.log(`INFO sample PDF written to ${process.env.INVOICE_PDF_OUT}`)
  }
  await cdp('Browser.close')
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
