import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { t } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { Icon, type IconName } from './icons'

/** Tile gradients from the design tokens (§9). */
export const GRADIENTS = {
  violet: 'linear-gradient(135deg, #8B6CF0, #6A47DB)',
  orange: 'linear-gradient(135deg, #FFA43A, #F7791E)',
  blue: 'linear-gradient(135deg, #4C8DF6, #2F6FE0)',
  green: 'linear-gradient(135deg, #34C98A, #1BA56B)',
  pink: 'linear-gradient(135deg, #F05A8E, #E23B76)',
  red: 'linear-gradient(135deg, #F4616A, #DC3A44)',
  amber: 'linear-gradient(135deg, #F7C23A, #E5A10C)',
  teal: 'linear-gradient(135deg, #2CC4B8, #14A094)',
} as const
export type Tone = keyof typeof GRADIENTS

const SHADOW: Record<Tone, string> = {
  violet: 'rgba(106, 71, 219, 0.3)',
  orange: 'rgba(247, 121, 30, 0.3)',
  blue: 'rgba(47, 111, 224, 0.3)',
  green: 'rgba(27, 165, 107, 0.3)',
  pink: 'rgba(226, 59, 118, 0.3)',
  red: 'rgba(220, 58, 68, 0.3)',
  amber: 'rgba(229, 161, 12, 0.3)',
  teal: 'rgba(20, 160, 148, 0.3)',
}

/** Rounded square with a gradient and a white icon. */
export function IconTile({ icon, tone, size = 32, iconSize, radius, shadow = false }: {
  icon: IconName
  tone: Tone
  size?: number
  iconSize?: number
  radius?: number
  shadow?: boolean
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size * 0.29),
        background: GRADIENTS[tone],
        boxShadow: shadow ? `0 8px 16px ${SHADOW[tone]}` : undefined,
      }}
    >
      <Icon name={icon} size={iconSize ?? Math.round(size / 2)} color="#FFFFFF" />
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'md' | 'lg' }

/** Primary pill button with the brand gradient. Disabled = beige, per prototypes. */
export function GradientButton({ className, size = 'md', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2.5 rounded-full border-0 px-[22px] font-bold transition-opacity',
        size === 'lg' ? 'min-h-[52px] text-base' : 'min-h-12 text-[15px]',
        disabled
          ? 'cursor-not-allowed bg-[#E6E1D9] text-[#8C8880]'
          : 'cursor-pointer bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-white shadow-[0_8px_16px_rgba(106,71,219,0.28)]',
        className,
      )}
      {...rest}
    />
  )
}

export function OutlineButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-[#E6E1D9] bg-white px-5 text-[15px] font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  )
}

export function DangerButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-[52px] cursor-pointer items-center justify-center rounded-full border-0 bg-danger px-5 text-[15px] font-semibold text-danger-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  )
}

/** 52×32 switch (design system: never a plain checkbox). */
export function Toggle({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        'relative h-8 w-[52px] shrink-0 rounded-2xl border-0 p-0 transition-[background]',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
      style={{ background: checked ? 'linear-gradient(90deg,#6A47DB,#9776F6)' : '#D5D1CA' }}
    >
      <span
        className="absolute top-[3px] size-[26px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-[left]"
        style={{ left: checked ? 23 : 3 }}
      />
    </button>
  )
}

/** `.u-in` input from the Users/Roles prototypes (44px, 14px radius). */
export const inputClass =
  'min-h-11 w-full box-border rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-white px-3.5 text-[15px] text-foreground focus:outline-2 focus:outline-offset-1 focus:outline-[#9776F6] disabled:bg-[#F7F5F2] disabled:text-muted-foreground'

export function TextInput({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(inputClass, invalid && 'border-danger-foreground', className)} aria-invalid={invalid || undefined} {...rest} />
}

export function SelectInput({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(inputClass, 'cursor-pointer', className)} {...rest} />
}

export function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-semibold">
      {label}
      {children}
      {error ? (
        <span className="text-xs font-medium text-danger-foreground">{error}</span>
      ) : hint ? (
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}

export function Chip({ children, bg = '#EDE9FB', fg = '#4B2FB8', className }: { children: ReactNode; bg?: string; fg?: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-7 items-center rounded-[14px] px-3 text-[13px] font-semibold whitespace-nowrap', className)}
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  )
}

/** Page title block used at the top of every page in the prototypes. */
export function PageHeader({ icon, tone = 'violet', title, subtitle, actions }: {
  icon: IconName
  tone?: Tone
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3.5">
      <div className="flex flex-[1_1_320px] items-center gap-3.5">
        <IconTile icon={icon} tone={tone} size={52} iconSize={26} radius={15} shadow />
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 text-[26px] font-bold">{title}</h1>
          {subtitle && <div className="text-[13px] text-muted-foreground">{subtitle}</div>}
        </div>
      </div>
      {actions}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('rounded-[22px] bg-white p-5 shadow-[0_1px_3px_rgba(40,30,60,0.08)]', className)}>{children}</section>
}

/** Page buttons (6–7 rows per page per the design system). */
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  const btn = 'flex size-11 cursor-pointer items-center justify-center rounded-full border-0 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <nav aria-label={t.common.pagination.label} className="flex items-center gap-1.5">
      <button type="button" className={cn(btn, 'bg-[#F7F5F2]')} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t.common.pagination.prev}>
        <Icon name="chevronLeft" />
      </button>
      {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          type="button"
          aria-label={t.common.pagination.page(p)}
          aria-current={p === page ? 'page' : undefined}
          onClick={() => onPage(p)}
          className={cn(btn, p === page ? 'bg-accent text-accent-foreground' : 'bg-transparent text-foreground')}
        >
          {p}
        </button>
      ))}
      <button type="button" className={cn(btn, 'bg-[#F7F5F2]')} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t.common.pagination.next}>
        <Icon name="chevronRight" />
      </button>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

type ToastKind = 'success' | 'error' | 'info'
const ToastContext = createContext<(msg: string, kind?: ToastKind) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((msg: string, kind: ToastKind = 'success') => {
    setToast({ msg, kind })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  const colors: Record<ToastKind, string> = {
    success: 'bg-success text-success-foreground',
    error: 'bg-danger text-danger-foreground',
    info: 'bg-accent text-accent-foreground',
  }
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={cn('fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-3 text-sm font-semibold shadow-[0_10px_30px_rgba(40,30,60,0.18)]', colors[toast.kind])}
        >
          {toast.msg}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
