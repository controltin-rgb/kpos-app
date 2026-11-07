import { useCallback, useEffect, useState } from 'react'
import type { AuditVerifyResult } from '@shared/api'
import { AUDIT_TYPES, type AuditEntryDto, type AuditOverviewDto, type AuditRisk, type AuditType } from '@shared/api-system'
import { Card, PageHeader, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { panelClass } from '@renderer/lib/forms'
import { cn } from '@renderer/lib/utils'

const a = t.audit
const PER_PAGE = 7
const RISK_COLOR: Record<AuditRisk, [string, string]> = { high: ['#FFE3E3', '#A6232B'], medium: ['#FFF4D6', '#7A5200'], low: ['#DDF5E8', '#11724A'] }

/** Fields worth showing in the one-line summary, in priority order. */
const SUMMARY_KEYS = ['billNo', 'invoiceNo', 'wasteNo', 'shiftNo', 'countNo', 'poNo', 'receiptNo', 'expenseNo', 'name', 'username', 'displayName', 'fileName', 'restoredFrom', 'channel', 'kind', 'error']

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return a.none
  if (typeof v === 'number' && /satang$/i.test(key)) return money(v)
  if (typeof v === 'number' && /At$/.test(key) && v > 1e12) return formatDateTimeShort(v)
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (Array.isArray(v)) return v.length > 3 ? `${v.slice(0, 3).map(String).join(', ')} … (+${v.length - 3})` : v.map(String).join(', ')
  if (isRecord(v)) return JSON.stringify(v)
  return String(v)
}

/** before/after JSON → "key: value" lines for the detail panel. */
function lines(v: unknown): string[] {
  if (v === null || v === undefined) return [a.none]
  if (!isRecord(v)) return [String(v)]
  const out = Object.entries(v).map(([k, x]) => `${k}: ${fmtValue(k, x)}`)
  return out.length ? out : [a.none]
}

function describe(e: AuditEntryDto): string {
  const label = a.actions[e.action] ?? e.action
  const src = isRecord(e.after) ? e.after : isRecord(e.before) ? e.before : null
  const key = src ? SUMMARY_KEYS.find((k) => src[k] !== undefined && src[k] !== null) : undefined
  let fact = key && src ? fmtValue(key, src[key]) : ''
  if (!fact && e.entity === 'settings' && e.entityId) fact = e.entityId
  if (!fact && e.action === 'auth.permission_denied' && isRecord(e.after) && typeof e.after['channel'] === 'string') fact = String(e.after['channel'])
  return [label, fact].filter(Boolean).join(' · ')
}

function StatCard({ label, value, sub, circle }: { label: string; value: string; sub: string; circle: string }) {
  return (
    <div className="relative flex min-w-0 flex-[1_1_220px] flex-col gap-0.5 overflow-hidden rounded-[20px] bg-white px-5 py-[18px] shadow-[0_1px_3px_rgba(40,30,60,0.08)]">
      <div className="absolute -top-[30px] -right-6 size-[100px] rounded-full" style={{ background: circle }} />
      <span className="relative text-[13px] text-muted-foreground">{label}</span>
      <span className="relative text-[26px] font-bold">{value}</span>
      <span className="relative text-xs text-[#7A8090]">{sub}</span>
    </div>
  )
}

/** docs/design/Audit.dc.html (draft) — append-only, hash-chained audit log viewer. */
export function AuditPage() {
  const toast = useToast()
  const [ov, setOv] = useState<AuditOverviewDto | null>(null)
  const [data, setData] = useState<{ items: AuditEntryDto[]; total: number }>({ items: [], total: 0 })
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [userId, setUserId] = useState<string>('all')
  const [type, setType] = useState<AuditType | 'all'>('all')
  const [risk, setRisk] = useState<AuditRisk | 'all'>('all')
  const [page, setPage] = useState(1)
  const [selId, setSelId] = useState<string | null>(null)
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null)
  const [verifying, setVerifying] = useState(false)

  // search as you type, without a call per keystroke
  useEffect(() => {
    const h = setTimeout(() => (setQuery(q.trim()), setPage(1)), 300)
    return () => clearTimeout(h)
  }, [q])

  const load = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([
        call('audit.overview'),
        call('audit.list', { page, pageSize: PER_PAGE, userId: userId === 'all' ? null : userId, type, risk, q: query }),
      ])
      setOv(o)
      setData(l)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [page, userId, type, risk, query, toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [load])

  const pages = Math.max(1, Math.ceil(data.total / PER_PAGE))
  const cur = data.items.find((e) => e.id === selId) ?? data.items[0] ?? null

  async function runVerify() {
    setVerifying(true)
    try {
      setVerify(await call('audit.verify'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setVerifying(false)
    }
  }

  const verifyOk = verify ? verify.ok && verify.anchor?.ok !== false : true

  return (
    <>
      <PageHeader icon="shield" tone="violet" title={a.title} subtitle={a.subtitle} />
      <div className="flex flex-wrap gap-3.5">
        <StatCard label={a.cards.today} value={(ov?.today ?? 0).toLocaleString('th-TH')} sub={a.cards.todaySub} circle="#EDE9FB" />
        <StatCard label={a.cards.high} value={(ov?.high7d ?? 0).toLocaleString('th-TH')} sub={a.cards.highSub} circle="#FFE3E3" />
        <StatCard label={a.cards.users} value={(ov?.activeUsersToday ?? 0).toLocaleString('th-TH')} sub={a.cards.usersSub} circle="#E3EEFE" />
        <StatCard label={a.cards.total} value={(ov?.total ?? 0).toLocaleString('th-TH')} sub={a.cards.totalSub} circle="#DDF5E8" />
      </div>

      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_600px] flex-col gap-3">
          <div className="flex flex-wrap gap-2.5">
            <TextInput placeholder={a.search} aria-label={a.search} value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-[2_1_200px]" />
            <SelectInput aria-label={a.userLabel} value={userId} onChange={(e) => (setUserId(e.target.value), setPage(1))} className="min-w-0 flex-[1_1_130px]">
              <option value="all">{a.allUsers}</option>
              {ov?.users.map((u) => (
                <option key={u.id ?? 'system'} value={u.id ?? 'system'}>
                  {u.id ? u.name : a.system}
                </option>
              ))}
            </SelectInput>
            <SelectInput aria-label={a.typeLabel} value={type} onChange={(e) => (setType(e.target.value as AuditType | 'all'), setPage(1))} className="min-w-0 flex-[1_1_140px]">
              <option value="all">{a.allTypes}</option>
              {AUDIT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {a.types[x]}
                </option>
              ))}
            </SelectInput>
            <SelectInput aria-label={a.riskLabel} value={risk} onChange={(e) => (setRisk(e.target.value as AuditRisk | 'all'), setPage(1))} className="min-w-0 flex-[1_1_130px]">
              <option value="all">{a.allRisks}</option>
              {(['high', 'medium', 'low'] as const).map((x) => (
                <option key={x} value={x}>
                  {a.risks[x]}
                </option>
              ))}
            </SelectInput>
          </div>

          {data.items.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelId(e.id)}
              className={cn('box-border flex min-h-[60px] w-full cursor-pointer items-center gap-3 rounded-2xl border-0 px-3 py-1.5 text-left font-[inherit]', cur?.id === e.id ? 'bg-accent' : 'bg-[#F7F5F2]')}
            >
              <span className="flex-[0_0_96px] text-xs text-muted-foreground">{formatDateTimeShort(e.createdAt).replace(/\/\d{2} /, ' ')}</span>
              <span className="flex-[0_0_72px] truncate text-sm font-semibold">{e.userName ?? a.system}</span>
              <span className="flex min-w-0 flex-[1_1_0] flex-col">
                <span className="text-[13px] font-bold text-accent-foreground">{e.permission ?? e.action}</span>
                <span className="truncate text-[13px] text-foreground">{describe(e)}</span>
              </span>
              <span className="shrink-0">
                <span className="inline-flex h-7 items-center rounded-[14px] px-3 text-xs font-bold" style={{ background: RISK_COLOR[e.risk][0], color: RISK_COLOR[e.risk][1] }}>
                  {a.riskShort[e.risk]}
                </span>
              </span>
            </button>
          ))}
          {data.items.length === 0 && <span className="text-sm text-muted-foreground">{a.empty}</span>}

          <div className="flex items-center justify-between gap-2.5">
            <span className="text-[13px] text-muted-foreground">{a.footer(data.total, Math.min(page, pages), pages)}</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="min-h-11 min-w-11 cursor-pointer rounded-full border-0 bg-[#F7F5F2] px-4 text-sm font-bold disabled:cursor-not-allowed disabled:text-[#A9A59E]">
                {a.prev}
              </button>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
                className="min-h-11 min-w-11 cursor-pointer rounded-full border-0 bg-accent px-4 text-sm font-bold text-accent-foreground disabled:cursor-not-allowed disabled:bg-[#F0EDE8] disabled:text-[#A9A59E]"
              >
                {a.next}
              </button>
            </div>
          </div>
        </Card>

        <aside className="box-border flex max-w-full flex-[0_0_400px] flex-col gap-[18px]">
          <div className={cn(panelClass, 'gap-2.5')}>
            <h2 className="m-0 text-xl font-bold">{a.detailTitle}</h2>
            {cur ? (
              <>
                <span className="text-[13px] font-bold text-accent-foreground">{cur.permission ?? cur.action}</span>
                <span className="text-[15px] font-semibold">{describe(cur)}</span>
                <span className="text-xs text-muted-foreground">
                  {[formatDateTimeShort(cur.createdAt), cur.userName ?? a.system, cur.deviceName, `#${cur.seq}`].filter(Boolean).join(' · ')}
                </span>
                {cur.reason && <span className="text-[13px]">{a.reason(cur.reason)}</span>}
                <div className="flex gap-2.5">
                  <div className="flex min-w-0 flex-1 flex-col rounded-[14px] bg-danger px-3 py-2.5">
                    <span className="text-xs font-bold text-danger-foreground">{a.before}</span>
                    {lines(cur.before).map((l, i) => (
                      <span key={i} className="text-sm break-words">
                        {l}
                      </span>
                    ))}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col rounded-[14px] bg-success px-3 py-2.5">
                    <span className="text-xs font-bold text-success-foreground">{a.after}</span>
                    {lines(cur.after).map((l, i) => (
                      <span key={i} className="text-sm break-words">
                        {l}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">{a.empty}</span>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-[22px] px-[22px] py-5" style={{ background: 'linear-gradient(135deg,#EDE9FB,#E3EEFE)' }}>
            <h2 className="m-0 text-lg font-bold text-[#3A2A8C]">{a.integrityTitle}</h2>
            <span className="text-[13px] text-[#3F4660]">{a.integrityDesc}</span>
            <button
              type="button"
              disabled={verifying}
              onClick={() => void runVerify()}
              className="min-h-12 cursor-pointer rounded-3xl border-0 font-[inherit] text-[15px] font-bold text-white disabled:opacity-60"
              style={{ background: 'linear-gradient(90deg,#6A47DB,#9776F6)' }}
            >
              {verifying ? a.verifying : a.verify}
            </button>
            {verify && (
              <span className={cn('flex flex-col gap-1 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold', verifyOk ? 'bg-success text-success-foreground' : 'bg-danger text-danger-foreground')}>
                <span>{verify.ok ? a.verifyOk(verify.count) : a.verifyBroken('brokenAtSeq' in verify ? verify.brokenAtSeq : undefined)}</span>
                {verify.anchor && <span>{verify.anchor.ok ? a.anchorOk(verify.anchor.seq, formatDateTimeShort(verify.anchor.at)) : a.anchorBroken(verify.anchor.seq, formatDateTimeShort(verify.anchor.at))}</span>}
              </span>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
