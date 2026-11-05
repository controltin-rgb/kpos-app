import { useEffect, useId, useState, type ReactNode } from 'react'
import { bahtToSatang } from '@shared/money'
import { t } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { inputClass } from './ui'

/** Centered dialog card (22px radius, design-system shadow). Esc / backdrop click closes when allowed. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = 460,
  footer,
}: {
  title: string
  subtitle?: string | undefined
  onClose?: (() => void) | undefined
  children: ReactNode
  width?: number
  footer?: ReactNode
}) {
  const titleId = useId()
  useEffect(() => {
    if (!onClose) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(31,36,48,0.35)] p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="box-border flex max-h-[calc(100vh-32px)] w-full flex-col gap-4 overflow-auto rounded-[22px] bg-white p-6 shadow-[0_24px_60px_rgba(60,40,90,0.25)]"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="m-0 text-xl font-bold">
              {title}
            </h2>
            {subtitle && <span className="text-[13px] text-muted-foreground">{subtitle}</span>}
          </div>
          {onClose && (
            <button type="button" aria-label={t.common.close} onClick={onClose} className="flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-[#F3F0EC] text-xl">
              ×
            </button>
          )}
        </div>
        {children}
        {footer}
      </div>
    </div>
  )
}

/** Baht input that reports integer satang (string parsing only — never floats, CLAUDE.md rule 1). */
export function MoneyInput({
  value,
  onChange,
  className,
  autoFocus,
  ariaLabel,
  big,
}: {
  value: number | null
  onChange: (satang: number | null) => void
  className?: string
  autoFocus?: boolean
  ariaLabel?: string
  big?: boolean
}) {
  const [text, setText] = useState(value === null ? '' : formatPlain(value))
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    // external change (e.g. quick-amount buttons): resync the text during render
    setLastValue(value)
    setText(value === null ? '' : formatPlain(value))
  }
  return (
    <input
      inputMode="decimal"
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d.,]/g, '')
        setText(v)
        const parsed = parseBaht(v)
        setLastValue(parsed)
        onChange(parsed)
      }}
      className={cn(inputClass, 'text-right', big && 'min-h-14 text-2xl font-bold', className)}
    />
  )
}

function parseBaht(v: string): number | null {
  if (!v) return null
  try {
    return bahtToSatang(v)
  } catch {
    return null
  }
}

function formatPlain(satang: number): string {
  return satang % 100 ? (satang / 100).toFixed(2) : String(satang / 100)
}

/** Segmented control (POS order type style). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 rounded-2xl bg-[#F3F0EC] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-11 flex-1 cursor-pointer rounded-xl border-0 text-sm',
            o.value === value ? 'bg-white font-bold text-accent-foreground shadow-[0_1px_3px_rgba(40,30,60,0.18)]' : 'bg-transparent text-[#4A5060]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
