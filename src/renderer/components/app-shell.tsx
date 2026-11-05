import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { t } from '@renderer/i18n'
import { initials } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'
import { Icon } from './icons'
import { NAV, ROUTES, type NavItem } from './nav'
import { GRADIENTS, IconTile, useToast } from './ui'

const itemBase = 'flex min-h-12 items-center gap-3 rounded-[14px] px-2.5 text-sm no-underline'

/** Sidebar + header from docs/design/Dashboard.dc.html (confirmed design — keep in sync). */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(true)
  const { pathname } = useLocation()
  const crumb = ROUTES.find((r) => r.path === pathname)
  return (
    <div className="flex min-h-full flex-wrap bg-background text-foreground">
      {navOpen && <Sidebar pathname={pathname} />}
      <div className="flex min-w-0 flex-[999_1_560px] flex-col">
        <Header onToggleNav={() => setNavOpen((v) => !v)} title={crumb?.breadcrumb ?? crumb?.label ?? ''} />
        <main className="flex flex-col gap-[18px] px-7 pt-2 pb-8">{children}</main>
      </div>
    </div>
  )
}

function Sidebar({ pathname }: { pathname: string }) {
  const { can, user, system } = useSession()
  const visible = (p: NavItem['permission']) => p === null || p === undefined || can(p)
  const items = NAV.map((i) => (i.children ? { ...i, children: i.children.filter((c) => visible(c.permission)) } : i)).filter(
    (i) => (i.children ? i.children.length > 0 : visible(i.permission)),
  )
  // groups are collapsed by default; the group containing the current page starts open
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV.filter((i) => i.children?.some((c) => c.path === pathname)).map((i) => [i.key, true])),
  )

  return (
    <nav
      aria-label={t.nav.ariaLabel}
      className="box-border flex w-[248px] flex-[0_0_248px] flex-col gap-1 border-r border-border bg-white px-3 py-[18px]"
    >
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-[18px]">
        <IconTile icon="cup" tone="orange" size={44} iconSize={24} radius={13} shadow />
        <div className="flex flex-col leading-tight">
          <span className="text-[15px] font-bold">{t.app.shortName}</span>
          <span className="text-xs text-muted-foreground">{user?.branchName}</span>
        </div>
      </div>

      {items.map((item) => {
        if (!item.children) {
          const active = pathname === item.path
          return (
            <Link
              key={item.key}
              to={item.path!}
              aria-current={active ? 'page' : undefined}
              className={cn(itemBase, active ? 'bg-accent font-semibold text-accent-foreground' : 'text-[#2B3040]')}
            >
              <IconTile icon={item.icon} tone={item.tone} size={32} iconSize={16} radius={9} />
              {item.label}
            </Link>
          )
        }
        const isOpen = !!open[item.key]
        const hasActive = item.children.some((c) => c.path === pathname)
        return (
          <div key={item.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [item.key]: !o[item.key] }))}
              className={cn(
                itemBase,
                'w-full cursor-pointer border-0 text-left',
                isOpen || hasActive ? 'bg-[#F5F2FE] font-semibold text-accent-foreground' : 'bg-transparent text-[#2B3040]',
              )}
            >
              <IconTile icon={item.icon} tone={item.tone} size={32} iconSize={16} radius={9} />
              <span className="flex-1">{item.label}</span>
              <Icon name="chevronDown" size={14} color="#4B2FB8" className={cn('transition-transform duration-150', isOpen && 'rotate-180')} />
            </button>
            {isOpen && (
              <div className="ml-[26px] flex flex-col gap-0.5 border-l-2 border-accent pl-2.5">
                {item.children.map((c) => {
                  const active = pathname === c.path
                  return (
                    <Link
                      key={c.path}
                      to={c.path}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm no-underline',
                        active ? 'bg-accent font-semibold text-accent-foreground' : 'text-[#4A5060]',
                      )}
                    >
                      <span className={cn('size-[7px] rounded-full', active ? 'bg-[#6A47DB]' : 'bg-[#CFC9C0]')} />
                      {c.label}
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <div className="mt-auto border-t border-border px-2 pt-3.5 text-center text-xs leading-normal text-muted-foreground">
        {t.app.developer}
        <br />
        {t.app.version(system?.appVersion ?? '')}
      </div>
    </nav>
  )
}

type Theme = 'light' | 'auto' | 'dark'

function Header({ onToggleNav, title }: { onToggleNav: () => void; title: string }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const [panel, setPanel] = useState<'bell' | 'user' | null>(null)
  const [theme, setTheme] = useState<Theme>('light')
  const h = t.header

  const pickTheme = (k: Theme) => {
    if (k !== 'light') {
      toast(h.themeDarkSoon, 'info')
      return
    }
    setTheme(k)
  }
  const themeBtn = (k: Theme, label: string, icon: 'sun' | 'monitor' | 'moon') => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={theme === k}
      onClick={() => pickTheme(k)}
      className="flex h-[38px] w-11 cursor-pointer items-center justify-center rounded-[19px] border-0"
      style={{ background: theme === k ? '#EDE9FB' : 'transparent' }}
    >
      <Icon name={icon} color="#4B2FB8" />
    </button>
  )
  const popover = (w: number) =>
    ({
      width: w,
    }) as const
  const popClass =
    'absolute top-[58px] right-0 z-30 box-border flex max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-[22px] border border-border bg-white p-3.5 shadow-[0_18px_44px_rgba(40,30,60,0.2)]'
  const arrow = <div className="absolute -top-[7px] right-[18px] size-3.5 rotate-45 border-t border-l border-border bg-white" />
  const menuItems = [
    { label: h.profile, g: GRADIENTS.violet, icon: '👤' },
    { label: h.changePin, g: GRADIENTS.orange, icon: '🔑' },
    { label: h.personalSettings, g: GRADIENTS.blue, icon: '⚙' },
  ]

  return (
    <header className="box-border flex min-h-16 flex-wrap items-center gap-3 px-7 py-2.5">
      <button
        type="button"
        onClick={onToggleNav}
        aria-label={t.nav.toggle}
        className="flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-[#ECE8E3]"
      >
        <Icon name="menu" size={20} color="#1F2430" />
      </button>
      <div className="text-[15px] text-[#4A5060]">{title}</div>
      <div className="flex-1" />
      <div className="inline-flex h-[38px] items-center gap-2 rounded-[19px] bg-success px-3.5 text-[13px] font-semibold text-success-foreground">
        <span className="inline-block size-2 rounded-full bg-[#1BA56B]" />
        {t.common.syncPending(0)}
      </div>
      <div role="group" aria-label={h.theme} className="inline-flex rounded-[22px] bg-white p-[3px] shadow-[0_1px_3px_rgba(40,30,60,0.1)]">
        {themeBtn('light', h.themeLight, 'sun')}
        {themeBtn('auto', h.themeAuto, 'monitor')}
        {themeBtn('dark', h.themeDark, 'moon')}
      </div>

      {panel && <div className="fixed inset-0 z-20 bg-transparent" onClick={() => setPanel(null)} />}

      <div className="relative">
        <button
          type="button"
          onClick={() => setPanel(panel === 'bell' ? null : 'bell')}
          aria-label={h.notifications}
          aria-expanded={panel === 'bell'}
          className="relative flex size-11 cursor-pointer items-center justify-center rounded-[22px] border-0 bg-white shadow-[0_1px_3px_rgba(40,30,60,0.1)]"
        >
          <Icon name="bell" size={20} color="#1F2430" />
        </button>
        {panel === 'bell' && (
          <div className={popClass} style={popover(380)}>
            {arrow}
            <div className="relative flex items-center gap-2.5 px-1.5 pt-1 pb-0.5">
              <span className="flex-1 text-[17px] font-bold">{h.notifications}</span>
            </div>
            <div className="p-6 text-center text-sm text-muted-foreground">{h.noNotifications}</div>
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setPanel(panel === 'user' ? null : 'user')}
          aria-label={h.userMenu}
          aria-expanded={panel === 'user'}
          className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-3xl border-0 bg-white py-0 pr-3.5 pl-1.5 shadow-[0_1px_3px_rgba(40,30,60,0.1)]"
        >
          <span className="flex size-9 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: GRADIENTS.violet }}>
            {initials(user?.displayName ?? '')}
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-sm font-semibold">{user?.displayName}</span>
            <span className="text-xs text-muted-foreground">{user?.roleName}</span>
          </span>
          <Icon name="chevronDown" size={16} color="#5C6270" />
        </button>
        {panel === 'user' && (
          <div className={popClass} style={popover(300)}>
            {arrow}
            <div className="relative flex items-center gap-3 rounded-2xl bg-[linear-gradient(135deg,#EDE9FB,#E3EEFE)] p-4">
              <span
                className="flex size-[52px] shrink-0 items-center justify-center rounded-full text-lg font-bold text-white shadow-[0_6px_14px_rgba(106,71,219,0.3)]"
                style={{ background: GRADIENTS.violet }}
              >
                {initials(user?.displayName ?? '')}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base font-bold">{user?.displayName}</span>
                <span className="text-xs text-muted-foreground">{user?.branchName}</span>
                <span className="mt-0.5 self-start rounded-[10px] bg-white px-2.5 py-0.5 text-[11px] font-bold text-accent-foreground">{user?.roleName}</span>
              </span>
            </div>
            <div className="relative flex flex-col gap-0.5">
              {menuItems.map((m) => (
                <button
                  key={m.label}
                  type="button"
                  onClick={() => {
                    setPanel(null)
                    toast(t.common.comingSoon, 'info')
                  }}
                  className="box-border flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[14px] border-0 bg-transparent px-2 text-sm text-foreground"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[15px] text-white" style={{ background: m.g }}>
                    {m.icon}
                  </span>
                  <span className="flex-1 text-left">{m.label}</span>
                </button>
              ))}
            </div>
            <div className="relative h-px bg-border" />
            <button
              type="button"
              onClick={async () => {
                setPanel(null)
                await logout()
                navigate('/')
              }}
              className="relative box-border flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[14px] border-0 bg-transparent px-2 text-sm font-semibold text-danger-foreground"
            >
              <span className="flex size-8 items-center justify-center rounded-[10px] bg-danger">
                <Icon name="logout" size={16} color="#A6232B" />
              </span>
              <span className="flex-1 text-left">{h.logout}</span>
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
