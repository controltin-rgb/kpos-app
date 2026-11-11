import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DashboardDto, DashboardPeriod } from '@shared/api-dashboard'
import { Icon, type IconName } from '@renderer/components/icons'
import { GRADIENTS, type Tone } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { money } from '@renderer/lib/format'
import { useFeatures, useSession } from '@renderer/lib/session'

const d = t.dash
const PERIODS: DashboardPeriod[] = ['today', 'yesterday', 'week', 'month']
const COL = ['#4C8DF6', '#1BA56B', '#F7791E', '#E5A10C', '#E23B76', '#6A47DB']
const BC = ['#4C8DF6', '#1BA56B', '#F7791E', '#6A47DB', '#14A094', '#E23B76', '#E5A10C']
const RANK_BG = ['#FFA43A, #F7791E', '#8B6CF0, #6A47DB', '#4C8DF6, #2F6FE0', '#34C98A, #1BA56B', '#F05A8E, #E23B76']
const n0 = (v: number) => Math.round(v).toLocaleString('en-US')
const kSat = (s: number) => {
  const v = s / 100
  return v >= 10_000 ? `${(v / 1000).toFixed(0)}k` : `${(v / 1000).toFixed(1)}k`
}

const card = 'relative flex flex-col gap-2 overflow-hidden rounded-[20px] border border-border bg-white p-5'
const section = 'flex min-w-0 flex-col rounded-[20px] border border-border bg-white p-[22px]'

function Kpi({ icon, tone, circle, label, value, sub, subColor }: { icon: IconName; tone: Tone; circle: string; label: string; value: string; sub: string; subColor: string }) {
  return (
    <div className={card}>
      <div className="absolute -top-[34px] -right-[34px] size-[110px] rounded-full" style={{ background: circle }} />
      <div className="relative flex size-10 items-center justify-center rounded-xl" style={{ background: GRADIENTS[tone] }}>
        <Icon name={icon} size={20} color="#FFFFFF" />
      </div>
      <div className="relative text-sm text-muted-foreground">{label}</div>
      <div className="relative text-[32px] leading-[1.1] font-bold">{value}</div>
      <div className="relative text-[13px] font-semibold" style={{ color: subColor }}>
        {sub}
      </div>
    </div>
  )
}

function Summary({ icon, tone, circle, title, children }: { icon: IconName; tone: Tone; circle: string; title: string; children: React.ReactNode }) {
  return (
    <div className={card}>
      <div className="absolute -top-10 -right-10 size-[130px] rounded-full" style={{ background: circle }} />
      <div className="relative flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl" style={{ background: GRADIENTS[tone] }}>
          <Icon name={icon} size={20} color="#FFFFFF" />
        </div>
        <div className="text-sm text-muted-foreground">{title}</div>
      </div>
      {children}
    </div>
  )
}

/** docs/design/Dashboard.dc.html (confirmed design) with live data. */
export function DashboardPage() {
  const { user, system } = useSession()
  const features = useFeatures()
  const navigate = useNavigate()
  const [period, setPeriod] = useState<DashboardPeriod>('today')
  const [data, setData] = useState<DashboardDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshes, setRefreshes] = useState(0)
  const [toast, setToast] = useState('')
  const [ch, setCh] = useState(-1)
  const [bar, setBar] = useState(-1)

  const load = useCallback((p: DashboardPeriod) => call('dashboard.summary', { period: p }).then(setData, (err: unknown) => setError(errorMessage(err))), [])
  useEffect(() => {
    void load(period)
  }, [load, period])
  useAppEvent((e) => {
    if (e.type === 'bill.changed' || e.type === 'shift.changed') void load(period)
  })

  const header = (
    <div className="flex flex-wrap items-center gap-3.5">
      <div className="flex flex-[1_1_320px] items-center gap-3.5">
        <div className="flex size-[52px] items-center justify-center rounded-[15px] shadow-[0_8px_16px_rgba(106,71,219,0.3)]" style={{ background: GRADIENTS.violet }}>
          <Icon name="home" size={26} color="#FFFFFF" />
        </div>
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 text-[26px] font-bold">{t.dashboard.title}</h1>
          <div className="text-[13px] text-muted-foreground">{d.subtitle(user?.branchName ?? '')}</div>
        </div>
      </div>
      <div role="group" aria-label={d.periodLabel} className="inline-flex rounded-3xl bg-white p-1 shadow-[0_1px_3px_rgba(40,30,60,0.1)]">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={p === period}
            onClick={() => {
              setPeriod(p)
              setCh(-1)
              setBar(-1)
              setToast('')
            }}
            className="min-h-10 cursor-pointer rounded-[20px] border-0 px-[18px] text-sm"
            style={p === period ? { background: 'linear-gradient(90deg, #6A47DB, #9776F6)', color: '#FFFFFF', fontWeight: 600 } : { background: 'transparent', color: '#2B3040' }}
          >
            {d.periods[p]}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          setRefreshes((n) => n + 1)
          setToast(d.refreshed)
          void load(period)
        }}
        className="flex min-h-12 cursor-pointer items-center gap-2 rounded-3xl border-0 bg-white px-[18px] text-sm shadow-[0_1px_3px_rgba(40,30,60,0.1)]"
      >
        <Icon name="refresh" />
        <span>{refreshes ? d.refreshN(refreshes) : d.refresh}</span>
      </button>
    </div>
  )

  if (!data) return error ? <>{header}<div className="rounded-[14px] bg-danger px-4 py-3 text-sm text-danger-foreground">{error}</div></> : header

  const totalBills = data.channels.reduce((s, c) => s + c.bills, 0)
  let acc = 0
  const stops = data.channels
    .map((c, i) => {
      const pct = totalBills ? (c.bills / totalBills) * 100 : 0
      const a = acc
      acc += pct
      return `${COL[i]} ${a}% ${acc}%`
    })
    .join(', ')
  const deliveries = data.deliveries.grab + data.deliveries.lineman + data.deliveries.shopeefood + data.deliveries.foodpanda
  const maxBar = Math.max(1, ...data.chart.values)
  const chartTotal = data.chart.values.reduce((a, b) => a + b, 0)
  const labelOf = (l: string) => (data.chart.kind === 'week' ? d.weekLabel(l) : l)
  const stockCount = data.stock.lowCount + data.stock.exp3Count + data.stock.exp7Count
  const pctOfSales = data.grossProfitSatang !== null && data.salesSatang > 0 ? Math.round((data.grossProfitSatang * 100) / data.salesSatang) : null

  return (
    <>
      {header}
      {toast && <div className="rounded-[14px] bg-success px-4 py-3 text-sm font-semibold text-success-foreground">{toast}</div>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4">
        <Kpi
          icon="baht"
          tone="blue"
          circle="#E4EEFF"
          label={d.sales}
          value={money(data.salesSatang).replace(/\.\d\d$/, '')}
          sub={data.deltaPct === null ? d.noCompare : `${d.compare[period]} ${data.deltaPct >= 0 ? '+' : ''}${data.deltaPct}%`}
          subColor={data.deltaPct === null ? '#5C6270' : data.deltaPct >= 0 ? '#11724A' : '#A6232B'}
        />
        <Kpi icon="receipt" tone="green" circle="#DDF5E8" label={d.bills} value={d.billsValue(n0(data.bills))} sub={d.voids(data.voids)} subColor="#5C6270" />
        <Kpi icon="trend" tone="orange" circle="#FFE9D2" label={d.avg} value={money(data.avgBillSatang).replace(/\.\d\d$/, '')} sub={d.perBill((data.itemsPerBillX10 / 10).toFixed(1))} subColor="#5C6270" />
        {features.inventory && (
        <Kpi
          icon="tag"
          tone="pink"
          circle="#FDE3EC"
          label={d.gp}
          value={data.grossProfitSatang === null ? '—' : money(data.grossProfitSatang).replace(/\.\d\d$/, '')}
          sub={pctOfSales === null ? (data.grossProfitSatang === null ? d.gpHidden : '—') : d.gpPct(pctOfSales)}
          subColor="#5C6270"
        />
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        {features.inventory && (
        <Summary icon="warning" tone="red" circle="#FDE3E5" title={d.stockAlert}>
          <div className="relative text-[32px] leading-[1.1] font-bold">
            {stockCount} <span className="text-[15px] font-medium text-muted-foreground">{d.items}</span>
          </div>
          <div className="relative flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-xl bg-[#FDE3E5] px-2.5 py-[3px] text-danger-foreground">{d.lowN(data.stock.lowCount)}</span>
            <span className="rounded-xl bg-[#FFEBCC] px-2.5 py-[3px] text-[#7A4A00]">{d.exp3(data.stock.exp3Count)}</span>
            <span className="rounded-xl bg-[#FFEBCC] px-2.5 py-[3px] text-[#7A4A00]">{d.exp7(data.stock.exp7Count)}</span>
          </div>
        </Summary>
        )}
        {system?.deliveryEnabled !== false && (
        <Summary icon="truck" tone="blue" circle="#E4EEFF" title={d.delivery}>
          <div className="relative text-[32px] leading-[1.1] font-bold">
            <span>{deliveries}</span> <span className="text-[15px] font-medium text-muted-foreground">{d.orders}</span>
          </div>
          <div className="relative text-[13px] text-muted-foreground">{d.deliverySub(data.deliveries.grab, data.deliveries.lineman, data.deliveries.shopeefood, data.deliveries.foodpanda)}</div>
        </Summary>
        )}
        {features.drawerShift && (
        <Summary icon="clock" tone="teal" circle="#D9F4F1" title={d.shift}>
          <div className="relative text-[32px] leading-[1.1] font-bold">{data.shift ? money(data.shift.expectedCashSatang).replace(/\.\d\d$/, '') : '—'}</div>
          <div className="relative text-[13px] text-muted-foreground">
            {data.shift ? d.shiftSub(data.shift.openedByName, money(data.shift.openingFloatSatang), money(data.shift.lastOverShortSatang ?? 0)) : d.noShift}
          </div>
        </Summary>
        )}
      </div>

      <div className="flex flex-wrap gap-4">
        <section className={`${section} flex-[1_1_320px] gap-3.5`}>
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            <Icon name="pie" />
            <span>{d.channelsTitle}</span>
          </h2>
          <div className="flex justify-center">
            <div role="img" aria-label={d.donut} className="flex size-[230px] items-center justify-center rounded-full" style={{ background: totalBills ? `conic-gradient(${stops})` : '#EFEBE6' }}>
              <div className="flex size-[150px] flex-col items-center justify-center rounded-full bg-white">
                <span className="text-xs text-muted-foreground">{ch < 0 ? d.total : d.channelNames[data.channels[ch]!.channel]}</span>
                <span className="text-[26px] font-bold">{ch < 0 ? n0(totalBills) : d.billsN(n0(data.channels[ch]!.bills))}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-1.5 text-[13px]">
            {data.channels.map((c, i) => (
              <button
                key={c.channel}
                type="button"
                aria-pressed={ch === i}
                onClick={() => setCh(ch === i ? -1 : i)}
                className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[18px] border-0 px-3 text-[13px]"
                style={{ background: ch === i ? '#EDE9FB' : '#F7F5F2' }}
              >
                <span className="size-2.5 rounded-full" style={{ background: COL[i] }} />
                <span>
                  {d.channelNames[c.channel]} {totalBills ? Math.round((c.bills * 100) / totalBills) : 0}%
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className={`${section} flex-[1.4_1_420px] gap-3.5`}>
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            <Icon name="chart" />
            <span>{d.chartTitle[data.chart.kind]}</span>
          </h2>
          <div className="flex h-[250px] items-end gap-2.5 border-b border-[#E8E4DF]">
            {data.chart.values.map((v, i) => (
              <button
                key={i}
                type="button"
                aria-label={`${labelOf(data.chart.labels[i]!)} ${money(v)}`}
                onClick={() => setBar(bar === i ? -1 : i)}
                className="flex h-full min-w-0 flex-[1_1_0] cursor-pointer flex-col items-center justify-end gap-1 border-0 bg-transparent p-0"
              >
                <span className="text-[11px] text-muted-foreground">{kSat(v)}</span>
                <div className="w-full rounded-t-lg" style={{ height: `${Math.round((v / maxBar) * 100)}%`, background: BC[i % BC.length], opacity: bar < 0 || bar === i ? 1 : 0.35 }} />
              </button>
            ))}
          </div>
          <div className="flex gap-2.5">
            {data.chart.labels.map((l, i) => (
              <span key={i} className="min-w-0 flex-[1_1_0] text-center text-xs text-muted-foreground">
                {labelOf(l)}
              </span>
            ))}
          </div>
          <div className="rounded-xl bg-[#F5F2FE] px-3.5 py-2.5 text-sm font-semibold text-accent-foreground">
            {bar < 0 ? d.barHint(money(chartTotal)) : d.barInfo(labelOf(data.chart.labels[bar]!), money(data.chart.values[bar]!), chartTotal ? Math.round((data.chart.values[bar]! * 100) / chartTotal) : 0)}
          </div>
        </section>
      </div>

      <div className="flex flex-wrap gap-4">
        <section className={`${section} flex-[1_1_320px] gap-3`}>
          <h2 className="m-0 text-base font-semibold">{d.top}</h2>
          {data.top.length === 0 && <span className="text-sm text-muted-foreground">{d.empty}</span>}
          {data.top.map((p, i) => (
            <div key={p.name} className="flex items-center gap-3 text-sm">
              <span className="flex size-[30px] items-center justify-center rounded-[9px] text-[13px] font-bold text-white" style={{ background: `linear-gradient(135deg, ${RANK_BG[i]})` }}>
                {i + 1}
              </span>
              <span className="flex-1">{p.name}</span>
              <span className="text-muted-foreground">
                {n0(p.qty)} {d.units[p.unit]}
              </span>
            </div>
          ))}
        </section>
        {features.inventory && (
        <section className={`${section} flex-[1_1_320px] gap-3.5`}>
          <h2 className="m-0 text-base font-semibold">{d.lowTitle}</h2>
          {data.stock.low.map((l) => {
            const red = l.pct < 25
            return (
              <div key={l.name} className="flex flex-col gap-1.5">
                <div className="flex justify-between text-sm">
                  <span>{l.name}</span>
                  <span className="font-semibold" style={{ color: red ? '#A6232B' : '#7A4A00' }}>
                    {d.remain(l.pct)}
                  </span>
                </div>
                <div className="h-2 rounded bg-border">
                  <div className="h-2 rounded" style={{ width: `${l.pct}%`, background: red ? '#DC3A44' : '#E5A10C' }} />
                </div>
              </div>
            )
          })}
          {data.stock.expiring.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
              {data.stock.expiring.map((e, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span>{d.lot(e.name, e.lotNo)}</span>
                  <span className="font-semibold whitespace-nowrap" style={{ color: e.days <= 3 ? '#A6232B' : '#7A4A00' }}>
                    {d.expIn(e.days)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {data.stock.low.length === 0 && data.stock.expiring.length === 0 && <span className="text-sm text-muted-foreground">{d.empty}</span>}
        </section>
        )}
        <section className={`${section} flex-[1_1_320px] gap-3`}>
          <h2 className="m-0 text-base font-semibold">{d.pendingTitle}</h2>
          {features.inventory && (
          <button type="button" onClick={() => navigate('/stock-count')} className="flex min-h-12 cursor-pointer items-center justify-between border-0 bg-transparent px-1 text-sm">
            <span>{d.approveStock}</span>
            <span className="rounded-xl px-3 py-0.5 font-bold" style={data.pending.counts ? { background: '#FFEBCC', color: '#7A4A00' } : { background: '#EFEBE6', color: '#1F2430' }}>
              {data.pending.counts} {d.items}
            </span>
          </button>
          )}
          <div className="flex min-h-10 items-center justify-between text-sm">
            <span>{d.voidPending}</span>
            <span className="rounded-xl bg-[#EFEBE6] px-3 py-0.5 font-bold">{data.pending.voids}</span>
          </div>
          <div className="flex min-h-10 items-center justify-between text-sm">
            <span>{d.license}</span>
            <span className="font-semibold">{d.licenseDays(data.pending.licenseDaysLeft)}</span>
          </div>
          <div className="flex min-h-10 items-center justify-between text-sm">
            <span>{d.backup}</span>
            <span className="font-semibold">{data.pending.lastBackupAt ? new Date(data.pending.lastBackupAt).toLocaleString('th-TH') : d.noBackup}</span>
          </div>
        </section>
      </div>
    </>
  )
}
