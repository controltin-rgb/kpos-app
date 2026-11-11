import { useEffect, useState } from 'react'
import { ConfirmProvider } from '@renderer/components/confirm'
import { Icon, type IconName } from '@renderer/components/icons'
import { IconTile, ToastProvider, type Tone } from '@renderer/components/ui'
import { cn } from '@renderer/lib/utils'
import { lm } from './i18n'
import { CustomersPage } from './pages/customers'
import { ManualPage } from './pages/manual'
import { OverviewPage } from './pages/overview'
import { RegistryPage } from './pages/registry'
import { SettingsPage } from './pages/settings'
import { VerifyPage } from './pages/verify'
import { ManagerProvider } from './store'

type Route = 'overview' | 'customers' | 'registry' | 'verify' | 'settings' | 'manual'
const NAV: { route: Route; icon: IconName; tone: Tone }[] = [
  { route: 'overview', icon: 'chart', tone: 'violet' },
  { route: 'customers', icon: 'users', tone: 'orange' },
  { route: 'registry', icon: 'receipt', tone: 'blue' },
  { route: 'verify', icon: 'shield', tone: 'green' },
  { route: 'settings', icon: 'lock', tone: 'pink' },
  { route: 'manual', icon: 'info', tone: 'blue' },
]
const PAGES: Record<Route, () => React.JSX.Element | null> = {
  overview: OverviewPage,
  customers: CustomersPage,
  registry: RegistryPage,
  verify: VerifyPage,
  settings: SettingsPage,
  manual: ManualPage,
}

const fromHash = (): Route => (NAV.find((n) => `#/${n.route}` === location.hash)?.route ?? 'overview')

export function App() {
  const [route, setRoute] = useState<Route>(fromHash)
  useEffect(() => {
    const h = () => setRoute(fromHash())
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  const Page = PAGES[route]
  return (
    <ToastProvider>
      <ConfirmProvider>
        <ManagerProvider>
          <div className="flex min-h-screen flex-col">
            <div className="bg-[#FFF4D6] px-4 py-2 text-center text-[13px] font-semibold text-[#7A5200]">{lm.devOnly}</div>
            <div className="flex flex-1">
              <nav className="flex w-[250px] shrink-0 flex-col gap-1.5 p-4">
                <div className="flex items-center gap-3 px-2 pb-4">
                  <IconTile icon="lock" tone="violet" size={40} iconSize={20} radius={12} shadow />
                  <span className="text-[15px] leading-tight font-bold">{lm.app}</span>
                </div>
                {NAV.map((n) => (
                  <a
                    key={n.route}
                    href={`#/${n.route}`}
                    aria-current={n.route === route ? 'page' : undefined}
                    className={cn('flex min-h-12 items-center gap-3 rounded-2xl px-3 text-[15px] no-underline', n.route === route ? 'bg-accent font-bold text-accent-foreground' : 'text-foreground')}
                  >
                    <IconTile icon={n.icon} tone={n.tone} size={32} iconSize={16} radius={10} />
                    {lm.nav[n.route]}
                  </a>
                ))}
                <div className="flex-1" />
                <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                  <Icon name="info" size={14} color="#5C6270" />
                  127.0.0.1 only
                </span>
              </nav>
              <main className="flex min-w-0 flex-1 flex-col gap-[18px] p-6 pl-2">
                <Page />
              </main>
            </div>
          </div>
        </ManagerProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
