import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ImageUp, RefreshCw, Sparkles, X, Zap } from 'lucide-react'
import { actions, findDuplicate, getState, waitForWrites, type OperationDraft } from '../lib/store'
import { recognize as recognizeImage, warmUp } from '../lib/ocr'
import { guessKind, parseRecognized } from '../lib/receipt'
import { normalize, parseText } from '../lib/parse'
import { fmt } from '../lib/format'
import { Keyboard, PrimaryButton, ScanLine, Segmented, Sheet, lockBodyScroll } from '../components/ui'
import { OperationForm, centsToText, emptyForm, toDraft, type FormValue } from '../components/OperationForm'

export type AddMode = 'text' | 'camera' | 'upload'
type Flags = Partial<Record<'type' | 'amount' | 'title' | 'date', string>>

const EXAMPLES = ['MVP +350 €', 'Mercadona -42 €', 'Amazon 29,90 расход', 'Съёмка мероприятия 500 доход']

/** Fills category from the latest operation with the same title — learning from history. */
function guessCategory(title: string, type: FormValue['type'], clientId: string | null) {
  const { operations, categories } = getState()
  const t = normalize(title)
  const prev = operations.find((o) => o.type === type && (normalize(o.title) === t || (clientId && o.clientId === clientId)))
  if (prev?.categoryId && categories.some((c) => c.id === prev.categoryId)) return prev.categoryId
  // no history yet: only well-known merchants get a category, otherwise the user picks
  const hint = CATEGORY_HINTS.find(([re, , ty]) => ty === type && re.test(t))?.[1]
  return hint && categories.some((c) => c.id === hint) ? hint : null
}

const CATEGORY_HINTS: [RegExp, string, FormValue['type']][] = [
  [/mercadona|lidl|carrefour|aldi|alcampo|eroski|consum|hipercor|ahorramas|bonarea|^dia$|пятерочка|перекресток|магнит/, 'c-food', 'expense'],
  [/starbucks|mcdonald|burger king|kfc|telepizza|glovo|cafe|bar |restaurant|кафе|ресторан/, 'c-cafe', 'expense'],
  [/amazon|aliexpress|zara|primark|decathlon|ikea|leroy|media ?markt|ozon|wildberries/, 'c-shop', 'expense'],
  [/repsol|cepsa|galp|shell|uber|cabify|bolt|renfe|taxi|bp$/, 'c-transport', 'expense'],
  [/spotify|netflix|icloud|apple|youtube|hbo|disney|vodafone|movistar|orange|digi/, 'c-subs', 'expense'],
  [/farmacia|pharmacy|аптека/, 'c-health', 'expense'],
  [/съемк|фотосесси|shooting|photo/, 'c-photo', 'income'],
]

/* ---------------- camera ---------------- */

function CameraView({ onCapture, onClose }: { onCapture: (dataUrl: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [torch, setTorch] = useState(false)
  const stream = useRef<MediaStream | null>(null)

  useEffect(() => {
    const unlock = lockBodyScroll()
    let cancelled = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Камера доступна только по HTTPS или в установленном приложении.')
      return unlock
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream.current = s
        if (video.current) {
          video.current.srcObject = s
          video.current.play().catch(() => {})
        }
      })
      .catch(() => setError('Нет доступа к камере. Разрешите его в настройках Safari для этого сайта.'))
    return () => {
      unlock()
      cancelled = true
      stream.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0]
    try {
      await track?.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] })
      setTorch(!torch)
    } catch {
      /* torch isn't supported on every device */
    }
  }

  // Frame is drawn to an in-memory canvas only — nothing is written to the photo library.
  const shoot = () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    try {
      c.getContext('2d')!.drawImage(v, 0, 0)
      onCapture(c.toDataURL('image/jpeg', 0.85))
    } catch { setError('Не удалось получить кадр. Закройте камеру и попробуйте снова.') }
    finally { c.width = c.height = 0 }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Камера" className="anim-fade fixed inset-0 z-[60] bg-black">
      <video ref={video} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" />
      {/* receipt frame */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-[58%] w-[78%] rounded-[28px] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
          {['top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-[28px]', 'top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-[28px]', 'bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-[28px]', 'bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-[28px]'].map((p) => (
            <div key={p} className={`absolute h-10 w-10 border-white ${p}`} />
          ))}
        </div>
      </div>

      <div className="pt-safe absolute inset-x-0 top-0 flex items-center justify-between px-4">
        <button aria-label="Закрыть камеру" onClick={onClose} className="press grid h-11 w-11 place-items-center rounded-full bg-black/40 backdrop-blur-md">
          <X size={22} />
        </button>
        <p className="rounded-full bg-black/40 px-4 py-2 text-[14px] backdrop-blur-md">Наведите на чек</p>
        <button aria-label="Фонарик" onClick={toggleTorch} className={`press grid h-11 w-11 place-items-center rounded-full backdrop-blur-md ${torch ? 'bg-amber text-abyss' : 'bg-black/40'}`}>
          <Zap size={20} />
        </button>
      </div>

      {error && (
        <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-3xl bg-black/70 p-5 text-center backdrop-blur-xl">
          <p className="text-[16px] font-medium">{error}</p>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pb-[calc(env(safe-area-inset-bottom)+28px)]">
        <p className="mb-5 text-[13px] text-white/70">Фото не сохраняется в галерею</p>
        <button aria-label="Сделать снимок" onClick={shoot} disabled={!!error} className="press grid h-20 w-20 place-items-center rounded-full border-4 border-white/90 disabled:opacity-40">
          <span className="h-[62px] w-[62px] rounded-full bg-white" />
        </button>
      </div>
    </div>
  )
}

/* ---------------- recognition stage ---------------- */

function Scanning({ image, progress }: { image: string; progress: number }) {
  return (
    <div className="relative mx-auto h-56 w-full overflow-hidden rounded-3xl">
      <img src={image} alt="Снимок для распознавания" className="h-full w-full object-cover opacity-70" />
      <div className="absolute inset-x-0 h-24 bg-[linear-gradient(transparent,rgba(124,140,255,0.55),transparent)]" style={{ animation: 'scan 1.4s ease-in-out infinite alternate' }} />
      <style>{'@keyframes scan{from{top:-25%}to{top:85%}}'}</style>
      <div className="absolute inset-x-0 bottom-0 bg-black/55 backdrop-blur-md">
        <div className="flex items-center justify-center gap-2 py-3 text-[15px]">
          <Sparkles size={16} className="text-iris" />
          {progress < 0.25 ? 'Готовим распознавание…' : 'Распознаём текст на устройстве…'}
          <span className="num text-mist">{Math.round(progress * 100)}%</span>
        </div>
        <div className="h-0.5 bg-white/10">
          <div className="h-full bg-iris transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </div>
  )
}

/* ---------------- sheet ---------------- */

export function AddSheet({ mode, onMode, onClose }: { mode: AddMode | null; onMode: (m: AddMode) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [form, setForm] = useState<FormValue>(emptyForm)
  const [flags, setFlags] = useState<Flags>({})
  const [cameraOpen, setCameraOpen] = useState(false)
  const [image, setImage] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'scanning' | 'review'>('idle')
  const [saved, setSaved] = useState<OperationDraft | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const runId = useRef(0)
  const [progress, setProgress] = useState(0)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [rawText, setRawText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [dupOk, setDupOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const recognition = useRef<AbortController | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => { recognition.current?.abort(); clearTimeout(savedTimer.current) }, [])
  useEffect(() => () => { if (image?.startsWith('blob:')) URL.revokeObjectURL(image) }, [image])

  const reset = () => {
    runId.current++
    recognition.current?.abort()
    clearTimeout(savedTimer.current)
    saving.current = false
    setBusy(false); setSaved(null); setCameraOpen(false)
    setText(''); setForm(emptyForm()); setFlags({}); setImage(null); setStage('idle')
    setOcrError(null); setRawText(''); setShowRaw(false); setDupOk(false)
  }

  useEffect(() => {
    if (!mode) { reset(); return }
    reset()
    if (mode !== 'text') warmUp() // load OCR engine while the user aims the camera
    if (mode === 'camera') setCameraOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const onText = (t: string) => {
    setText(t)
    setDupOk(false)
    setFlags({})
    if (!t.trim()) return setForm(emptyForm())
    const p = parseText(t, getState().clients)
    const type = p.type ?? 'expense'
    setForm((f) => ({ ...f, type, amountText: centsToText(p.amount), title: p.title, clientId: p.clientId, categoryId: guessCategory(p.title, type, p.clientId) }))
    setFlags(p.typeGuessed ? { type: 'Тип не указан — проверьте доход или расход' } : {})
  }

  const recognize = async (img: string) => {
    recognition.current?.abort()
    const controller = new AbortController()
    recognition.current = controller
    const run = ++runId.current
    setImage(img)
    setProgress(0)
    setOcrError(null)
    setStage('scanning')
    try {
      const { text, confidence } = await recognizeImage(img, (p) => run === runId.current && setProgress(p), controller.signal)
      if (run !== runId.current) return
      const { clients, operations } = getState()
      const kind = mode === 'camera' ? 'receipt' : guessKind(text)
      const titles = [...new Set(operations.map((o) => o.title))]
      const r = parseRecognized(text, kind, clients, titles)
      const f: Flags = { ...r.flags }
      if (confidence < 55 && !f.amount) f.amount = 'Текст распознан неуверенно — сверьте сумму с изображением'
      setForm({
        ...emptyForm(),
        type: r.type,
        amountText: centsToText(r.amount),
        title: r.title,
        clientId: r.type === 'income' ? r.clientId : null,
        categoryId: r.title ? guessCategory(r.title, r.type, r.clientId) : null,
        date: r.date ?? emptyForm().date,
        currency: r.currency,
      })
      setFlags(f)
      setRawText(text.trim())
      setStage('review')
    } catch (e) {
      if (controller.signal.aborted) return
      if (run !== runId.current) return
      setOcrError('Не получилось распознать изображение. Заполните поля вручную или попробуйте другое фото.')
      setForm(emptyForm())
      setFlags({})
      setStage('review')
    }
  }

  const save = async () => {
    if (saving.current) return
    const d = toDraft(form, mode === 'camera' ? 'camera' : mode === 'upload' ? 'upload' : 'manual')
    if (!d) return
    if (findDuplicate(d) && !dupOk) return setDupOk(true)
    saving.current = true
    setBusy(true)
    try {
      actions.addOperation(d)
      await waitForWrites()
      setImage(null)
      setSaved(d)
      savedTimer.current = setTimeout(() => { setSaved(null); onClose() }, 900)
    } catch { saving.current = false }
    finally { setBusy(false) }
  }

  const draftOk = !!toDraft(form, 'manual')
  const showForm = mode === 'text' || stage === 'review'

  return (
    <>
      <Sheet open={!!mode && !cameraOpen} onClose={() => { if (!saving.current) onClose() }} full>
        <div className="px-5 pt-2">
          <Segmented
            value={mode ?? 'text'}
            onChange={(value) => {
              if (saving.current) return
              if (value === 'upload') fileRef.current?.click()
              onMode(value)
            }}
            options={[
              { value: 'text', label: 'Текстом' },
              { value: 'camera', label: 'Камера' },
              { value: 'upload', label: 'Из фото' },
            ]}
          />

          {mode === 'text' && (
            <div className="mt-5">
              <label className="glass flex items-center gap-3 rounded-[22px] px-4 py-1.5 focus-within:shadow-[0_0_0_2px_rgba(124,140,255,0.6)]">
                <Keyboard size={20} className="shrink-0 text-iris" />
                <input
                  autoFocus
                  disabled={busy}
                  value={text}
                  onChange={(e) => onText(e.target.value)}
                  placeholder="Mercadona -42 €"
                  enterKeyHint="done"
                  className="h-12 min-w-0 flex-1 bg-transparent outline-none placeholder:text-fog"
                />
                {text && <button aria-label="Очистить" onClick={() => onText('')}><X size={18} className="text-mist" /></button>}
              </label>
              {!text && (
                <div className="no-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5">
                  {EXAMPLES.map((e) => (
                    <button key={e} onClick={() => onText(e)} className="glass press shrink-0 rounded-full px-3.5 py-1.5 text-[14px] text-mist">{e}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {(mode === 'camera' || mode === 'upload') && stage === 'idle' && (
            <div className="mt-8 flex flex-col items-center text-center">
              <div className="grid h-20 w-20 place-items-center rounded-[28px] bg-iris/12 text-iris">
                {mode === 'camera' ? <ScanLine size={36} /> : <ImageUp size={36} />}
              </div>
              <p className="mt-4 text-[18px] font-semibold">{mode === 'camera' ? 'Сфотографируйте чек' : 'Выберите скриншот или фото'}</p>
              <p className="mt-1 max-w-[280px] text-[15px] text-mist">Распознавание идёт на устройстве. Снимок не сохраняется.</p>
              <PrimaryButton className="mt-6" onClick={() => (mode === 'camera' ? setCameraOpen(true) : fileRef.current?.click())}>
                {mode === 'camera' ? 'Открыть камеру' : 'Выбрать изображение'}
              </PrimaryButton>
            </div>
          )}

          {stage === 'scanning' && image && <div className="mt-5"><Scanning image={image} progress={progress} /></div>}

          {stage === 'review' && image && (
            <div className="mt-5 rounded-2xl bg-white/5 p-2.5">
              <div className="flex items-center gap-3">
                <img src={image} alt="Распознанное изображение" className="h-14 w-14 rounded-xl object-cover" />
                <div className="flex-1">
                  <p className="text-[15px] font-medium">{ocrError ? 'Не распознано' : 'Проверьте распознанное'}</p>
                  <p className={`text-[13px] ${ocrError || Object.keys(flags).length ? 'text-amber' : 'text-mist'}`}>
                    {ocrError ? 'Заполните поля вручную' : Object.keys(flags).length ? 'Есть поля, в которых мы не уверены' : 'Все поля найдены'}
                  </p>
                </div>
                <button aria-label={mode === 'camera' ? 'Переснять' : 'Выбрать другое'} onClick={() => (mode === 'camera' ? setCameraOpen(true) : fileRef.current?.click())} className="press grid h-10 w-10 place-items-center rounded-full bg-white/8">
                  <RefreshCw size={17} />
                </button>
              </div>
              {ocrError && <p className="mt-2.5 flex gap-2 px-1 text-[13px] text-amber"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {ocrError}</p>}
              {rawText && (
                <>
                  <button onClick={() => setShowRaw(!showRaw)} className="mt-2 flex items-center gap-1 px-1 text-[13px] text-mist">
                    Распознанный текст <ChevronDown size={14} className={showRaw ? 'rotate-180' : ''} />
                  </button>
                  {showRaw && <pre className="no-scrollbar mt-2 max-h-40 overflow-auto rounded-xl bg-black/30 p-3 font-sans text-[12px] whitespace-pre-wrap text-mist">{rawText}</pre>}
                </>
              )}
            </div>
          )}

          {showForm && (
            <div className="mt-6">
              <fieldset disabled={busy}>
                <OperationForm value={form} onChange={(v) => { setForm(v); setDupOk(false) }} flags={flags} />
              </fieldset>
              <PrimaryButton className="mt-6" disabled={!draftOk || busy || !!saved} onClick={save}>
                {dupOk ? 'Да, сохранить дубликат' : form.type === 'income' ? 'Сохранить доход' : 'Сохранить расход'}
              </PrimaryButton>
            </div>
          )}
        </div>
      </Sheet>

        <input
          ref={fileRef}
          id="receipt-image-input"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            void recognize(URL.createObjectURL(f))
          }}
        />

      {cameraOpen && (
        <CameraView
          onClose={() => { setCameraOpen(false); if (stage === 'idle' && mode === 'camera') onMode('camera') }}
          onCapture={(img) => { setCameraOpen(false); recognize(img) }}
        />
      )}

      {saved && (
        <div className="anim-fade pointer-events-none fixed inset-0 z-[70] grid place-items-center">
          <div className="glass-strong flex flex-col items-center rounded-[28px] px-8 py-6">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-income text-abyss"><Check size={30} strokeWidth={3} /></div>
            <p className="mt-3 text-[16px] font-semibold">Сохранено</p>
            <p className="num text-[14px] text-mist">{saved.title}, {fmt(saved.amount)}</p>
          </div>
        </div>
      )}
    </>
  )
}
