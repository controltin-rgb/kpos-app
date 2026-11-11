import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/components/icons'
import { IconTile, type Tone } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { useSession } from '@renderer/lib/session'
import { useIsDark, useTheme, type ThemePref } from '@renderer/lib/theme'
import { cn } from '@renderer/lib/utils'

const FEATURE_TILES: { icon: IconName; tone: Tone }[] = [
  { icon: 'monitor', tone: 'orange' },
  { icon: 'box', tone: 'pink' },
  { icon: 'clock', tone: 'violet' },
  { icon: 'cloud', tone: 'green' },
  { icon: 'chart', tone: 'blue' },
]

/** Page and hero backgrounds of docs/design/Main.dc.html, plus their dark-mode counterparts. */
const BACKDROP = {
  light:
    'radial-gradient(circle at 0% 0%, #FFF3E4 0%, rgba(255,243,228,0) 45%), radial-gradient(circle at 100% 20%, #FFE3EC 0%, rgba(255,227,236,0) 45%), radial-gradient(circle at 0% 100%, #E3F7EA 0%, rgba(227,247,234,0) 35%), radial-gradient(circle at 100% 100%, #E9EBFD 0%, rgba(233,235,253,0) 40%), #FAF7F4',
  dark: 'radial-gradient(circle at 0% 0%, rgba(255,164,58,0.14) 0%, rgba(255,164,58,0) 45%), radial-gradient(circle at 100% 20%, rgba(240,90,142,0.13) 0%, rgba(240,90,142,0) 45%), radial-gradient(circle at 0% 100%, rgba(52,201,138,0.11) 0%, rgba(52,201,138,0) 35%), radial-gradient(circle at 100% 100%, rgba(106,71,219,0.18) 0%, rgba(106,71,219,0) 40%), #121418',
}
const HERO = {
  light: 'linear-gradient(135deg, #FFEEDD 0%, #FDE5EC 55%, #EEEDFD 100%)',
  dark: 'linear-gradient(135deg, #2E2219 0%, #2D1C26 55%, #221F3A 100%)',
}

const THEME_ICON: Record<ThemePref, 'sun' | 'moon' | 'monitor'> = { light: 'sun', dark: 'moon', auto: 'monitor' }

/** Light / Dark / System dropdown (login, setup and forced password change pages) — pill button + rounded menu. */
export function ThemeSelect() {
  const [theme, setTheme] = useTheme()
  const [open, setOpen] = useState(false)
  const h = t.header
  const options: { value: ThemePref; label: string }[] = [
    { value: 'light', label: h.themeLight },
    { value: 'dark', label: h.themeDark },
    { value: 'auto', label: h.themeAuto },
  ]
  const current = options.find((o) => o.value === theme)!
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${h.theme}: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 cursor-pointer items-center gap-2 rounded-[22px] border-0 bg-[#F7F5F2] py-0 pr-3 pl-1.5 text-sm font-semibold text-foreground shadow-[0_1px_3px_rgba(40,30,60,0.08)]"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(40,30,60,0.12)]">
          <Icon name={THEME_ICON[theme]} size={16} color="#4B2FB8" />
        </span>
        {current.label}
        <Icon name="chevronDown" size={14} color="#5C6270" className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            aria-label={h.theme}
            className="absolute top-[52px] right-0 z-30 m-0 box-border flex w-[200px] list-none flex-col gap-1 rounded-[18px] border border-border bg-white p-1.5 shadow-[0_18px_44px_rgba(40,30,60,0.2)]"
          >
            {options.map((o) => {
              const on = o.value === theme
              return (
                <li key={o.value} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => {
                      setTheme(o.value)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[14px] border-0 px-2.5 text-left text-sm',
                      on ? 'bg-accent font-bold text-accent-foreground' : 'bg-transparent text-foreground',
                    )}
                  >
                    <Icon name={THEME_ICON[o.value]} size={16} color={on ? '#4B2FB8' : '#5C6270'} />
                    <span className="flex-1">{o.label}</span>
                    {on && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4B2FB8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

/** Two-panel card from docs/design/Main.dc.html (confirmed design). */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { system } = useSession()
  const mode = useIsDark() ? 'dark' : 'light'
  return (
    <div className="box-border flex min-h-full items-center justify-center px-6 py-12" style={{ background: BACKDROP[mode] }}>
      <div className="flex w-full max-w-[960px] flex-wrap overflow-hidden rounded-[28px] bg-white shadow-[0_24px_60px_rgba(60,40,90,0.14)]">
        <section
          className="relative box-border flex min-w-0 flex-[1_1_400px] flex-col gap-[22px] overflow-hidden px-10 py-11"
          style={{ background: HERO[mode] }}
        >
          <div className="absolute -top-[50px] -right-10 size-[230px] rounded-full bg-[#FFDDB8] opacity-80" />
          <div className="absolute -bottom-[60px] -left-[50px] size-[200px] rounded-full bg-[#FAD0E0] opacity-70" />
          <div className="relative">
            <IconTile icon="cup" tone="orange" size={56} iconSize={28} radius={16} shadow />
          </div>
          <h1 className="relative m-0 text-[30px] leading-[1.3] font-bold">
            {t.login.heroTitle[0]}
            <br />
            {t.login.heroTitle[1]}
          </h1>
          <div className="relative text-[15px] leading-relaxed text-[#4A5060]">{t.login.heroText}</div>
          <div className="relative mt-1 flex flex-col gap-3">
            {t.login.features.map((f, i) => (
              <div key={f} className="flex items-center gap-3 text-sm">
                <IconTile icon={FEATURE_TILES[i]!.icon} tone={FEATURE_TILES[i]!.tone} size={36} iconSize={18} radius={10} />
                {f}
              </div>
            ))}
          </div>
        </section>

        <section className="relative box-border flex min-w-0 flex-[1_1_400px] flex-col justify-center gap-[18px] bg-white px-12 py-11">
          <div className="absolute top-4 right-4">
            <ThemeSelect />
          </div>
          {children}
          <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-[#1BA56B]" />
              {t.common.online}
            </span>
            <span>{t.common.deviceMode(t.common.deviceModes.standalone)}</span>
            <span>
              {t.app.version(system?.appVersion ?? '')} · {t.app.copyright}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

export function AuthTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <IconTile icon="cup" tone="orange" size={56} iconSize={28} radius={16} shadow />
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[28px] font-bold">{title}</h2>
        <div className="text-[13px] text-muted-foreground">{subtitle}</div>
      </div>
    </>
  )
}

/** 48px input with a leading icon (login style). */
export function AuthInput({
  id,
  label,
  icon,
  error,
  hint,
  type = 'text',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; icon: IconName; error?: string | undefined; hint?: string }) {
  const [reveal, setReveal] = useState(false)
  const isPassword = type === 'password'
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold">
        {label}
      </label>
      <div className="relative">
        <Icon name={icon} color="#6B7280" className="absolute top-[15px] left-3.5" />
        <input
          id={id}
          type={isPassword && reveal ? 'text' : type}
          aria-invalid={error ? true : undefined}
          className={cn(
            'box-border h-12 w-full rounded-xl border bg-[#F8F6F3] pl-11 text-[15px] text-foreground focus:outline-2 focus:outline-offset-1 focus:outline-[#9776F6]',
            isPassword ? 'pr-12' : 'pr-3.5',
            error ? 'border-danger-foreground' : 'border-[#E8E4DF]',
          )}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            aria-label={reveal ? t.common.hidePassword : t.common.showPassword}
            aria-pressed={reveal}
            onClick={() => setReveal((v) => !v)}
            className="absolute top-0.5 right-1 flex size-11 cursor-pointer items-center justify-center border-0 bg-transparent"
          >
            <Icon name="eye" color="#6B7280" />
          </button>
        )}
      </div>
      {error ? <span className="text-xs text-danger-foreground">{error}</span> : hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

export function AuthSubmit({ children, busy, disabled }: { children: ReactNode; busy?: boolean; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-1.5 flex h-[52px] cursor-pointer items-center justify-center gap-2.5 rounded-xl border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-base font-semibold text-white shadow-[0_10px_22px_rgba(106,71,219,0.32)] disabled:cursor-wait disabled:opacity-70"
    >
      <Icon name="login" color="#FFFFFF" />
      {children}
    </button>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="rounded-xl bg-danger px-3.5 py-2.5 text-sm text-danger-foreground">
      {message}
    </div>
  )
}
