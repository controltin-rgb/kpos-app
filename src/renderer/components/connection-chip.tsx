import { useEffect, useState } from 'react'
import { call } from '@renderer/lib/api'
import { t } from '@renderer/i18n'
import { useAppEvent } from '@renderer/lib/events'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

/**
 * Status chip in the page header (Dashboard / POS prototypes): "Online" on a Standalone / Host; on a
 * Client the connection to its Host and the offline bills still waiting to be sent (D33, D36).
 */
export function ConnectionChip({ compact = false }: { compact?: boolean }) {
  const { system } = useSession()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [pending, setPending] = useState(0)
  useAppEvent((e) => {
    if (e.type === 'lan.state') setConnected(e.connected)
    if (e.type === 'sync.state') setPending(e.pending)
  })
  const isClient = system?.deviceRole === 'client'
  // a page opened after the last change asks for the current state once
  useEffect(() => {
    if (!isClient) return
    let alive = true
    void call('system.info').then(
      (s) => {
        if (!alive) return
        setConnected(s.hostConnected)
        setPending(s.offlinePending ?? 0)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [isClient])
  const ok = !isClient || (connected ?? system?.hostConnected ?? true)
  const host = system?.hostName ?? ''
  const text = !isClient
    ? compact
      ? t.common.online
      : t.common.syncPending(0)
    : ok
      ? pending
        ? t.lan.chipPending(host, pending)
        : t.lan.chipHost(host)
      : t.lan.chipOfflineSelling(pending)
  return (
    <span className={cn('inline-flex h-[38px] items-center gap-2 rounded-[19px] px-3.5 text-[13px] font-semibold', ok ? 'bg-success text-success-foreground' : 'bg-warning text-warning-foreground')}>
      <span className={cn('inline-block size-2 rounded-full', ok ? 'bg-[#1BA56B]' : 'bg-[#E5A10C]')} />
      {text}
    </span>
  )
}
