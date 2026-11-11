import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { LicenseStatusDto } from '@shared/api-system'
import { t } from '@renderer/i18n'
import { call } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

const b = t.license.banner
/** trial reminders start this many days before the end (the Dashboard shows the count all along) */
const TRIAL_REMIND_DAYS = 7

/** Sticky notice above every page while the license needs attention (D26, D28). */
export function LicenseBanner() {
  const [s, setS] = useState<LicenseStatusDto | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => void call('license.status').then((x) => alive && setS(x), () => {})
    load()
    const timer = setInterval(load, 10 * 60_000)
    window.addEventListener('kposs:license-changed', load)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('kposs:license-changed', load)
    }
  }, [])

  if (!s) return null
  const days = s.daysLeft ?? 0
  let text: string | null = null
  if (s.state === 'trial' && days <= TRIAL_REMIND_DAYS) text = b.trial(days)
  else if (s.state === 'trial_expired') text = b.trial_expired
  else if (s.state === 'expiring') text = b.expiring(days)
  else if (s.state === 'grace') text = b.grace(days)
  else if (s.state === 'expired') text = b.expired
  if (!text) return null

  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold', s.readOnly ? 'bg-danger text-danger-foreground' : 'bg-warning text-warning-foreground')}>
      <span className="flex-1">{text}</span>
      <Link to="/settings?tab=device" className="inline-flex min-h-11 items-center rounded-full bg-white px-4 text-[13px] font-bold text-inherit no-underline">
        {b.action}
      </Link>
    </div>
  )
}
