import type { ReactNode } from 'react'
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AppShell } from './components/app-shell'
import { ROUTES, type NavLeaf } from './components/nav'
import { ToastProvider } from './components/ui'
import { t } from './i18n'
import { SessionProvider, useSession } from './lib/session'
import { ChangePasswordPage } from './pages/change-password'
import { LoginPage } from './pages/login'
import { RolesPage } from './pages/roles'
import { SetupPage } from './pages/setup'
import { CategoriesPage, ModifiersPage } from './pages/catalog-misc'
import { CfdPage } from './pages/cfd'
import { InventoryPage } from './pages/inventory'
import { OrdersPage } from './pages/orders'
import { ProductsPage } from './pages/products'
import { SettingsPage } from './pages/settings'
import { KdsPage } from './pages/kds'
import { PosPage } from './pages/pos'
import { ShiftPage } from './pages/shift'
import { DashboardPage } from './pages/dashboard'
import { ExpensesPage } from './pages/expenses'
import { LabelPage } from './pages/label'
import { CouponsPage, PromoPage } from './pages/promo'
import { ReceivingPage } from './pages/receiving'
import { DeliveryCommissionPage, ReportsPage, ZReportPage } from './pages/reports'
import { WastePage } from './pages/waste'
import { ForbiddenPage, PlaceholderPage, SystemPage } from './pages/simple'
import { UsersPage } from './pages/users'
import { AuditPage } from './pages/audit'
import { BackupPage } from './pages/backup'
import { HostOfflinePage } from './pages/lan'

/** Pages that exist so far; every other menu route shows a phase placeholder. */
const PAGES: Record<string, () => ReactNode> = {
  '/': () => <DashboardPage />,
  '/shift': () => <ShiftPage />,
  '/orders': () => <OrdersPage />,
  '/products': () => <ProductsPage />,
  '/categories': () => <CategoriesPage />,
  '/modifiers': () => <ModifiersPage />,
  '/inventory': () => <InventoryPage />,
  '/receiving': () => <ReceivingPage />,
  '/stock-count': () => <ReceivingPage />,
  '/waste': () => <WastePage />,
  '/expenses': () => <ExpensesPage />,
  '/promo': () => <PromoPage />,
  '/coupons': () => <CouponsPage />,
  '/reports': () => <ReportsPage />,
  '/z-report': () => <ZReportPage />,
  '/delivery-commission': () => <DeliveryCommissionPage />,
  '/label': () => <LabelPage />,
  '/settings': () => <SettingsPage />,
  '/users': () => <UsersPage />,
  '/roles': () => <RolesPage />,
  '/audit': () => <AuditPage />,
  '/backup': () => <BackupPage />,
  '/system': () => <SystemPage />,
}

function Guarded({ route }: { route: NavLeaf }) {
  const { can } = useSession()
  // UI gate only — the main process re-checks every call (CLAUDE.md rule 5)
  if (route.permission && !can(route.permission)) return <ForbiddenPage />
  return <>{PAGES[route.path]?.() ?? <PlaceholderPage route={route} />}</>
}

/** Full-screen pages with their own header (no sidebar), per the confirmed prototypes. */
const FULL_SCREEN: Record<string, { permission: NavLeaf['permission']; page: () => ReactNode }> = {
  '/pos': { permission: 'pos:view', page: () => <PosPage /> },
  '/kds': { permission: 'kds:view', page: () => <KdsPage /> },
}

function FullScreen({ path }: { path: string }) {
  const { can } = useSession()
  const def = FULL_SCREEN[path]!
  if (def.permission && !can(def.permission))
    return (
      <AppShell>
        <ForbiddenPage />
      </AppShell>
    )
  return <>{def.page()}</>
}

const router = createHashRouter([
  ...Object.keys(FULL_SCREEN).map((path) => ({ path, element: <FullScreen path={path} /> })),
  ...ROUTES.filter((r) => !FULL_SCREEN[r.path]).map((route) => ({
    path: route.path,
    element: (
      <AppShell>
        <Guarded route={route} />
      </AppShell>
    ),
  })),
  { path: '*', element: <Navigate to="/" replace /> },
])

/** Picks the screen from the session state: setup → login → forced password change → app. */
function Gate() {
  const { status, setup, user } = useSession()
  // the customer display needs no login: it only shows what the POS pushes
  if (window.location.hash.startsWith('#/cfd')) return <CfdPage />
  if (status === 'offline') return <HostOfflinePage />
  if (status === 'loading') return <div className="flex h-full items-center justify-center text-muted-foreground">{t.common.loading}</div>
  if (setup?.setupRequired) return <SetupPage />
  if (!user) return <LoginPage />
  if (user.mustChangePassword) return <ChangePasswordPage />
  return <RouterProvider router={router} />
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </SessionProvider>
  )
}
