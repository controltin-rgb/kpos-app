import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionUser, SetupStatus, SystemInfo } from '@shared/api'
import { FULL_FEATURES, type LicenseFeatures } from '@shared/license'
import { hasPermission, type Permission } from '@shared/permissions'
import { ApiError, call, onUnauthenticated } from './api'

interface SessionState {
  /** offline = a Client that cannot reach its Host (D33) */
  status: 'loading' | 'ready' | 'offline'
  /** error code while offline (LAN_UNREACHABLE / LAN_DEVICE_REVOKED / LAN_CERT_MISMATCH) */
  offlineCode: string | null
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
const OFFLINE_RETRY_MS = 5_000

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [offlineCode, setOfflineCode] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)

  const apply = useCallback(([me, st, sys]: [SessionUser | null, SetupStatus, SystemInfo]) => {
    setUser(me)
    setSetup(st)
    setSystem(sys)
    setOfflineCode(null)
    setStatus('ready')
  }, [])

  /** A Client whose Host is unreachable: show the offline screen and keep retrying. */
  const fail = useCallback((err: unknown) => {
    const code = err instanceof ApiError ? err.code : 'INTERNAL'
    if (!code.startsWith('LAN_')) throw err
    setOfflineCode(code)
    setStatus('offline')
  }, [])

  const refresh = useCallback(async () => {
    try {
      apply(await fetchSession())
    } catch (err) {
      fail(err)
    }
  }, [apply, fail])

  useEffect(() => {
    let alive = true
    const reload = () =>
      void fetchSession().then(
        (s) => alive && apply(s),
        (err: unknown) => alive && fail(err),
      )
    reload()
    const off = onUnauthenticated(reload)
    // a Client reconnecting to its Host reloads the session
    const offEvents = window.kposs.onEvent((e) => {
      if (e.type === 'lan.state' && e.connected) reload()
    })
    // a newly installed license changes the features (D51): menus and pages follow at once, no restart needed
    const onLicense = () => void call('system.info').then((sys) => alive && setSystem(sys), () => undefined)
    window.addEventListener('kposs:license-changed', onLicense)
    return () => {
      alive = false
      off()
      offEvents()
      window.removeEventListener('kposs:license-changed', onLicense)
    }
  }, [apply, fail])

  useEffect(() => {
    if (status !== 'offline' || offlineCode === 'LAN_DEVICE_REVOKED' || offlineCode === 'LAN_CERT_MISMATCH') return
    const h = setInterval(() => void refresh(), OFFLINE_RETRY_MS)
    return () => clearInterval(h)
  }, [status, offlineCode, refresh])

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
    () => ({ status, offlineCode, user, setup, system, refresh, setUser, logout, can }),
    [status, offlineCode, user, setup, system, refresh, logout, can],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession outside SessionProvider')
  return ctx
}

/** What the license grants (D51). Until the system info is loaded everything reads as on, so nothing flashes away. */
export function useFeatures(): LicenseFeatures {
  return useSession().system?.features ?? FULL_FEATURES
}
