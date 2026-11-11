import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { t } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import type { IconName } from './icons'
import { IconTile, type Tone } from './ui'

export type ConfirmKind = 'danger' | 'warning' | 'primary'

export interface ConfirmOptions {
  title: string
  /** body text; a string keeps line breaks */
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** danger = delete / irreversible, warning = needs care, primary = plain question */
  kind?: ConfirmKind
  icon?: IconName
}

const KIND: Record<ConfirmKind, { tone: Tone; icon: IconName; button: string; ring: string }> = {
  danger: {
    tone: 'red',
    icon: 'trash',
    button: 'bg-[linear-gradient(90deg,#DC3A44,#F4616A)] text-white shadow-[0_8px_16px_rgba(220,58,68,0.28)]',
    ring: '#FFE3E3',
  },
  warning: {
    tone: 'amber',
    icon: 'info',
    button: 'bg-[linear-gradient(90deg,#E5A10C,#F7C23A)] text-[#1F2430] shadow-[0_8px_16px_rgba(229,161,12,0.28)]',
    ring: '#FFF4D6',
  },
  primary: {
    tone: 'violet',
    icon: 'info',
    button: 'bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-white shadow-[0_8px_16px_rgba(106,71,219,0.28)]',
    ring: '#EDE9FB',
  },
}

type Ask = (opts: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<Ask>(() => Promise.resolve(false))

/** Design-system confirm dialog (replaces window.confirm): `if (!(await confirm({...}))) return`. */
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((v: boolean) => void) | null>(null)
  const ask = useCallback<Ask>((opts) => {
    resolver.current?.(false) // a newer question replaces an unanswered one
    setReq(opts)
    return new Promise<boolean>((res) => (resolver.current = res))
  }, [])
  const answer = useCallback((v: boolean) => {
    resolver.current?.(v)
    resolver.current = null
    setReq(null)
  }, [])
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {req && <ConfirmDialog opts={req} onAnswer={answer} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ opts, onAnswer }: { opts: ConfirmOptions; onAnswer: (v: boolean) => void }) {
  const titleId = useId()
  const bodyId = useId()
  const kind = KIND[opts.kind ?? 'primary']
  const okRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // dangerous actions start on "cancel" so Enter never deletes by accident
    ;(opts.kind === 'danger' ? cancelRef : okRef).current?.focus()
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [opts.kind, onAnswer])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(31,36,48,0.4)] p-4" onClick={() => onAnswer(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={opts.message ? bodyId : undefined}
        className="relative box-border flex w-full max-w-[420px] flex-col items-center gap-3 overflow-hidden rounded-[22px] bg-white px-6 pt-7 pb-6 text-center shadow-[0_24px_60px_rgba(60,40,90,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="pointer-events-none absolute -top-12 -right-12 size-36 rounded-full" style={{ background: kind.ring }} />
        <span className="relative rounded-[20px] p-2" style={{ background: kind.ring }}>
          <IconTile icon={opts.icon ?? kind.icon} tone={kind.tone} size={56} iconSize={26} radius={16} shadow />
        </span>
        <h2 id={titleId} className="relative m-0 text-xl font-bold">
          {opts.title}
        </h2>
        {opts.message && (
          <div id={bodyId} className="relative text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
            {opts.message}
          </div>
        )}
        <div className="relative mt-2 flex w-full gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onAnswer(false)}
            className="min-h-12 flex-1 cursor-pointer rounded-full border-[1.5px] border-[#E6E1D9] bg-white text-[15px] font-semibold text-foreground"
          >
            {opts.cancelLabel ?? t.common.cancel}
          </button>
          <button ref={okRef} type="button" onClick={() => onAnswer(true)} className={cn('min-h-12 flex-1 cursor-pointer rounded-full border-0 text-[15px] font-bold', kind.button)}>
            {opts.confirmLabel ?? t.common.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
