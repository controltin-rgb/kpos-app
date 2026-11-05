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
import { DashboardPage, ForbiddenPage, PlaceholderPage, SystemPage } from './pages/simple'
import { UsersPage } from './pages/users'

/** Pages that exist so far; every other menu route shows a phase placeholder. */
const PAGES: Record<string, () => ReactNode> = {
  '/': () => <DashboardPage />,
  '/users': () => <UsersPage />,
  '/roles': () => <RolesPage />,
  '/system': () => <SystemPage />,
}

function Guarded({ route }: { route: NavLeaf }) {
  const { can } = useSession()
  // UI gate only — the main process re-checks every call (CLAUDE.md rule 5)
  if (route.permission && !can(route.permission)) return <ForbiddenPage />
  return <>{PAGES[route.path]?.() ?? <PlaceholderPage route={route} />}</>
}

const router = createHashRouter([
  ...ROUTES.map((route) => ({
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
