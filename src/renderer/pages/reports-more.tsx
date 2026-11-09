import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ExpenseDto } from '@shared/api-expenses'
import type { ExpenseReportDto, SalesSummaryDto } from '@shared/api-reports'
import type { ExpiringLotDto } from '@shared/api-stock'
import { Card, Chip, OutlineButton, PageHeader, Pagination, SelectInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money, qty } from '@renderer/lib/format'
import { bangkokToday, currentMonthKey, monthRange, recentMonths } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const m = t.reportsMore
const DAY = 86_400_000
const BKK = 7 * 3_600_000
const dayStart = (ms: number) => Math.floor((ms + BKK) / DAY) * DAY - BKK
/** "05/11/69" */
const dateShort = (ms: number) => formatDateTimeShort(ms).slice(0, 8)
const pct = (part: number, whole: number) => (whole > 0 ? `${((part * 100) / whole).toFixed(1)}%` : '—')

type ExportReport = 'sales_summary' | 'expenses' | 'expiry'

function MonthBar({ month, onChange, children }: { month: string; onChange: (key: string) => void; children?: ReactNode }) {
  const [months] = useState(() => recentMonths(Date.now()))
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <SelectInput aria-label={m.month} className="w-60" value={month} onChange={(e) => onChange(e.target.value)}>
        {months.map((x) => (
          <option key={x.key} value={x.key}>
            {x.label}
          </option>
        ))}
      </SelectInput>
      <div className="flex-1" />
      {children}
    </div>
  )
}

function CsvButton({ report, range }: { report: ExportReport; range: { from: number; to: number } }) {
  const { can } = useSession()
  const toast = useToast()
  if (!can('reports:export')) return null
  return (
    <OutlineButton
      className="min-h-11"
      onClick={() =>
        void call('reports.export', { report, ...range }).then(
          (path) => path && toast(m.exported(path)),
          (err: unknown) => toast(errorMessage(err), 'error'),
        )
      }
    >
      {m.export}
    </OutlineButton>
  )
}

function Kpi({ label, value, sub, tone = '#EDE9FB' }: { label: string; value: string; sub?: string | undefined; tone?: string }) {
  return (
    <div className="relative flex min-w-[180px] flex-[1_1_180px] flex-col gap-1 overflow-hidden rounded-[20px] border border-border bg-white p-5">
      <div className="absolute -top-[34px] -right-[34px] size-[100px] rounded-full" style={{ background: tone }} />
      <span className="relative text-sm text-muted-foreground">{label}</span>
      <span className="relative text-[26px] leading-tight font-bold">{value}</span>
      {sub && <span className="relative text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** Daily column chart in the style of the sales report (one bar per day of the month). */
function DayBars({ days, color = 'linear-gradient(180deg,#9776F6,#6A47DB)' }: { days: { start: number; totalSatang: number; count: number }[]; color?: string }) {
  const max = Math.max(1, ...days.map((d) => d.totalSatang))
  if (!days.some((d) => d.totalSatang)) return <span className="text-sm text-muted-foreground">{m.noData}</span>
  return (
    <div className="flex h-[190px] items-end gap-[3px] pb-1">
      {days.map((d) => (
        <div key={d.start} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${dateShort(d.start)} · ${money(d.totalSatang)} · ${d.count}`}>
          <div className="w-full rounded-t-md" style={{ height: `${d.totalSatang ? Math.max(3, (d.totalSatang / max) * 150) : 0}px`, background: color }} />
          <span className="text-[10px] text-muted-foreground">{new Date(d.start + BKK).getUTCDate()}</span>
        </div>
      ))}
    </div>
  )
}

/** Horizontal share bars (payment methods, expense categories, sources). */
function ShareRows({ rows, total }: { rows: { key: string; label: string; value: number; sub?: string }[]; total: number }) {
  if (!rows.length) return <span className="text-sm text-muted-foreground">{m.noData}</span>
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="flex-1 truncate font-semibold">{r.label}</span>
            {r.sub && <span className="text-xs text-muted-foreground">{r.sub}</span>}
            <span className="w-12 text-right text-xs text-muted-foreground">{pct(r.value, total)}</span>
            <span className="w-24 text-right font-semibold">{money(r.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[#F3F0EC]">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#6A47DB,#9776F6)]" style={{ width: `${total > 0 ? Math.max(1, (r.value * 100) / total) : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sales summary (daily rows of one month)
// ---------------------------------------------------------------------------

export function SalesSummaryPage() {
  const toast = useToast()
  const [month, setMonth] = useState(() => currentMonthKey(Date.now()))
  const range = useMemo(() => monthRange(month), [month])
  const [r, setR] = useState<SalesSummaryDto | null>(null)
  useEffect(() => {
    void call('reports.salesSummary', range).then(setR, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [range, toast])

  const [today] = useState(() => bangkokToday(Date.now()))
  const days = r?.days.filter((d) => d.start <= today) ?? []
  const sellingDays = days.filter((d) => d.billCount > 0).length
  const tot = r?.total

  return (
    <>
      <PageHeader icon="chart" tone="violet" title={m.salesTitle} subtitle={m.salesSubtitle} />
      <MonthBar month={month} onChange={setMonth}>
        <CsvButton report="sales_summary" range={range} />
      </MonthBar>
      {r && tot && (
        <>
          <div className="flex flex-wrap gap-[18px]">
            <Kpi label={m.kpiSales} value={money(tot.totalSatang)} sub={sellingDays ? m.perDay(money(Math.round(tot.totalSatang / sellingDays))) : undefined} />
            <Kpi label={m.kpiBills} value={tot.billCount.toLocaleString('en-US')} sub={tot.billCount ? m.avg(money(Math.round(tot.totalSatang / tot.billCount))) : undefined} tone="#DDF5E8" />
            <Kpi label={m.kpiDiscount} value={money(tot.discountSatang)} sub={m.gross(money(tot.grossSatang))} tone="#FFF4D6" />
            <Kpi label={m.kpiVat} value={money(tot.vatSatang)} sub={m.beforeVat(money(tot.netSatang))} tone="#E3EEFE" />
            <Kpi label={m.kpiVoid} value={money(tot.refundSatang)} sub={m.voidSub(tot.voidCount, tot.refundCount)} tone="#FFE3E3" />
          </div>

          <div className="flex flex-wrap items-start gap-[18px]">
            <Card className="flex min-w-0 flex-[1.6_1_520px] flex-col gap-3">
              <h2 className="m-0 text-lg font-bold">{m.byDay}</h2>
              <DayBars days={r.days.map((d) => ({ start: d.start, totalSatang: d.totalSatang, count: d.billCount }))} />
            </Card>
            <Card className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
              <h2 className="m-0 text-lg font-bold">{m.byMethod}</h2>
              <ShareRows rows={r.methodKeys.map((k) => ({ key: k, label: t.methods[k as keyof typeof t.methods] ?? k, value: tot.methods[k] ?? 0 }))} total={r.methodKeys.reduce((s, k) => s + (tot.methods[k] ?? 0), 0)} />
              {tot.commissionSatang > 0 && <span className="text-xs text-muted-foreground">{m.commission(money(tot.commissionSatang))}</span>}
            </Card>
          </div>

          <Card className="flex flex-col gap-2">
            <h2 className="m-0 text-lg font-bold">{m.table}</h2>
            <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
              <span className="flex-[1.1_1_0]">{m.colDate}</span>
              <span className="flex-[0.6_1_0] text-right">{m.colBills}</span>
              <span className="flex-[1_1_0] text-right">{m.colGross}</span>
              <span className="flex-[1_1_0] text-right">{m.colDiscount}</span>
              <span className="flex-[1_1_0] text-right">{m.colSales}</span>
              <span className="flex-[1_1_0] text-right">{m.colVat}</span>
              <span className="flex-[0.8_1_0] text-right">{m.colVoid}</span>
            </div>
            {days.map((d) => (
              <div key={d.start} className={cn('flex min-h-11 items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 text-sm', !d.billCount && !d.voidCount && !d.refundCount && 'opacity-50')}>
                <span className="flex-[1.1_1_0] font-semibold">{dateShort(d.start)}</span>
                <span className="flex-[0.6_1_0] text-right">{d.billCount}</span>
                <span className="flex-[1_1_0] text-right text-muted-foreground">{money(d.grossSatang)}</span>
                <span className="flex-[1_1_0] text-right text-muted-foreground">{d.discountSatang ? `-${money(d.discountSatang)}` : '—'}</span>
                <span className="flex-[1_1_0] text-right font-semibold">{money(d.totalSatang)}</span>
                <span className="flex-[1_1_0] text-right text-muted-foreground">{money(d.vatSatang)}</span>
                <span className={cn('flex-[0.8_1_0] text-right', (d.voidCount || d.refundCount) && 'text-danger-foreground')}>{d.voidCount || d.refundCount ? `${d.voidCount}/${d.refundCount}` : '—'}</span>
              </div>
            ))}
            {days.length === 0 && <span className="text-sm text-muted-foreground">{m.noData}</span>}
            <div className="flex min-h-11 items-center gap-3 rounded-2xl bg-[#EDE9FB] px-3 text-sm font-bold text-accent-foreground">
              <span className="flex-[1.1_1_0]">{m.total}</span>
              <span className="flex-[0.6_1_0] text-right">{tot.billCount}</span>
              <span className="flex-[1_1_0] text-right">{money(tot.grossSatang)}</span>
              <span className="flex-[1_1_0] text-right">{tot.discountSatang ? `-${money(tot.discountSatang)}` : '—'}</span>
              <span className="flex-[1_1_0] text-right">{money(tot.totalSatang)}</span>
              <span className="flex-[1_1_0] text-right">{money(tot.vatSatang)}</span>
              <span className="flex-[0.8_1_0] text-right">{`${tot.voidCount}/${tot.refundCount}`}</span>
            </div>
          </Card>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Expense report
// ---------------------------------------------------------------------------

export function ExpenseReportPage() {
  const toast = useToast()
  const [month, setMonth] = useState(() => currentMonthKey(Date.now()))
  const range = useMemo(() => monthRange(month), [month])
  const [r, setR] = useState<ExpenseReportDto | null>(null)
  const [page, setPage] = useState(1)
  const [list, setList] = useState<{ items: ExpenseDto[]; total: number } | null>(null)

  useEffect(() => {
    void call('reports.expenses', range).then(setR, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [range, toast])
  useEffect(() => {
    void call('expenses.list', { ...range, page }).then(setList, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [range, page, toast])

  const sources = t.expenses.sources
  return (
    <>
      <PageHeader icon="wallet" tone="teal" title={m.expTitle} subtitle={m.expSubtitle} />
      <MonthBar
        month={month}
        onChange={(k) => {
          setMonth(k)
          setPage(1)
        }}
      >
        <CsvButton report="expenses" range={range} />
      </MonthBar>
      {r && (
        <>
          <div className="flex flex-wrap gap-[18px]">
            <Kpi label={m.kpiExpense} value={money(r.totalSatang)} sub={m.items(r.count)} tone="#D9F4F1" />
            <Kpi label={m.kpiInputVat} value={money(r.inputVatSatang)} tone="#E3EEFE" />
            {r.salesSatang !== null && (
              <>
                <Kpi label={m.kpiSalesMonth} value={money(r.salesSatang)} sub={m.ratio(pct(r.totalSatang, r.salesSatang))} tone="#DDF5E8" />
                <Kpi label={m.kpiAfter} value={money(r.salesSatang - r.totalSatang)} sub={m.afterHint} tone="#FFF4D6" />
              </>
            )}
          </div>

          <div className="flex flex-wrap items-start gap-[18px]">
            <Card className="flex min-w-0 flex-[1.2_1_420px] flex-col gap-3">
              <h2 className="m-0 text-lg font-bold">{m.byCategory}</h2>
              <ShareRows rows={r.categories.map((c) => ({ key: c.categoryId, label: c.name, value: c.totalSatang, sub: m.items(c.count) }))} total={r.totalSatang} />
            </Card>
            <Card className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
              <h2 className="m-0 text-lg font-bold">{m.bySource}</h2>
              <ShareRows
                rows={(Object.keys(sources) as (keyof typeof sources)[]).filter((k) => r.bySource[k] > 0).map((k) => ({ key: k, label: sources[k], value: r.bySource[k] }))}
                total={r.totalSatang}
              />
            </Card>
          </div>

          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{m.expByDay}</h2>
            <DayBars days={r.days} color="linear-gradient(180deg,#2CC4B8,#14A094)" />
          </Card>
        </>
      )}

      {list && (
        <Card className="flex flex-col gap-2">
          <h2 className="m-0 text-lg font-bold">{m.list}</h2>
          {list.items.map((e) => (
            <div key={e.id} className={cn('flex min-h-[56px] flex-wrap items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 py-1.5', e.voided && 'opacity-55')}>
              <div className="flex min-w-[200px] flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold">{e.description ?? e.categoryName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {e.expenseNo} · {formatDateTimeShort(e.spentAt)} · {e.categoryName} · {sources[e.source]}
                  {e.vendor ? ` · ${e.vendor}` : ''}
                </span>
              </div>
              {e.voided && (
                <Chip bg="#FFE3E3" fg="#A6232B">
                  {m.voided}
                </Chip>
              )}
              <span className={cn('w-28 text-right font-semibold', e.voided && 'line-through')}>{money(e.amountSatang)}</span>
            </div>
          ))}
          {list.items.length === 0 && <span className="text-sm text-muted-foreground">{m.noData}</span>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">{t.crud.showing(list.items.length, list.total)}</span>
            <Pagination page={page} pageSize={7} total={list.total} onPage={setPage} />
          </div>
        </Card>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Near-expiry ingredients
// ---------------------------------------------------------------------------

const WITHIN = [3, 7, 14, 30, 60] as const

export function ExpiryReportPage() {
  const { can } = useSession()
  const toast = useToast()
  const navigate = useNavigate()
  const [within, setWithin] = useState<number>(7)
  const [lots, setLots] = useState<ExpiringLotDto[] | null>(null)
  useEffect(() => {
    void call('waste.expiring', { withinDays: within }).then(setLots, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [within, toast])

  const [now] = useState(() => Date.now())
  const today = bangkokToday(now)
  const rows = (lots ?? []).map((l) => ({ ...l, days: Math.round((dayStart(l.expiresAt) - today) / DAY) }))
  const expired = rows.filter((l) => l.days <= 0)
  const soon = rows.filter((l) => l.days > 0)
  const value = (xs: typeof rows) => xs.reduce((s, l) => s + l.valueSatang, 0)

  return (
    <>
      <PageHeader icon="warning" tone="red" title={m.expiryTitle} subtitle={m.expirySubtitle} />
      <div className="flex flex-wrap items-center gap-2.5">
        <SelectInput aria-label={m.within} className="w-60" value={within} onChange={(e) => setWithin(Number(e.target.value))}>
          {WITHIN.map((d) => (
            <option key={d} value={d}>
              {m.withinDays(d)}
            </option>
          ))}
        </SelectInput>
        <div className="flex-1" />
        {can('inventory:view') && (
          <OutlineButton className="min-h-11" onClick={() => navigate('/waste')}>
            {m.toWaste}
          </OutlineButton>
        )}
        <CsvButton report="expiry" range={{ from: now, to: now + within * DAY }} />
      </div>
      {lots && (
        <>
          <div className="flex flex-wrap gap-[18px]">
            <Kpi label={m.kpiExpired} value={money(value(expired))} sub={m.lots(expired.length)} tone="#FFE3E3" />
            <Kpi label={m.kpiSoon} value={money(value(soon))} sub={m.lots(soon.length)} tone="#FFF4D6" />
            <Kpi label={m.kpiValue} value={money(value(rows))} sub={m.lots(rows.length)} />
          </div>
          <Card className="flex flex-col gap-2">
            <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
              <span className="flex-[2_1_0]">{m.colIngredient}</span>
              <span className="flex-[1_1_0]">{m.colLot}</span>
              <span className="flex-[1_1_0] text-right">{m.colLeft}</span>
              <span className="flex-[1_1_0] text-right">{m.colValue}</span>
              <span className="flex-[1_1_0] text-right">{m.colExpires}</span>
              <span className="flex-[0_0_150px]">{m.colStatus}</span>
            </div>
            {rows.map((l) => (
              <div key={l.lotId} className="flex min-h-[52px] items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 text-sm">
                <span className="flex-[2_1_0] truncate text-[15px] font-semibold">{l.ingredientName}</span>
                <span className="flex-[1_1_0] truncate font-mono text-xs text-muted-foreground">{l.lotNo ?? '—'}</span>
                <span className="flex-[1_1_0] text-right">
                  {qty(l.qtyRemainingMilli)} {t.units[l.baseUnit]}
                </span>
                <span className="flex-[1_1_0] text-right font-semibold">{money(l.valueSatang)}</span>
                <span className="flex-[1_1_0] text-right text-muted-foreground">{dateShort(l.expiresAt)}</span>
                <span className="flex-[0_0_150px]">
                  {l.days <= 0 ? (
                    <Chip bg="#FFE3E3" fg="#A6232B">
                      {m.expired(-l.days)}
                    </Chip>
                  ) : (
                    <Chip bg={l.days <= 3 ? '#FFF4D6' : '#EDE9FB'} fg={l.days <= 3 ? '#7A5200' : '#4B2FB8'}>
                      {m.daysLeft(l.days)}
                    </Chip>
                  )}
                </span>
              </div>
            ))}
            {rows.length === 0 && <span className="py-4 text-center text-sm text-muted-foreground">{m.none}</span>}
            <span className="text-xs text-muted-foreground">{m.hint}</span>
          </Card>
        </>
      )}
    </>
  )
}
