import type { Plugin } from 'vite'
import { existsSync, readFileSync } from 'node:fs'

/**
 * TEMPORARY diagnostics for testing on iPhone over Wi-Fi (`npm run iphone` only).
 * - logs every request: client IP, method, URL, status, device
 * - /__diag : plain HTML page (no React, no Service Worker) that checks the browser and
 *             the app files and sends its report back to this console
 * - POST /__log : receives reports from the phone and prints them here
 * Not included in production builds. Remove together with its line in vite.config.ts.
 */
export function lanDiagnostics(): Plugin {
  const short = (ua = '') => (/iPhone|iPad/.test(ua) ? 'iOS ' + (ua.match(/OS (\d+[_\d]*)/)?.[1] ?? '?').replace(/_/g, '.') : ua.slice(0, 40))
  return {
    name: 'lan-diagnostics',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
        const t = Date.now()
        res.on('finish', () => {
          if (req.url === '/__log') return
          console.log(`[req] ${ip.padEnd(15)} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t}ms  ${short(req.headers['user-agent'])}`)
        })

        if (req.url === '/__log' && req.method === 'POST') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            console.log(`\n[phone ${ip}] ${body}\n`)
            res.statusCode = 204
            res.end()
          })
          return
        }
        // root certificate (public part only) for installing on the iPhone
        if (req.url?.startsWith('/__ca')) {
          if (!existsSync('.cert/ca.crt')) {
            res.statusCode = 404
            res.end('Run `npm run cert` first')
            return
          }
          res.setHeader('Content-Type', 'application/x-x509-ca-cert')
          res.setHeader('Content-Disposition', 'attachment; filename="Finance-Local-CA.crt"')
          res.end(readFileSync('.cert/ca.crt'))
          return
        }
        if (req.url?.startsWith('/__diag') || req.url?.startsWith('/_diag')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(DIAG_HTML)
          return
        }
        next()
      })
    },
  }
}

const DIAG_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Finance — диагностика</title>
<style>body{margin:0;background:#06070D;color:#F2F3F8;font:15px/1.45 -apple-system,system-ui,sans-serif;padding:calc(env(safe-area-inset-top) + 20px) 18px 40px}
h1{font-size:22px;margin:0 0 6px}p{color:#8B90A6;margin:0 0 16px}.r{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.k{flex:1}.v{text-align:right;max-width:62%;word-break:break-all}.ok{color:#3fe0c5}.bad{color:#ff6b81}.warn{color:#ffc56b}
button{width:100%;height:50px;border:0;border-radius:14px;margin-top:18px;background:linear-gradient(120deg,#7c8cff,#9f6bff);color:#fff;font-size:17px;font-weight:600}</style>
</head><body><h1>Диагностика Finance</h1><p>Если вы видите эту страницу — iPhone достучался до компьютера.</p><div id="out"></div>
<a href="/"><button>Открыть приложение</button></a>
<script>
var rows=[],out=document.getElementById('out');
function row(k,v,cls){rows.push(k+': '+v);var d=document.createElement('div');d.className='r';d.innerHTML='<span class="k"></span><span class="v '+(cls||'')+'"></span>';d.firstChild.textContent=k;d.lastChild.textContent=v;out.appendChild(d)}
function send(){try{var x=new XMLHttpRequest();x.open('POST','/__log');x.send(rows.join('\\n'))}catch(e){}}
window.onerror=function(m,f,l){row('Ошибка JS',m+' ('+l+')','bad');send()};
row('JavaScript','работает','ok');
row('Устройство',navigator.userAgent);
row('Защищённый контекст (HTTPS)',String(window.isSecureContext),window.isSecureContext?'ok':'bad');
var lb=true;try{new RegExp('(?<!a)b')}catch(e){lb=false}row('Regex lookbehind',lb?'да':'нет (iOS < 16.4)',lb?'ok':'warn');
row('ES-модули','noModule' in document.createElement('script')?'да':'нет','noModule' in document.createElement('script')?'ok':'bad');
row('Service Worker',('serviceWorker' in navigator)?'есть':'нет');
row('Камера (getUserMedia)',(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)?'доступна':'недоступна',(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)?'ok':'warn');
var pending=0;function done(){if(--pending===0)send()}
function idb(){pending++;var t=setTimeout(function(){row('IndexedDB','нет ответа 5 с','bad');done()},5000);
 try{var rq=indexedDB.open('finance-diag',1);rq.onsuccess=function(){clearTimeout(t);rq.result.close();row('IndexedDB','работает','ok');done()};
 rq.onerror=function(){clearTimeout(t);row('IndexedDB','ошибка: '+(rq.error&&rq.error.message),'bad');done()}}catch(e){clearTimeout(t);row('IndexedDB','исключение: '+e.message,'bad');done()}}
function check(label,url){pending++;var x=new XMLHttpRequest();x.open('GET',url+(url.indexOf('?')<0?'?':'&')+'diag='+Date.now());
 x.onload=function(){row(label,x.status+', '+(x.getResponseHeader('content-type')||'?')+', '+x.responseText.length+' байт',x.status===200?'ok':'bad');
  if(label==='index.html'){var js=(x.responseText.match(/src="([^"]+\\.js)"/)||[])[1],css=(x.responseText.match(/href="([^"]+\\.css)"/)||[])[1];if(js)check('JS приложения',js);if(css)check('CSS приложения',css)}done()};
 x.onerror=function(){row(label,'не загрузился','bad');done()};x.send()}
idb();check('index.html','/index.html');check('Движок OCR','/ocr/worker.min.js');
</script></body></html>`
