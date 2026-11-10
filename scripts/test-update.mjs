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
let generation = 1
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
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(extname(path) === '.js' && path.endsWith('sw.js') ? Buffer.concat([readFileSync(path), Buffer.from('\n// synthetic update generation ' + generation)]) : readFileSync(path))
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
  let seq = 0, mainNavigations = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data), p = pending.get(m.id)
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) mainNavigations++
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
  // Exercise the NEW update controller as well as the published app's older one.
  await js(`new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=()=>{const d=q.result,t=d.transaction('planning','readwrite'),now=new Date().toISOString(),common={currency:'EUR',createdAt:now,updatedAt:now};for(const r of [{...common,id:'update-balance',kind:'balance',amount:100000,at:now},{...common,id:'update-plan',kind:'envelope',name:'Synthetic preserved plan',target:80000,priority:1,mode:'goal',frequency:'once',state:'active'},{...common,id:'update-reserve',kind:'movement',amount:10000,from:null,to:'update-plan',status:'pending'}])t.objectStore('planning').put(r);t.oncomplete=()=>{d.close();resolve(true)}}})`)
  const planningSnapshot = `new Promise(resolve=>{const q=indexedDB.open('finance');q.onsuccess=()=>{const d=q.result,r=d.transaction('planning').objectStore('planning').getAll();r.onsuccess=()=>{d.close();resolve(JSON.stringify(r.result))}}})`
  const planningBefore = await js(planningSnapshot)
  await cdp('Page.reload'); await until("!!document.querySelector('main')")
  generation++
  await js('navigator.serviceWorker.getRegistration().then(r=>r.update())')
  await until("document.body.innerText.includes('Доступна новая версия')")
  await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Планирование').click()`)
  await until("!!document.querySelector('button[aria-label=\"Открыть план Synthetic preserved plan\"]')")
  await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Открыть план Synthetic preserved plan').click(); const input=document.querySelector('input[aria-label="Сумма резерва Synthetic preserved plan"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'50');input.dispatchEvent(new Event('input',{bubbles:true}))`)
  await until("!!document.querySelector('[data-pending-input=\"true\"]')")
  await js(`window.__confirmCount=0;window.confirm=()=>{window.__confirmCount++;return false};[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Обновить').click()`)
  assert.equal(await js('window.__confirmCount'),1,'Inline unsaved input was not protected')
  assert(await js(`!!document.querySelector('[data-pending-input="true"]')`),'Cancelled update lost input')
  await js(`window.confirm=()=>true;const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Обновить');b.click();b.click()`)
  await until("!!document.querySelector('button[aria-label=\"Планирование\"]') && !document.querySelector('[data-pending-input=\"true\"]') && !document.body.innerText.includes('Доступна новая версия')")
  assert.equal(await js(planningSnapshot),planningBefore,'Planning records changed during update')
  assert.equal(await js(snapshot),before,'Financial stores changed during second update')
  const settledNavigations = mainNavigations
  await new Promise(r=>setTimeout(r,1200))
  assert.equal(mainNavigations, settledNavigations, 'Update repeated a reload without user action')
  assert(await js('!!document.querySelector("main")'),'Update entered a reload loop')
  console.log('PASS new update controller: prompt, unsaved inline input warning/cancel, duplicate update click, preserved planning and financial data')
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await cdp('Page.reload'); await until("!!document.querySelector('button[aria-label=\"Планирование\"]')")
  assert.equal(await js(snapshot), before)
  console.log('PASS updated PWA restarts offline with preserved records and connection settings')
  await cdp('Browser.close')
} finally { ws?.close(); browser.kill(); server.close() }
