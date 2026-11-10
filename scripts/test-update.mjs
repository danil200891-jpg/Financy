// Upgrade the published public app to this local build in an isolated browser origin.
// Only public app assets are downloaded. No financial data leaves the test computer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join, extname, sep } from 'node:path'
const baseline = process.env.FINANCY_BASELINE_URL || 'https://danil200891-jpg.github.io'
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p))
assert(chrome, 'Set CHROME_PATH')
mkdirSync('node_modules/.cache', { recursive: true })
const work = mkdtempSync(resolve('node_modules/.cache/update-regression-'))
let local = false
const cache = new Map()
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/Financy/')) { res.writeHead(404).end(); return }
    res.setHeader('Cache-Control', 'no-cache')
    if (!local) {
      const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname
      if (!cache.has(path)) {
        const response = await fetch(baseline + path)
        assert(response.ok, `Baseline asset ${path}: ${response.status}`)
        cache.set(path, { body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') })
      }
      const item = cache.get(path); res.setHeader('Content-Type', item.type); res.end(item.body); return
    }
    const path = resolve('dist', url.pathname.slice('/Financy/'.length) || 'index.html')
    if (!path.startsWith(resolve('dist') + sep) || !existsSync(path)) { res.writeHead(404).end(); return }
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path))
  } catch { res.writeHead(502).end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const profile = join(work, 'profile')
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let ws
try {
  const active = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(active); i++) await new Promise((r) => setTimeout(r, 100))
  const targets = await (await fetch(`http://127.0.0.1:${readFileSync(active, 'utf8').split('\n')[0]}/json`)).json()
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data), p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(method)) }, 60000) }); ws.send(JSON.stringify({ id, method, params })) })
  const js = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value }
  const until = async (expression) => { for (let i = 0; i < 300; i++) { if (await js(expression)) return; await new Promise((r) => setTimeout(r, 100)) } throw new Error(`Timed out: ${expression}`) }
  await cdp('Page.enable'); await cdp('Network.enable')
  await cdp('Network.setBlockedURLs', { urls: ['https://*'] })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/Financy/` })
  await until("!!document.querySelector('main')")
  await js('navigator.serviceWorker.ready.then(()=>true)')
  await cdp('Page.reload'); await until("!!navigator.serviceWorker.controller && !!document.querySelector('main')")
  await js(`(async()=>{const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);await new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=()=>{const d=q.result,t=d.transaction(['operations','clients','meta'],'readwrite'),now=new Date().toISOString();t.objectStore('clients').put({id:'update-client',name:'Synthetic update client',aliases:[],color:'#7c8cff',createdAt:now,updatedAt:now});t.objectStore('operations').put({id:'update-operation',type:'income',title:'Synthetic update income',amount:12345,currency:'EUR',date:now,source:'manual',categoryId:'c-work',clientId:'update-client',createdAt:now,updatedAt:now,note:'Synthetic preserved note'});t.objectStore('meta').put({deviceId:'synthetic-device',serverId:'synthetic-server',serverName:'Synthetic isolated PC',hosts:[],lastHost:null,privateKey:keys.privateKey,pairedAt:now},'syncDevice');t.oncomplete=()=>{d.close();resolve(true)}}})})()`)
  const snapshot = `new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=async()=>{const d=q.result;const read=store=>new Promise(r=>{const request=d.transaction(store).objectStore(store).getAll();request.onsuccess=()=>r(request.result)});const result=await Promise.all(['operations','clients','categories','history','meta'].map(read));d.close();resolve(JSON.stringify(result))}})`
  const before = await js(snapshot)
  local = true
  await js('navigator.serviceWorker.getRegistration().then(r=>r.update())')
  await until("document.body.innerText.includes('Доступна новая версия')")
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Обновить').click()")
  await until("!!document.querySelector('button[aria-label=\"Планирование\"]')")
  assert.equal(await js(snapshot), before, 'Existing stores changed during PWA/schema upgrade')
  assert(await js(`new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=()=>{const d=q.result,r=d.transaction('meta').objectStore('meta').get('syncDevice');r.onsuccess=async()=>{const key=r.result.privateKey;const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode('synthetic-update-proof'));d.close();resolve(!key.extractable && signature.byteLength>0)}}})`), 'Pairing key lost after update')
  console.log('PASS published-app → local-planning PWA update: operations, clients, categories, history, settings and non-extractable pairing key preserved')
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await cdp('Page.reload'); await until("!!document.querySelector('button[aria-label=\"Планирование\"]')")
  assert.equal(await js(snapshot), before)
  console.log('PASS updated PWA restarts offline with preserved records and connection settings')
  await cdp('Browser.close')
} finally { ws?.close(); browser.kill(); server.close() }
