// Keeps the sync server running: restarts it after a crash with a growing pause.
// Exit code 0 (stopped from the admin page) or 3 (already running) ends the supervisor.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const server = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')
let delay = 2000
let child = null

function run() {
  const started = Date.now()
  child = spawn(process.execPath, [server], { stdio: 'ignore', windowsHide: true })
  child.on('exit', (code) => {
    child = null
    if (code === 0 || code === 3) process.exit(0)
    if (Date.now() - started > 60000) delay = 2000
    setTimeout(run, delay)
    delay = Math.min(delay * 2, 5 * 60 * 1000)
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child?.kill(sig); process.exit(0) })
run()
