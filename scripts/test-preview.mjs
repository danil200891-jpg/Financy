// Exercise the real production preview with BASE_PATH deliberately absent.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const html = readFileSync('dist/index.html', 'utf8')
const modulePath = html.match(/<script\b[^>]*\bsrc="([^"]*\/assets\/[^"?]+\.js)"/)?.[1]
assert(modulePath, 'Build the application before testing preview')
const base = modulePath.slice(0, modulePath.lastIndexOf('/assets/') + 1)
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
assert(chrome, 'Set CHROME_PATH to Chrome or Chromium')
mkdirSync('node_modules/.cache', { recursive: true })
const work = mkdtempSync(resolve('node_modules/.cache/preview-regression-'))
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const env = { ...process.env }
delete env.BASE_PATH
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, windowsHide: true, stdio: 'ignore' })
const origin = `http://127.0.0.1:${port}`
let browser, socket
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin + base)).ok) break } catch { /* Preview is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  for (const path of [modulePath, `${base}sw.js`, `${base}manifest.webmanifest`, ...[...html.matchAll(/(?:href|src)="([^"]+\.(?:css|png))"/g)].map((match) => match[1])]) {
    const response = await fetch(new URL(path, origin + base))
    assert.equal(response.status, 200, path)
    assert(!response.headers.get('content-type')?.includes('text/html'), `HTML returned for ${path}`)
  }
  const manifest = await (await fetch(origin + base + 'manifest.webmanifest')).json()
  for (const icon of manifest.icons) assert.equal((await fetch(new URL(icon.src, origin + base))).status, 200)
  console.log(`PASS preview auto-detects ${base}; JavaScript, CSS, SW, manifest and icons load without BASE_PATH`)
  const profile = join(work, 'profile')
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const activePort = join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100 && !existsSync(activePort); attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
  const debugPort = readFileSync(activePort, 'utf8').split('\n')[0]
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map(), errors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 30000) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const js = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert(!result.exceptionDetails, result.exceptionDetails?.text)
    return result.result.value
  }
  const until = async (expression) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error(`Timed out: ${expression}`)
  }
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable')
  await cdp('Network.setBlockedURLs', { urls: ['https://*'] })
  await cdp('Page.navigate', { url: origin + base })
  await until("!!document.querySelector('main')")
  await js('navigator.serviceWorker.ready.then(() => true)')
  await cdp('Page.reload')
  await until("!!document.querySelector('main') && !!navigator.serviceWorker.controller")
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await cdp('Page.reload')
  await until("!!document.querySelector('main') && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Доход')")
  assert.equal(await js("document.querySelectorAll('nav button').length"), 5)
  assert.deepEqual(errors, [])
  console.log('PASS production browser startup, SW control and offline reload; no uncaught JavaScript errors')
  await cdp('Browser.close')
} finally {
  socket?.close()
  browser?.kill()
  server.kill()
}
