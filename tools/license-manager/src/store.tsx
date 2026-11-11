import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ManagerState } from '../../../scripts/license-types'
import { useToast } from '@renderer/components/ui'
import { api } from './api'

interface Ctx {
  state: ManagerState | null
  reload: () => Promise<void>
}
const StoreContext = createContext<Ctx>({ state: null, reload: async () => {} })
export const useManager = () => useContext(StoreContext)

/** Loads /api/state once and again whenever a page changes something. */
export function ManagerProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [state, setState] = useState<ManagerState | null>(null)
  const reload = useCallback(async () => {
    try {
      setState(await api.state())
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [toast])
  useEffect(() => {
    api.state().then(setState, (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
  }, [toast])
  return <StoreContext.Provider value={{ state, reload }}>{children}</StoreContext.Provider>
}
