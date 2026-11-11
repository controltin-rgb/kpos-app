import { useMemo, useState } from 'react'
import type { LicenseRow, LicenseStatus } from '../../../../scripts/license-types'
import { resolveFeatures } from '../../../../src/shared/license'
import { Card, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { cn } from '@renderer/lib/utils'
import { downloadLicense } from '../api'
import { errText, IssueDialog, StatusChip, VoidDialog } from '../components'
import { date, expiryText } from '../format'
import { lm } from '../i18n'
import { useManager } from '../store'

const r = lm.registry
const PAGE = 7

export function RegistryPage() {
  const toast = useToast()
  const { state, reload } = useManager()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | LicenseStatus>('all')
  const [plan, setPlan] = useState('all')
  const [page, setPage] = useState(1)
  const [renew, setRenew] = useState<LicenseRow | null>(null)
  const [voiding, setVoiding] = useState<LicenseRow | null>(null)

  const all = useMemo(() => state?.licenses ?? [], [state])
  const plans = useMemo(() => [...new Set(all.map((l) => l.plan))].sort(), [all])
  const rows = all.filter((l) => (status === 'all' || l.status === status) && (plan === 'all' || l.plan === plan) && (!q.trim() || `${l.customerName ?? ''} ${l.licensee} ${l.hardwareId}`.toLowerCase().includes(q.trim().toLowerCase())))
  const shown = rows.slice((page - 1) * PAGE, page * PAGE)
  const done = () => {
    setRenew(null)
    setVoiding(null)
    void reload()
  }

  return (
    <>
      <PageHeader icon="receipt" tone="blue" title={r.title} subtitle={r.subtitle} />
      <Card className="flex flex-col gap-3.5">
        <div className="flex flex-wrap gap-2.5">
          <TextInput
            type="search"
            aria-label={r.search}
            placeholder={r.search}
            className="flex-[2_1_220px]"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
          <SelectInput
            aria-label={r.allStatus}
            className="flex-[1_1_150px]"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status)
              setPage(1)
            }}
          >
            <option value="all">{r.allStatus}</option>
            {(Object.keys(lm.status) as LicenseStatus[]).map((s) => (
              <option key={s} value={s}>
                {lm.status[s]}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            aria-label={r.allPlans}
            className="flex-[1_1_150px]"
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value)
              setPage(1)
            }}
          >
            <option value="all">{r.allPlans}</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectInput>
        </div>
        {shown.map((l) => (
          <div key={l.licenseId} className={cn('flex min-h-[64px] flex-wrap items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 py-2', !l.current && 'opacity-70')}>
            <div className="flex min-w-[220px] flex-1 flex-col">
              <span className="text-[15px] font-semibold">{l.customerName ?? l.licensee}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {l.hardwareId} · {l.plan} · {r.issued} {date(l.issuedAt)}
              </span>
              <span className="text-xs text-muted-foreground">{lm.features.text(resolveFeatures(l.features))}</span>
              {l.statusReason && <span className="text-xs text-muted-foreground">{l.statusReason}</span>}
            </div>
            <span className="w-24 text-sm text-muted-foreground">{expiryText(l.expiresAt)}</span>
            <StatusChip status={l.status} daysLeft={l.daysLeft} />
            <div className="flex gap-1.5">
              <OutlineButton className="px-3.5" onClick={() => void downloadLicense(l.licenseId).catch((err: unknown) => toast(errText(err), 'error'))}>
                {lm.download}
              </OutlineButton>
              {l.current && <OutlineButton className="px-3.5" onClick={() => setRenew(l)}>{lm.renew}</OutlineButton>}
              {l.current && <OutlineButton className="px-3.5 text-danger-foreground" onClick={() => setVoiding(l)}>{lm.voidAction}</OutlineButton>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <span className="py-6 text-center text-sm text-muted-foreground">{lm.noData}</span>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">{r.showing(shown.length, rows.length)}</span>
          <Pagination page={page} pageSize={PAGE} total={rows.length} onPage={setPage} />
        </div>
        <span className="text-xs text-muted-foreground">{lm.offlineNote}</span>
      </Card>
      {renew && <IssueDialog from={renew} onClose={() => setRenew(null)} onDone={done} />}
      {voiding && <VoidDialog license={voiding} onClose={() => setVoiding(null)} onDone={done} />}
    </>
  )
}
