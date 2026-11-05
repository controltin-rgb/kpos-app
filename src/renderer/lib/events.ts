import { useEffect, useRef, useState } from 'react'
import type { AppEvent } from '@shared/api'

/** Subscribe to AppEvents pushed by the main process (KDS updates, customer display, shift changes). */
export function useAppEvent(handler: (e: AppEvent) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => window.kposs.onEvent((e) => ref.current(e)), [])
}

/** Current time, refreshed every `ms` (for elapsed-time displays). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(h)
  }, [ms])
  return now
}
