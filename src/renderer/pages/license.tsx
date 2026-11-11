import { useEffect, useState } from 'react'
import type { LicenseStatusDto } from '@shared/api-system'
import { FEATURE_KEYS } from '@shared/license'
import { Chip, GradientButton, OutlineButton, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'

const l = t.license
const dateOnly = (ms: number) => formatDateTimeShort(ms).slice(0, 8)

/** "หมดอายุ … · เหลือ N วัน" line on the plan card. */
function periodLine(s: LicenseStatusDto): string {
  switch (s.state) {
    case 'trial':
      return l.trialEnds(dateOnly(s.endsAt!), s.daysLeft ?? 0)
    case 'trial_expired':
      return l.expiredOn(dateOnly(s.endsAt!))
    case 'grace':
      return l.graceUntil(dateOnly(s.endsAt!), s.daysLeft ?? 0)
    case 'expired':
      return l.expiredOn(dateOnly(s.expiresAt!))
    default:
      return s.expiresAt === null ? l.perpetual : l.expiresOn(dateOnly(s.expiresAt), s.daysLeft ?? 0)
  }
}

/** License block of the Settings page (docs/design/Settings.dc.html, "show_license"). */
export function LicenseSection() {
  const { can } = useSession()
  const toast = useToast()
  const [s, setS] = useState<LicenseStatusDto | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    call('license.status').then(
      (x) => alive && setS(x),
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])

  if (!s) return null

  async function importFile() {
    setBusy(true)
    try {
      const next = await call('license.import', {})
      if (next) {
        setS(next)
        toast(next.plan ? l.installedPlan(next.plan) : l.installed)
        window.dispatchEvent(new Event('kposs:license-changed'))
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function copyHw() {
    try {
      await navigator.clipboard.writeText(s!.hardwareId)
      toast(l.copied)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const licensed = s.plan !== null
  const bad = s.readOnly

  return (
    <div className="flex flex-col gap-[18px]">
      <h2 className="m-0 text-xl font-bold">{l.title}</h2>
      <div
        className="relative overflow-hidden rounded-[20px] p-[22px] text-white"
        style={{ background: bad ? 'linear-gradient(135deg,#F4616A,#DC3A44)' : 'linear-gradient(135deg,#6A47DB,#9776F6)' }}
      >
        <div className="absolute -top-[50px] -right-10 size-[170px] rounded-full bg-white/15" />
        <div className="relative flex flex-wrap items-center gap-4">
          <div className="flex flex-[1_1_220px] flex-col gap-1">
            <span className="text-[13px] opacity-90">{l.plan}</span>
            <span className="text-[26px] font-bold">{s.plan ?? l.trialPlan}</span>
            <span className="text-[13px] opacity-90">{periodLine(s)}</span>
            {s.licensee && <span className="text-[13px] opacity-90">{l.licensee(s.licensee)}</span>}
          </div>
          <span className="inline-flex h-[34px] items-center rounded-[17px] bg-white/20 px-4 text-sm font-bold">{l.status(l.states[s.state])}</span>
        </div>
      </div>

      {s.problem && <div className="rounded-[14px] bg-danger px-3.5 py-3 text-[13px] text-danger-foreground">{l.problems[s.problem]}</div>}
      {s.clockRollback && <div className="rounded-[14px] bg-warning px-3.5 py-3 text-[13px] text-warning-foreground">{l.clock}</div>}

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-[1_1_260px] flex-col gap-1.5 text-sm font-semibold">
          {l.hardwareId}
          <input
            readOnly
            value={s.hardwareId}
            onFocus={(e) => e.currentTarget.select()}
            className="box-border min-h-11 w-full rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-[#F7F5F2] px-3.5 font-mono text-[15px] tracking-wide text-foreground"
          />
        </label>
        <div className="flex flex-[1_1_200px] flex-col gap-1.5 text-sm font-semibold">
          {l.maxEmployees}
          <div className="flex min-h-11 items-center text-[22px] font-bold">{l.people(s.features.maxEmployees)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          {l.maxClients}: <b>{s.features.maxClients === 0 ? l.hostNo : l.clients(s.features.maxClients)}</b>
        </span>
        <span>
          {l.maxMembers}: <b>{l.members(s.features.maxMembers)}</b>
        </span>
        {licensed && s.installedAt && <span className="text-muted-foreground">{l.installedBy(s.installedByName ?? '—', formatDateTimeShort(s.installedAt))}</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">{l.featuresTitle}</span>
        <div className="flex flex-wrap gap-2">
          {FEATURE_KEYS.map((k) => (
            <Chip key={k} bg={s.features[k] ? '#DDF5E8' : '#EFEBE6'} fg={s.features[k] ? '#11724A' : '#5C6270'}>
              {s.features[k] ? '✓' : '✕'} {l.features[k]}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {can('license:manage') && (
          <GradientButton size="lg" disabled={busy} onClick={() => void importFile()}>
            {busy ? l.importing : l.import}
          </GradientButton>
        )}
        <OutlineButton className="min-h-12" onClick={() => void copyHw()}>
          {l.copyHw}
        </OutlineButton>
      </div>
      {!can('license:manage') && <span className="text-xs text-muted-foreground">{l.noPermission}</span>}
      <span className="text-xs text-[#7A8090]">{l.note}</span>
    </div>
  )
}
