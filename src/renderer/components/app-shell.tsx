import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { LicenseBanner } from './license-banner'
import { ConnectionChip } from './connection-chip'
import type { NotificationDto } from '@shared/api-dashboard'
import { call } from '@renderer/lib/api'
import { useAppEvent, useNow } from '@renderer/lib/events'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { t } from '@renderer/i18n'
import { initials } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { useTheme, type ThemePref } from '@renderer/lib/theme'
import { cn } from '@renderer/lib/utils'
import { Icon } from './icons'
import { NAV, ROUTES, type NavItem } from './nav'
import { GRADIENTS, IconTile } from './ui'

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
        <main className="flex flex-col gap-[18px] px-7 pt-2 pb-8">
          <LicenseBanner />
          {children}
        </main>
      </div>
    </div>
  )
}

function Sidebar({ pathname }: { pathname: string }) {
  const { can, user, system } = useSession()
  const visible = (p: NavItem['permission']) => p === null || p === undefined || can(p)
  const featureOn = (f: NavItem['feature']) => f !== 'delivery' || system?.deliveryEnabled !== false
  const items = NAV.map((i) => (i.children ? { ...i, children: i.children.filter((c) => visible(c.permission) && featureOn(c.feature)) } : i)).filter(
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

const NOTE_STYLE: Record<NotificationDto['kind'], { icon: string; g: string }> = {
  low_stock: { icon: '!', g: '#F4616A, #DC3A44' },
  near_expiry: { icon: '⏱', g: '#FFA43A, #F7791E' },
  pending_count: { icon: '✓', g: '#4C8DF6, #2F6FE0' },
}

/** Notification bell from docs/design/Dashboard.dc.html (confirmed): live alerts, unread filter. */
function Bell({ open, onToggle, onClose, popClass, arrow }: { open: boolean; onToggle: () => void; onClose: () => void; popClass: string; arrow: ReactNode }) {
  const navigate = useNavigate()
  const [data, setData] = useState<{ items: NotificationDto[]; unread: number }>({ items: [], unread: 0 })
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const now = useNow(60_000)
  const load = useCallback(() => call('notifications.list').then(setData, () => {}), [])
  useEffect(() => {
    void load()
  }, [load, now])
  useAppEvent((e) => {
    if (e.type === 'bill.changed') void load()
  })
  const h = t.header
  const shown = data.items.filter((n) => filter === 'all' || !n.read)
  const readAll = async () => {
    await call('notifications.read', { id: null })
    void load()
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label={data.unread ? h.notificationsUnread(data.unread) : h.notifications}
        aria-expanded={open}
        className="relative flex size-11 cursor-pointer items-center justify-center rounded-[22px] border-0 bg-white shadow-[0_1px_3px_rgba(40,30,60,0.1)]"
      >
        <Icon name="bell" size={20} color="#1F2430" />
        {data.unread > 0 && (
          <span className="absolute -top-[3px] -right-[3px] box-border flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-[#E23B76] px-[5px] text-xs font-bold text-white">{data.unread}</span>
        )}
      </button>
      {open && (
        <div className={popClass} style={{ width: 380 }}>
          {arrow}
          <div className="relative flex items-center gap-2.5 px-1.5 pt-1 pb-0.5">
            <span className="flex-1 text-[17px] font-bold">{h.notifications}</span>
            <span className="rounded-xl px-3 py-[3px] text-xs font-bold" style={data.unread ? { background: '#FFE3E3', color: '#A6232B' } : { background: '#DDF5E8', color: '#11724A' }}>
              {data.unread ? t.dash.newN(data.unread) : t.dash.allRead}
            </span>
          </div>
          <div role="group" aria-label={t.dash.notifFilter} className="relative my-0.5 flex gap-1.5 rounded-[22px] bg-[#F7F5F2] p-1">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className="min-h-[38px] flex-1 cursor-pointer rounded-[19px] border-0 text-[13px]"
                style={filter === f ? { background: '#FFFFFF', color: '#4B2FB8', fontWeight: 700, boxShadow: '0 1px 3px rgba(40,30,60,0.12)' } : { background: 'transparent', color: '#5C6270' }}
              >
                {f === 'all' ? t.dash.filterAll : t.dash.filterUnread}
              </button>
            ))}
          </div>
          <div className="relative flex max-h-[330px] flex-col gap-1.5 overflow-auto">
            {shown.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void call('notifications.read', { id: n.id }).then(load)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border-0 p-2.5 text-left"
                style={{ background: n.read ? '#FFFFFF' : '#F5F2FE' }}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ background: `linear-gradient(135deg, ${NOTE_STYLE[n.kind].g})` }}>
                  {NOTE_STYLE[n.kind].icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-sm font-semibold text-foreground">{n.title}</span>
                  {n.body && <span className="text-xs text-muted-foreground">{n.body}</span>}
                  <span className="text-[11px] text-[#8C8880]">{t.dash.ago(Math.floor((now - n.createdAt) / 60_000))}</span>
                </span>
                <span className="size-[9px] shrink-0 rounded-full" style={{ background: n.read ? 'transparent' : '#6A47DB' }} />
              </button>
            ))}
            {shown.length === 0 && <div className="px-2 py-6 text-center text-[13px] text-[#8C8880]">{h.noNotifications}</div>}
          </div>
          <div className="relative flex gap-2 border-t border-border pt-2">
            <button type="button" onClick={() => void readAll()} className="min-h-11 flex-1 cursor-pointer rounded-[22px] border-0 bg-accent text-sm font-bold text-accent-foreground">
              {h.readAll}
            </button>
            <button
              type="button"
              onClick={() => {
                onClose()
                navigate('/inventory')
              }}
              className="min-h-11 flex-1 cursor-pointer rounded-[22px] border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-sm font-bold text-white"
            >
              {h.viewAll}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Header({ onToggleNav, title }: { onToggleNav: () => void; title: string }) {
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const [panel, setPanel] = useState<'bell' | 'user' | null>(null)
  const [theme, setTheme] = useTheme()
  const h = t.header

  const themeBtn = (k: ThemePref, label: string, icon: 'sun' | 'monitor' | 'moon') => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={theme === k}
      onClick={() => setTheme(k)}
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
    { label: h.profile, g: GRADIENTS.violet, icon: '👤', tab: 'profile' },
    { label: h.changePin, g: GRADIENTS.orange, icon: '🔑', tab: 'pin' },
    { label: h.personalSettings, g: GRADIENTS.blue, icon: '⚙', tab: 'prefs' },
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
      <ConnectionChip />
      <div role="group" aria-label={h.theme} className="inline-flex rounded-[22px] bg-white p-[3px] shadow-[0_1px_3px_rgba(40,30,60,0.1)]">
        {themeBtn('light', h.themeLight, 'sun')}
        {themeBtn('auto', h.themeAuto, 'monitor')}
        {themeBtn('dark', h.themeDark, 'moon')}
      </div>

      {panel && <div className="fixed inset-0 z-20 bg-transparent" onClick={() => setPanel(null)} />}

      <Bell open={panel === 'bell'} onToggle={() => setPanel(panel === 'bell' ? null : 'bell')} onClose={() => setPanel(null)} popClass={popClass} arrow={arrow} />

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
            {/* plain profile row: theme colours only, readable in light and dark */}
            <div className="relative flex items-center gap-3 rounded-2xl bg-accent px-3.5 py-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full text-base font-bold text-white" style={{ background: GRADIENTS.violet }}>
                {initials(user?.displayName ?? '')}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-bold text-foreground">{user?.displayName}</span>
                <span className="text-xs text-muted-foreground">{user?.roleName}</span>
                <span className="text-xs text-muted-foreground">{user?.branchName}</span>
              </span>
            </div>
            <div className="relative flex flex-col gap-0.5">
              {menuItems.map((m) => (
                <button
                  key={m.label}
                  type="button"
                  onClick={() => {
                    setPanel(null)
                    navigate(`/account?tab=${m.tab}`)
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
