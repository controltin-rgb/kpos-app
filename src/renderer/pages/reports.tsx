import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ProfitReportDto, SalesReportDto, TaxInvoiceDto, ZListItemDto } from '@shared/api-reports'
import type { BillDetailDto } from '@shared/api-sales'
import { isValidBranchNo, isValidThaiTaxId } from '@shared/tax-id'
import { Modal, Segmented } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, OutlineButton, PageHeader, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { periodFrom, rowClass } from '@renderer/lib/forms'
import { useFeatures, useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'
import { ReasonDialog } from './expenses'

const r = t.reports
type Period = 'today' | 'week' | 'month'
type ExportKind = keyof typeof r.exportWhat

const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(1)}%`)

function PeriodBar({ period, onChange, children }: { period: Period; onChange: (p: Period) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="min-w-[300px] flex-[1_1_300px]">
        <Segmented label={r.periods.today} value={period} onChange={onChange} options={(Object.keys(r.periods) as Period[]).map((k) => ({ value: k, label: r.periods[k] }))} />
      </div>
      {children}
    </div>
  )
}

function ExportButton({ range }: { range: { from: number; to: number } }) {
  const { can } = useSession()
  const features = useFeatures()
  const toast = useToast()
  const [kind, setKind] = useState<ExportKind>('sales')
  if (!can('reports:export')) return null
  async function run() {
    try {
      const path = await call('reports.export', { report: kind, ...range })
      if (path) toast(r.exported(path))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  return (
    <div className="flex gap-2">
      <SelectInput aria-label={r.exportPick} className="w-44" value={kind} onChange={(e) => setKind(e.target.value as ExportKind)}>
        {(Object.keys(r.exportWhat) as ExportKind[]).filter((k) => features.inventory || (k !== 'profit' && k !== 'waste')).map((k) => (
          <option key={k} value={k}>
            {r.exportWhat[k]}
          </option>
        ))}
      </SelectInput>
      <OutlineButton className="min-h-11" onClick={() => void run()}>
        {r.export}
      </OutlineButton>
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="relative flex min-w-[180px] flex-[1_1_180px] flex-col gap-1 overflow-hidden rounded-[20px] border border-border bg-white p-5">
      <div className="absolute -top-[34px] -right-[34px] size-[100px] rounded-full bg-[#EDE9FB]" />
      <span className="relative text-sm text-muted-foreground">{label}</span>
      <span className="relative text-[26px] leading-tight font-bold">{value}</span>
      {sub && <span className="relative text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** docs/design/Reports.dc.html: sales report tab + tax invoice tab. */
export function ReportsPage() {
  const { can } = useSession()
  const [tab, setTab] = useState<'sales' | 'tax'>('sales')
  return (
    <>
      <PageHeader icon="pie" tone="blue" title={r.title} subtitle={r.subtitle} />
      {can('orders:view') && (
        <div className="max-w-md">
          <Segmented label={r.title} value={tab} onChange={setTab} options={[{ value: 'sales', label: r.tabSales }, { value: 'tax', label: r.tabTax }]} />
        </div>
      )}
      {tab === 'sales' ? <SalesTab /> : <TaxTab />}
    </>
  )
}

function SalesTab() {
  const { can } = useSession()
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('today')
  const [range, setRange] = useState(() => periodFrom('today', Date.now()))
  const [sales, setSales] = useState<SalesReportDto | null>(null)
  const [profit, setProfit] = useState<ProfitReportDto | null>(null)
  const features = useFeatures()
  // profit / COGS / waste need the inventory feature (D51)
  const seeCost = can('reports:view_cost') && features.inventory

  useEffect(() => {
    void call('reports.sales', { ...range, bucket: period === 'today' ? 'hour' : 'day' }).then(setSales, (err: unknown) => toast(errorMessage(err), 'error'))
    if (seeCost) void call('reports.profit', range).then(setProfit, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [range, period, seeCost, toast])

  const maxBucket = Math.max(1, ...(sales?.buckets.map((b) => b.totalSatang) ?? [1]))

  return (
    <>
      <PeriodBar
        period={period}
        onChange={(p) => {
          setPeriod(p)
          setRange(periodFrom(p, Date.now()))
        }}
      >
        <ExportButton range={range} />
      </PeriodBar>
      {sales && (
        <>
          <div className="flex flex-wrap gap-[18px]">
            <Kpi label={r.kpiSales} value={money(sales.totalSatang)} sub={r.voids(sales.voidCount, sales.refundCount)} />
            <Kpi label={r.kpiBills} value={sales.billCount.toLocaleString('en-US')} sub={`${r.kpiAvg} ${money(sales.avgBillSatang)}`} />
            <Kpi label={r.kpiDiscount} value={money(sales.discountSatang)} />
            <Kpi label={r.kpiVat} value={money(sales.vatSatang)} sub={r.vatSub(money(sales.netSatang))} />
            {profit && <Kpi label={r.kpiProfit} value={money(profit.grossProfitSatang)} sub={r.margin(pct(profit.marginBp))} />}
          </div>

          <div className="flex flex-wrap items-start gap-[18px]">
            <Card className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-3">
              <h2 className="m-0 text-lg font-bold">{r.byTime}</h2>
              {sales.buckets.length === 0 ? (
                <span className="text-sm text-muted-foreground">{r.noData}</span>
              ) : (
                <div className="flex h-[200px] items-end gap-1.5 overflow-x-auto">
                  {sales.buckets.map((b) => (
                    <div key={b.start} className="flex max-w-16 min-w-7 flex-1 flex-col items-center justify-end gap-1" title={`${b.label} · ${money(b.totalSatang)} · ${b.billCount}`}>
                      <span className="text-[10px] text-muted-foreground">{b.totalSatang ? Math.round(b.totalSatang / 100).toLocaleString('en-US') : ''}</span>
                      <div className="w-full rounded-t-lg bg-[linear-gradient(180deg,#9776F6,#6A47DB)]" style={{ height: `${Math.max(2, (b.totalSatang / maxBucket) * 150)}px` }} />
                      <span className="text-[11px] text-muted-foreground">{b.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card className="flex min-w-0 flex-[1_1_360px] flex-col gap-2.5">
              <h2 className="m-0 text-lg font-bold">{r.top}</h2>
              {sales.topProducts.length === 0 && <span className="text-sm text-muted-foreground">{r.noData}</span>}
              {sales.topProducts.map((p, i) => (
                <div key={p.name} className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-full bg-[#EDE9FB] text-sm font-bold text-accent-foreground">{i + 1}</span>
                  <span className="flex-1 truncate text-[15px] font-semibold">{p.name}</span>
                  <span className="text-[13px] text-muted-foreground">{r.qty(p.qty)}</span>
                  <span className="w-24 text-right font-semibold">{money(p.totalSatang)}</span>
                </div>
              ))}
            </Card>
          </div>

          <ChannelTable sales={sales} />

          {seeCost ? (
            profit && (
              <Card className="flex flex-col gap-2">
                <h2 className="m-0 text-lg font-bold">{r.profit}</h2>
                <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
                  <span className="flex-[2_1_0]">{r.product}</span>
                  <span className="flex-[1_1_0] text-right">{r.sales}</span>
                  <span className="flex-[1_1_0] text-right">{r.cogs}</span>
                  <span className="flex-[1_1_0] text-right">{r.kpiProfit}</span>
                </div>
                {profit.products.map((p) => (
                  <div key={p.name} className="flex min-h-11 items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3">
                    <span className="flex-[2_1_0] truncate font-semibold">
                      {p.name} <span className="text-xs font-normal text-muted-foreground">× {p.qty}</span>
                    </span>
                    <span className="flex-[1_1_0] text-right">{money(p.netSatang)}</span>
                    <span className="flex-[1_1_0] text-right text-muted-foreground">{money(p.cogsSatang)}</span>
                    <span className={cn('flex-[1_1_0] text-right font-semibold', p.profitSatang < 0 && 'text-danger-foreground')}>{money(p.profitSatang)}</span>
                  </div>
                ))}
                {profit.products.length === 0 && <span className="text-sm text-muted-foreground">{r.noData}</span>}
                <span className="text-xs text-muted-foreground">
                  {r.waste}: {money(profit.wasteSatang)} · {r.cogs}: {money(profit.cogsSatang)}
                </span>
              </Card>
            )
          ) : (
            features.inventory && <span className="text-xs text-muted-foreground">{r.noCost}</span>
          )}
        </>
      )}
    </>
  )
}

function ChannelTable({ sales, deliveryOnly = false }: { sales: SalesReportDto; deliveryOnly?: boolean }) {
  const rows = deliveryOnly ? sales.channels.filter((c) => !['dine_in', 'takeaway'].includes(c.channel)) : sales.channels
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="m-0 text-lg font-bold">{r.channels}</h2>
      <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
        <span className="flex-[2_1_0]">{r.channel}</span>
        <span className="flex-[1_1_0] text-right">{r.bills}</span>
        <span className="flex-[1_1_0] text-right">{r.sales}</span>
        <span className="flex-[1_1_0] text-right">{r.commission}</span>
        {deliveryOnly && <span className="flex-[1_1_0] text-right">{r.rate}</span>}
        <span className="flex-[1_1_0] text-right">{r.net}</span>
      </div>
      {rows.map((c) => (
        <div key={c.channel} className="flex min-h-11 items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3">
          <span className="flex-[2_1_0] font-semibold">{r.channelNames[c.channel] ?? c.channel}</span>
          <span className="flex-[1_1_0] text-right text-muted-foreground">{c.billCount}</span>
          <span className="flex-[1_1_0] text-right">{money(c.totalSatang)}</span>
          <span className="flex-[1_1_0] text-right text-danger-foreground">{c.commissionSatang ? `-${money(c.commissionSatang)}` : '—'}</span>
          {deliveryOnly && <span className="flex-[1_1_0] text-right text-muted-foreground">{c.totalSatang ? pct(Math.round((c.commissionSatang * 10_000) / c.totalSatang)) : '—'}</span>}
          <span className="flex-[1_1_0] text-right font-semibold">{money(c.netSatang)}</span>
        </div>
      ))}
      {rows.length === 0 && <span className="text-sm text-muted-foreground">{deliveryOnly ? r.noDelivery : r.noData}</span>}
      <span className="text-xs text-muted-foreground">{r.commissionHint}</span>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Tax invoices (D19/D20)
// ---------------------------------------------------------------------------

function TaxTab() {
  const { can } = useSession()
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('month')
  const [list, setList] = useState<TaxInvoiceDto[]>([])
  const [billNo, setBillNo] = useState('')
  const [bill, setBill] = useState<BillDetailDto | null>(null)
  const [replace, setReplace] = useState<TaxInvoiceDto | null>(null)
  const [cancel, setCancel] = useState<TaxInvoiceDto | null>(null)

  const load = useCallback(() => call('tax.list', periodFrom(period, Date.now())).then(setList, (err: unknown) => toast(errorMessage(err), 'error')), [period, toast])
  useEffect(() => {
    void load()
  }, [load])

  async function find() {
    try {
      const res = await call('orders.list', { search: billNo.trim(), status: 'paid', page: 1, pageSize: 5 })
      const hit = res.items.find((b) => b.billNo === billNo.trim()) ?? res.items[0]
      if (!hit) return toast(r.billNotFound, 'error')
      setBill(await call('orders.get', { id: hit.id }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function print(inv: TaxInvoiceDto) {
    try {
      await call('tax.print', { id: inv.id })
      toast(r.printed)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      {can('orders:tax_invoice') && (
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{r.issueTitle}</h2>
          <Field label={r.pickBill} hint={r.pickBillHint}>
            <div className="flex gap-2">
              <TextInput value={billNo} maxLength={40} onChange={(e) => setBillNo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void find()} />
              <OutlineButton className="min-h-11" disabled={!billNo.trim()} onClick={() => void find()}>
                {r.findBill}
              </OutlineButton>
            </div>
          </Field>
          {bill && (
            <TaxIssueForm
              bill={bill}
              replaces={null}
              onDone={(inv) => {
                toast(r.issued(inv.invoiceNo))
                setBill(null)
                setBillNo('')
                void load()
              }}
            />
          )}
          <span className="text-xs text-muted-foreground">{r.issueRule}</span>
        </Card>
      )}
      <Card className="flex min-w-0 flex-[1.2_1_460px] flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 flex-1 text-lg font-bold">{r.issuedList}</h2>
          <div className="w-80">
            <Segmented label={r.issuedList} value={period} onChange={setPeriod} options={(Object.keys(r.periods) as Period[]).map((k) => ({ value: k, label: r.periods[k] }))} />
          </div>
        </div>
        {list.map((v) => (
          <div key={v.id} className={cn(rowClass(false, v.cancelled), 'flex-wrap cursor-default py-2')}>
            <div className="flex min-w-[220px] flex-1 flex-col">
              <span className="font-mono text-[15px] font-semibold whitespace-nowrap">{v.invoiceNo}</span>
              <span className="truncate text-xs text-muted-foreground">
                {v.customerName ?? r.types.abbreviated} · {t.orders.title} {v.billNo} · {formatDateTimeShort(v.issuedAt)}
                {v.replacesNo ? ` · ${r.replaces(v.replacesNo)}` : ''}
                {v.cancelReason ? ` · ${v.cancelReason}` : ''}
              </span>
            </div>
            {v.cancelled ? (
              <Chip bg="#FFE3E3" fg="#A6232B">
                {r.cancelled}
              </Chip>
            ) : (
              <Chip>{r.types[v.type]}</Chip>
            )}
            <span className="w-24 text-right font-semibold">{money(v.totalSatang)}</span>
            <div className="flex gap-1.5">
              <OutlineButton className="min-h-11 px-3.5" onClick={() => void print(v)}>
                {r.print}
              </OutlineButton>
              {!v.cancelled && can('orders:tax_invoice') && (
                <>
                  <OutlineButton className="min-h-11 px-3.5" onClick={() => setReplace(v)}>
                    {r.replace}
                  </OutlineButton>
                  <DangerButton className="min-h-11 px-3.5" onClick={() => setCancel(v)}>
                    {r.cancel}
                  </DangerButton>
                </>
              )}
            </div>
          </div>
        ))}
        {list.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
        <Chip className="self-start" bg="#FFF4D6" fg="#7A5200">
          {r.accountant}
        </Chip>
      </Card>

      {replace && <ReplaceDialog inv={replace} onClose={() => setReplace(null)} onDone={(inv) => (toast(r.issued(inv.invoiceNo)), setReplace(null), void load())} />}
      {cancel && (
        <ReasonDialog
          title={`${r.cancel} ${cancel.invoiceNo}`}
          placeholder={r.cancelReason}
          onClose={() => setCancel(null)}
          onSubmit={async (reason) => {
            try {
              await call('tax.cancel', { id: cancel.id, reason })
              setCancel(null)
              void load()
            } catch (err) {
              toast(errorMessage(err), 'error')
            }
          }}
        />
      )}
    </div>
  )
}

function ReplaceDialog({ inv, onClose, onDone }: { inv: TaxInvoiceDto; onClose: () => void; onDone: (inv: TaxInvoiceDto) => void }) {
  const [bill, setBill] = useState<BillDetailDto | null>(null)
  useEffect(() => {
    void call('orders.get', { id: inv.billId }).then(setBill, () => {})
  }, [inv.billId])
  return (
    <Modal title={`${r.replace} ${inv.invoiceNo}`} subtitle={r.issueRule} onClose={onClose} width={520}>
      {bill && <TaxIssueForm bill={bill} replaces={inv} onDone={onDone} />}
    </Modal>
  )
}

/** Shared by the reports tax tab and the Orders page. */
export function TaxIssueForm({ bill, replaces, onDone }: { bill: BillDetailDto; replaces: TaxInvoiceDto | null; onDone: (inv: TaxInvoiceDto) => void }) {
  const toast = useToast()
  const [type, setType] = useState<'full' | 'abbreviated'>(replaces?.type ?? 'full')
  const [c, setC] = useState({ name: replaces?.customerName ?? '', taxId: replaces?.customerTaxId ?? '', branch: replaces?.customerBranch ?? '00000', address: replaces?.customerAddress ?? '' })
  const [busy, setBusy] = useState(false)
  const taxErr = c.taxId && !isValidThaiTaxId(c.taxId) ? r.taxIdInvalid : undefined
  const branchErr = !isValidBranchNo(c.branch) ? r.branchInvalid : undefined
  const ok = type === 'abbreviated' || (c.name.trim() && c.address.trim().length >= 5 && isValidThaiTaxId(c.taxId) && !branchErr)

  async function issue() {
    setBusy(true)
    try {
      const replacesId = replaces?.id ?? null
      const inv = await call(
        'tax.issue',
        type === 'full' ? { type, billId: bill.id, replacesId, customer: { name: c.name.trim(), taxId: c.taxId.replace(/\D/g, ''), branch: c.branch, address: c.address.trim() } } : { type, billId: bill.id, replacesId },
      )
      onDone(inv)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Chip className="self-start">{r.billPicked(bill.billNo, money(bill.totalSatang))}</Chip>
      <Segmented label={r.issueTitle} value={type} onChange={setType} options={[{ value: 'full', label: r.typeFull }, { value: 'abbreviated', label: r.typeAbb }]} />
      {type === 'full' && (
        <>
          <Field label={r.buyerName}>
            <TextInput value={c.name} maxLength={160} onChange={(e) => setC({ ...c, name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <Field label={r.buyerTaxId} error={taxErr}>
              <TextInput inputMode="numeric" invalid={!!taxErr} value={c.taxId} maxLength={17} onChange={(e) => setC({ ...c, taxId: e.target.value.replace(/[^\d-]/g, '') })} />
            </Field>
            <Field label={r.buyerBranch} error={branchErr}>
              <TextInput inputMode="numeric" invalid={!!branchErr} value={c.branch} maxLength={5} onChange={(e) => setC({ ...c, branch: e.target.value.replace(/\D/g, '') })} />
            </Field>
          </div>
          <Field label={r.buyerAddress}>
            <textarea className="min-h-20 w-full rounded-[14px] border-[1.5px] border-[#E6E1D9] p-3 text-[15px]" maxLength={300} value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />
          </Field>
        </>
      )}
      <GradientButton disabled={!ok || busy} onClick={() => void issue()}>
        {r.issue}
      </GradientButton>
      <span className="text-xs text-[#7A5200]">{r.accountant}</span>
    </div>
  )
}

export function TaxIssueDialog({ bill, onClose }: { bill: BillDetailDto; onClose: () => void }) {
  const toast = useToast()
  return (
    <Modal title={r.issueTitle} subtitle={r.issueRule} onClose={onClose} width={520}>
      <TaxIssueForm
        bill={bill}
        replaces={null}
        onDone={(inv) => {
          toast(r.issued(inv.invoiceNo))
          void call('tax.print', { id: inv.id }).catch(() => {})
          onClose()
        }}
      />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Z-Report list and delivery commission
// ---------------------------------------------------------------------------

export function ZReportPage() {
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('week')
  const [list, setList] = useState<ZListItemDto[]>([])
  useEffect(() => {
    void call('reports.zList', periodFrom(period, Date.now())).then(setList, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [period, toast])

  return (
    <>
      <PageHeader icon="receipt" tone="green" title={r.zTitle} subtitle={r.zSubtitle} />
      <PeriodBar period={period} onChange={setPeriod} />
      <Card className="flex flex-col gap-2">
        <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
          <span className="flex-[1.4_1_0]">{r.colShift}</span>
          <span className="flex-[1_1_0] text-right">{r.colSales}</span>
          <span className="flex-[1_1_0] text-right">{r.colExpected}</span>
          <span className="flex-[1_1_0] text-right">{r.colCounted}</span>
          <span className="flex-[1_1_0] text-right">{r.colOverShort}</span>
          <span className="w-20" />
        </div>
        {list.map((z) => (
          <div key={z.shiftId} className="flex min-h-[60px] items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3">
            <div className="flex flex-[1.4_1_0] flex-col">
              <span className="font-semibold">{z.shiftNo}</span>
              <span className="text-xs text-muted-foreground">
                {formatDateTimeShort(z.openedAt)} · {z.openedByName}
              </span>
            </div>
            <span className="flex-[1_1_0] text-right font-semibold">{money(z.totalSalesSatang)}</span>
            <span className="flex-[1_1_0] text-right">{money(z.expectedCashSatang)}</span>
            <span className="flex-[1_1_0] text-right">{z.countedCashSatang === null ? <Chip bg="#FFF4D6" fg="#7A5200">{r.open}</Chip> : money(z.countedCashSatang)}</span>
            <span className={cn('flex-[1_1_0] text-right font-semibold', (z.overShortSatang ?? 0) < 0 ? 'text-danger-foreground' : (z.overShortSatang ?? 0) > 0 ? 'text-success-foreground' : '')}>{z.overShortSatang === null ? '—' : money(z.overShortSatang)}</span>
            <OutlineButton
              className="min-h-11 w-20 px-3"
              onClick={() =>
                void call('shift.printZ', { shiftId: z.shiftId }).then(
                  () => toast(r.printed),
                  (err: unknown) => toast(errorMessage(err), 'error'),
                )
              }
            >
              {r.zPrint}
            </OutlineButton>
          </div>
        ))}
        {list.length === 0 && <span className="text-sm text-muted-foreground">{r.zEmpty}</span>}
      </Card>
    </>
  )
}

export function DeliveryCommissionPage() {
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('month')
  const [sales, setSales] = useState<SalesReportDto | null>(null)
  useEffect(() => {
    void call('reports.sales', { ...periodFrom(period, Date.now()), bucket: 'day' }).then(setSales, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [period, toast])
  const delivery = sales?.channels.filter((c) => !['dine_in', 'takeaway'].includes(c.channel)) ?? []
  const sum = (k: 'totalSatang' | 'commissionSatang' | 'netSatang') => delivery.reduce((a, c) => a + c[k], 0)

  return (
    <>
      <PageHeader icon="truck" tone="orange" title={r.deliveryTitle} subtitle={r.deliverySubtitle} />
      <PeriodBar period={period} onChange={setPeriod} />
      {sales && (
        <>
          <div className="flex flex-wrap gap-[18px]">
            <Kpi label={r.sales} value={money(sum('totalSatang'))} sub={`${delivery.reduce((a, c) => a + c.billCount, 0)} ${r.bills}`} />
            <Kpi label={r.commission} value={money(sum('commissionSatang'))} sub={`${r.rate} ${sum('totalSatang') ? pct(Math.round((sum('commissionSatang') * 10_000) / sum('totalSatang'))) : '—'}`} />
            <Kpi label={r.net} value={money(sum('netSatang'))} />
          </div>
          <ChannelTable sales={sales} deliveryOnly />
        </>
      )}
    </>
  )
}
