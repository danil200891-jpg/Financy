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
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'standalone',{get:()=>true})" })
  await cdp('Page.reload'); await until("document.documentElement.classList.contains('standalone-app') && !!document.querySelector('main')")
  await js(`new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=()=>{const d=q.result,t=d.transaction(['operations','clients'],'readwrite'),now=new Date().toISOString();t.objectStore('clients').put({id:'standalone-client',name:'Synthetic standalone client',aliases:[],color:'#7c8cff',createdAt:now,updatedAt:now});for(let i=0;i<100;i++)t.objectStore('operations').put({id:'standalone-'+i,title:'Synthetic standalone operation',type:'expense',amount:100,currency:'EUR',date:now,categoryId:'c-food',clientId:null,source:'manual',createdAt:now,updatedAt:now});t.oncomplete=()=>{d.close();resolve(true)}}})`)
  await cdp('Page.reload'); await until("!!document.querySelector('main')")
  for (const [width,height] of [[320,667],[390,844]]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true})
    let expectedTop
    for (const tab of ['Главная','История','Клиенты','Планирование','Аналитика','Клиенты']) {
      await js(`[...document.querySelectorAll('nav button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(tab)}).click()`)
      await new Promise(r=>setTimeout(r,80))
      assert.equal(await js("document.querySelector('main').scrollTop"),0,'New tab retained old screen scroll')
      await js("document.querySelector('main').scrollTop=400;window.scrollTo(0,400)")
      const layout = await js("(()=>{const r=document.querySelector('.bottom-nav-surface').getBoundingClientRect();return {root:document.scrollingElement.scrollHeight,scroll:scrollY,screen:document.querySelector('main').clientHeight,top:r.top}})()")
      assert.equal(layout.root,height,`${tab}: root document changed height`)
      assert.equal(layout.scroll,0,`${tab}: root WebView scrolled`)
      assert.equal(layout.screen,height,`${tab}: screen no longer fills root`)
      expectedTop ??= layout.top
      assert.equal(layout.top,expectedTop,`${tab}: navigation moved`)
    }
  }
  await js("document.querySelector('main').scrollTop=0;document.querySelector('button[aria-label=\"Добавить клиента\"]').click()")
  await until("!!document.querySelector('[role=dialog]')")
  assert.equal(await js("document.querySelector('main').style.overflow"),'hidden','Standalone modal did not lock screen scroll')
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
  await until("!document.querySelector('[role=dialog]')")
  assert.equal(await js("document.querySelector('main').style.overflow"),'','Standalone screen lock was not released')
  assert.deepEqual(errors, [])
  console.log('PASS standalone root height/scroll remain invariant across five tabs, long/short content, mobile sizes and modal locking')
  await cdp('Browser.close')
} finally {
  socket?.close()
  browser?.kill()
  server.kill()
}
