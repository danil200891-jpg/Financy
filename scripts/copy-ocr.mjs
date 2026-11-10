// Copies Tesseract.js worker, WASM core and language data into public/ocr
// so OCR runs fully on-device and offline (precached by the service worker).
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const out = 'public/ocr'
const nm = 'node_modules'
mkdirSync(join(out, 'core'), { recursive: true })
mkdirSync(join(out, 'lang'), { recursive: true })

cpSync(join(nm, 'tesseract.js/dist/worker.min.js'), join(out, 'worker.min.js'))
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'])
  cpSync(join(nm, 'tesseract.js-core', f), join(out, 'core', f))
for (const l of ['eng', 'spa', 'rus']) {
  const src = join(nm, `@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`)
  if (!existsSync(src)) throw new Error('missing ' + src)
  cpSync(src, join(out, 'lang', `${l}.traineddata.gz`))
}
console.log('OCR assets copied to', out)
