import type { ReactNode } from 'react'

/** Labelled glass input in the app's standard style. `flag` marks a recognised value the user should check. */
export function Field({ label, value, onChange, placeholder, hint, error, flag, inputMode, type = 'text', multiline, autoFocus, right, maxLength = 300 }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  error?: string | null
  flag?: boolean
  inputMode?: 'text' | 'decimal' | 'numeric' | 'email' | 'tel'
  type?: string
  multiline?: boolean
  autoFocus?: boolean
  right?: ReactNode
  maxLength?: number
}) {
  const cls = `glass w-full rounded-2xl px-4 outline-none placeholder:text-fog ${flag ? 'ring-1 ring-amber/60' : ''} ${error ? 'ring-1 ring-expense/70' : ''}`
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between px-1 text-[13px] text-mist">
        <span>{label}</span>
        {flag && <span className="text-amber">проверьте</span>}
      </span>
      <span className="relative block">
        {multiline ? (
          <textarea value={value} maxLength={maxLength} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className={`${cls} min-h-24 resize-none py-3.5 text-[16px]`} />
        ) : (
          <input value={value} maxLength={maxLength} autoFocus={autoFocus} type={type} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${cls} h-14 text-[16px] ${right ? 'pr-14' : ''}`} />
        )}
        {right && <span className="absolute inset-y-0 right-2 flex items-center">{right}</span>}
      </span>
      {(error || hint) && <span className={`mt-1 block px-1 text-[12px] ${error ? 'text-expense' : 'text-fog'}`}>{error || hint}</span>}
    </label>
  )
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="press glass flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left">
      <span className="flex-1">
        <span className="block text-[16px]">{label}</span>
        {hint && <span className="block text-[12px] text-fog">{hint}</span>}
      </span>
      <span className={`relative h-7 w-12 rounded-full transition-colors ${checked ? 'bg-iris/80' : 'bg-white/12'}`}>
        <span className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform" style={{ transform: `translateX(${checked ? 22 : 2}px)` }} />
      </span>
    </button>
  )
}
