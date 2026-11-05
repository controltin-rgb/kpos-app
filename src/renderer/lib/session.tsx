import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionUser, SetupStatus, SystemInfo } from '@shared/api'
import { hasPermission, type Permission } from '@shared/permissions'
import { call, onUnauthenticated } from './api'

interface SessionState {
  status: 'loading' | 'ready'
  user: SessionUser | null
  setup: SetupStatus | null
  system: SystemInfo | null
  /** reload user + setup status from main */
  refresh: () => Promise<void>
  setUser: (u: SessionUser | null) => void
  logout: () => Promise<void>
  /** UI-side check only — the main process enforces every permission again */
  can: (p: Permission) => boolean
}

const SessionContext = createContext<SessionState | null>(null)

const fetchSession = () => Promise.all([call('auth.me'), call('setup.status'), call('system.info')])

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)

  const apply = useCallback(([me, st, sys]: [SessionUser | null, SetupStatus, SystemInfo]) => {
    setUser(me)
    setSetup(st)
    setSystem(sys)
    setStatus('ready')
  }, [])

  const refresh = useCallback(async () => apply(await fetchSession()), [apply])

  useEffect(() => {
    let alive = true
    const reload = () => void fetchSession().then((s) => alive && apply(s))
    reload()
    const off = onUnauthenticated(reload)
    return () => {
      alive = false
      off()
    }
  }, [apply])

  const logout = useCallback(async () => {
    try {
      await call('auth.logout')
    } finally {
      setUser(null)
    }
  }, [])

  const grants = useMemo(() => new Set(user?.permissions ?? []), [user])
  const can = useCallback((p: Permission) => hasPermission(grants, p), [grants])

  const value = useMemo(
    () => ({ status, user, setup, system, refresh, setUser, logout, can }),
    [status, user, setup, system, refresh, logout, can],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession outside SessionProvider')
  return ctx
}
