import type { Worker } from 'tesseract.js'

/**
 * On-device OCR with Tesseract.js. Worker, WASM core and language data are served
 * from /ocr (copied by scripts/copy-ocr.mjs) and precached by the service worker,
 * so recognition works offline and no image ever leaves the phone.
 */
const BASE = import.meta.env.BASE_URL + 'ocr'

let worker: Promise<Worker> | null = null
let idle: ReturnType<typeof setTimeout> | undefined
let onProgress: ((p: number) => void) | null = null
let generation = 0
let active: AbortController | undefined

function resetWorker() {
  const previous = worker
  worker = null
  generation++
  void previous?.then((instance) => instance.terminate()).catch(() => {})
}

function getWorker() {
  if (!worker) {
    const createdGeneration = generation
    worker = import('tesseract.js').then(({ createWorker, OEM }) =>
      createWorker(['spa', 'eng', 'rus'], OEM.LSTM_ONLY, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: `${BASE}/core`,
        langPath: `${BASE}/lang`,
        gzip: true,
        logger: (m) => {
          if (generation !== createdGeneration) return
          if (m.status === 'recognizing text') onProgress?.(0.25 + m.progress * 0.75)
          else if (typeof m.progress === 'number') onProgress?.(m.progress * 0.25)
        },
      }),
    )
  }
  return worker
}

/** Free memory after a while of inactivity — iOS kills tabs that hold big WASM heaps. */
function scheduleRelease() {
  clearTimeout(idle)
  idle = setTimeout(resetWorker, 90_000)
}

export function warmUp() {
  const currentGeneration = generation
  getWorker().catch(() => { if (generation === currentGeneration) resetWorker() })
  scheduleRelease()
}

/** Scale to a size Tesseract likes, convert to grayscale and stretch contrast. */
export async function preprocess(src: Blob | string): Promise<HTMLCanvasElement> {
  const img = new Image()
  img.decoding = 'async'
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  try {
    img.src = url
    await img.decode()
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url)
  }
  const longSide = Math.max(img.naturalWidth, img.naturalHeight)
  let scale = Math.min(1, 2200 / longSide)
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('Изображение не содержит пикселей')
  if (img.naturalWidth < 1000) scale = Math.min(2, 1400 / img.naturalWidth, 2200 / longSide)
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * scale)
  c.height = Math.round(img.naturalHeight * scale)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, c.width, c.height)

  const data = ctx.getImageData(0, 0, c.width, c.height)
  const px = data.data
  let lo = 255
  let hi = 0
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    px[i] = g
    if (g < lo) lo = g
    if (g > hi) hi = g
    sum += g
  }
  // dark-mode screenshots (light text on dark) → invert so text is dark on light
  const invert = sum / (px.length / 4) < 110
  const range = Math.max(1, hi - lo)
  for (let i = 0; i < px.length; i += 4) {
    let g = ((px[i] - lo) / range) * 255
    if (invert) g = 255 - g
    px[i] = px[i + 1] = px[i + 2] = g
  }
  ctx.putImageData(data, 0, 0)
  return c
}

export interface OcrResult {
  text: string
  confidence: number
}

export async function recognize(src: Blob | string, progress?: (p: number) => void, signal?: AbortSignal): Promise<OcrResult> {
  active?.abort()
  const controller = new AbortController()
  active = controller
  clearTimeout(idle)
  onProgress = progress ?? null
  let canvas: HTMLCanvasElement | undefined
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  let timeout: ReturnType<typeof setTimeout>
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => { resetWorker(); reject(new Error('Распознавание отменено или превысило время ожидания')) }
    controller.signal.addEventListener('abort', stop, { once: true })
    if (controller.signal.aborted) stop()
    timeout = setTimeout(cancel, 120000)
  })
  try {
    return await Promise.race([(async () => {
      canvas = await preprocess(src)
      if (controller.signal.aborted) { canvas.width = canvas.height = 0; throw new Error('Распознавание отменено') }
      const w = await getWorker()
      if (controller.signal.aborted) throw new Error('Распознавание отменено')
      const { data } = await w.recognize(canvas)
      return { text: data.text, confidence: data.confidence }
    })(), cancelled])
  } catch (e) {
    if (active === controller) resetWorker()
    throw e
  } finally {
    clearTimeout(timeout!)
    signal?.removeEventListener('abort', cancel)
    if (canvas) canvas.width = canvas.height = 0
    if (active === controller) {
      active = undefined
      onProgress = null
      scheduleRelease()
    }
  }
}
