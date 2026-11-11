import { useEffect, useState } from 'react'
import type { LicenseRow } from '../../../../scripts/license-types'
import { Segmented } from '@renderer/components/modal'
import { Card, OutlineButton, PageHeader, useToast } from '@renderer/components/ui'
import { api } from '../api'
import { errText, IssueDialog, StatusChip } from '../components'
import { expiryText } from '../format'
import { lm } from '../i18n'
import { useManager } from '../store'

const o = lm.overview

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="relative flex min-w-[180px] flex-[1_1_180px] flex-col gap-1 overflow-hidden rounded-[20px] border border-border bg-white p-5">
      <div className="absolute -top-[34px] -right-[34px] size-[100px] rounded-full" style={{ background: tone }} />
      <span className="relative text-sm text-muted-foreground">{label}</span>
      <span className="relative text-[30px] leading-tight font-bold">{value}</span>
    </div>
  )
}

export function OverviewPage() {
  const toast = useToast()
  const { state, reload } = useManager()
  const [days, setDays] = useState<'30' | '60' | '90'>('30')
  const [rows, setRows] = useState<LicenseRow[]>([])
  const [renew, setRenew] = useState<LicenseRow | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.expiring(Number(days)).then(setRows, (err: unknown) => toast(errText(err), 'error'))
  }, [days, tick, toast])

  const current = state?.licenses.filter((l) => l.current) ?? []
  const count = (...s: string[]) => current.filter((l) => s.includes(l.status)).length

  return (
    <>
      <PageHeader icon="chart" tone="violet" title={o.title} subtitle={o.subtitle} />
      {state && !state.key.found && <div className="rounded-2xl bg-warning px-4 py-3 text-sm text-warning-foreground">{o.noKey}</div>}
      {state && state.key.found && !state.key.trusted && <div className="rounded-2xl bg-danger px-4 py-3 text-sm text-danger-foreground">{o.keyMismatch}</div>}
      <div className="flex flex-wrap gap-[18px]">
        <Stat label={o.statActive} value={count('active')} tone="#DDF5E8" />
        <Stat label={o.statExpiring} value={count('expiring')} tone="#FFF4D6" />
        <Stat label={o.statExpired} value={count('grace', 'expired')} tone="#FFE3E3" />
        <Stat label={o.statCustomers} value={state?.customers.length ?? 0} tone="#EDE9FB" />
      </div>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0 flex-1 text-lg font-bold">{o.listTitle}</h2>
          <div className="w-72">
            <Segmented<'30' | '60' | '90'> label={o.within} value={days} onChange={setDays} options={(['30', '60', '90'] as const).map((d) => ({ value: d, label: o.days(Number(d)) }))} />
          </div>
          <a href="/api/export.csv" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-[#E6E1D9] bg-white px-5 text-[15px] font-semibold text-foreground no-underline">
            {o.exportCsv}
          </a>
        </div>
        {rows.map((r) => (
          <div key={r.licenseId} className="flex min-h-[60px] flex-wrap items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 py-1.5">
            <div className="flex min-w-[200px] flex-1 flex-col">
              <span className="text-[15px] font-semibold">{r.customerName ?? r.licensee}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {r.hardwareId} · {r.plan}
              </span>
            </div>
            <span className="text-sm text-muted-foreground">{expiryText(r.expiresAt)}</span>
            <StatusChip status={r.status} daysLeft={r.daysLeft} />
            <OutlineButton onClick={() => setRenew(r)}>{lm.renew}</OutlineButton>
          </div>
        ))}
        {rows.length === 0 && <span className="py-4 text-center text-sm text-muted-foreground">{o.none}</span>}
      </Card>
      {renew && (
        <IssueDialog
          from={renew}
          onClose={() => setRenew(null)}
          onDone={() => {
            setRenew(null)
            setTick((n) => n + 1)
            void reload()
          }}
        />
      )}
    </>
  )
}
