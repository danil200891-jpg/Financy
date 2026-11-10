// Run browser tests with mocked OAuth/Drive in an isolated temporary profile.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((path) => path && existsSync(path))
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable')
mkdirSync('node_modules/.cache', { recursive: true })
const work = mkdtempSync(resolve('node_modules/.cache/drive-regression-'))
const output = join(work, 'bundle')
await build({
  configFile: false, logLevel: 'error',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'), __APP_VERSION__: JSON.stringify('drive-regression'),
    'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify('synthetic.apps.googleusercontent.com'),
  },
  build: { outDir: output, lib: { entry: resolve('scripts/drive-backup-regression.ts'), formats: ['es'], fileName: () => 'test.js' } },
})
const bundle = readFileSync(join(output, 'test.js'))
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/test.js' ? bundle : '<!doctype html><title>Isolated synthetic Drive regression</title>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const profile = join(work, 'profile')
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
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
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const result = await cdp('Runtime.evaluate', {
    expression: "import('/test.js').then(module => module.runDriveRegression())", awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  console.log(result.result.value)
  await cdp('Browser.close')
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
