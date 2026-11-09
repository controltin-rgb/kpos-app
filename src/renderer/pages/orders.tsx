import { useCallback, useEffect, useState } from 'react'
import type { BillDetailDto, BillList, BillStatus } from '@shared/api-sales'
import { Modal } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { ApiError, call, errorMessage } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { formatDateTimeShort, money, vatPct } from '@renderer/lib/format'
import { monthRange, recentMonths } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'
import { TaxIssueDialog } from './reports'

const o = t.orders
const STATUS: Record<BillStatus, { bg: string; fg: string }> = {
  open: { bg: '#EDE9FB', fg: '#4B2FB8' },
  paid: { bg: '#DDF5E8', fg: '#11724A' },
  void: { bg: '#FFE3E3', fg: '#A6232B' },
  refunded: { bg: '#FFF4D6', fg: '#7A5200' },
}

/** Start of today in Bangkok (epoch ms). */
function startOfToday(): number {
  const now = new Date()
  const bkk = new Date(now.getTime() + 7 * 3_600_000)
  return Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3_600_000
}

/** docs/design/Orders.dc.html (draft): search bills, details, reprint, void, refund. */
export function OrdersPage() {
  const { can } = useSession()
  const toast = useToast()
  const [q, setQ] = useState({ search: '', status: 'all' as 'all' | 'paid' | 'void' | 'refunded', date: 'today', page: 1 })
  const [list, setList] = useState<BillList | null>(null)
  const [bill, setBill] = useState<BillDetailDto | null>(null)
  const [action, setAction] = useState<'void' | 'refund' | null>(null)
  const [taxOpen, setTaxOpen] = useState(false)
  const [months] = useState(() => recentMonths(Date.now()))

  const query = useCallback(
    () =>
      call('orders.list', {
        page: q.page,
        status: q.status,
        ...(q.search ? { search: q.search } : {}),
        ...(q.date === 'today' ? { from: startOfToday() } : q.date === 'all' ? {} : monthRange(q.date)),
      }),
    [q],
  )
  const load = useCallback(() => query().then(setList, (err: unknown) => toast(errorMessage(err), 'error')), [query, toast])

  useEffect(() => {
    let alive = true
    const h = setTimeout(() => void query().then((v) => alive && setList(v), (err: unknown) => toast(errorMessage(err), 'error')), q.search ? 250 : 0)
    return () => {
      alive = false
      clearTimeout(h)
    }
  }, [query, q.search, toast])
  useAppEvent((e) => {
    if (e.type === 'bill.changed') {
      void load()
      if (bill?.id === e.billId) void call('orders.get', { id: e.billId }).then(setBill)
    }
  })

  async function select(id: string) {
    try {
      setBill(await call('orders.get', { id }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function reprint() {
    if (!bill) return
    try {
      await call('orders.print', { id: bill.id })
      toast(t.pos.printed)
      setBill(await call('orders.get', { id: bill.id }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <PageHeader icon="receipt" tone="blue" title={o.title} subtitle={o.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_560px] flex-col gap-3.5">
          <div className="flex flex-wrap gap-2.5">
            <TextInput type="search" aria-label={o.search} placeholder={o.search} className="flex-[2_1_180px]" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} />
            <SelectInput aria-label={o.allStatus} className="flex-[1_1_120px]" value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value as typeof q.status, page: 1 })}>
              <option value="all">{o.allStatus}</option>
              {(['paid', 'void', 'refunded'] as const).map((s) => (
                <option key={s} value={s}>
                  {t.billStatus[s]}
                </option>
              ))}
            </SelectInput>
            <SelectInput aria-label={o.dateFilter} className="flex-[1_1_150px]" value={q.date} onChange={(e) => setQ({ ...q, date: e.target.value, page: 1 })}>
              <option value="today">{o.today}</option>
              <option value="all">{o.allDates}</option>
              <optgroup label={o.byMonth}>
                {months.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            </SelectInput>
          </div>
          <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
            <span className="flex-[1.6_1_0]">{o.colNo}</span>
            <span className="flex-[1_1_0]">{o.colChannel}</span>
            <span className="flex-[0.9_1_0]">{o.colPay}</span>
            <span className="flex-[0.9_1_0] text-right">{o.colTotal}</span>
            <span className="flex-[0_0_92px]">{o.colStatus}</span>
          </div>
          <div role="list" className="flex flex-col gap-1.5">
            {list?.items.map((b) => (
              <div
                key={b.id}
                role="listitem"
                onClick={() => void select(b.id)}
                className={cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5', b.id === bill?.id ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]')}
              >
                <div className="flex min-w-0 flex-[1.6_1_0] flex-col">
                  <span className="text-[15px] font-semibold">{b.billNo}</span>
                  <span className="text-xs text-muted-foreground">{o.meta(formatDateTimeShort(b.createdAt), b.createdByName)}</span>
                </div>
                <span className="flex-[1_1_0] text-[13px]">{b.channel ? t.channels[b.channel] : t.orderTypes[b.orderType]}</span>
                <span className="flex-[0.9_1_0] text-[13px]">{b.paymentMethod ? t.methods[b.paymentMethod] : '—'}</span>
                <span className="flex-[0.9_1_0] text-right text-[15px] font-semibold">{money(b.totalSatang)}</span>
                <span className="flex-[0_0_92px]">
                  <Chip bg={STATUS[b.status].bg} fg={STATUS[b.status].fg}>
                    {t.billStatus[b.status]}
                  </Chip>
                </span>
              </div>
            ))}
            {list && list.items.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t.crud.empty}</div>}
          </div>
          {list && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-muted-foreground">{t.crud.showing(list.items.length, list.total)}</span>
              <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onPage={(page) => setQ({ ...q, page })} />
            </div>
          )}
        </Card>

        <aside className="box-border flex max-w-full flex-[0_0_400px] flex-col gap-3 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
          {!bill ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{o.selectHint}</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-lg font-bold">{o.bill(bill.billNo)}</span>
                  <span className="text-[13px] text-muted-foreground">
                    {o.meta(formatDateTimeShort(bill.createdAt), bill.createdByName)} · {t.orderTypes[bill.orderType]}
                  </span>
                </div>
                <Chip bg={STATUS[bill.status].bg} fg={STATUS[bill.status].fg}>
                  {t.billStatus[bill.status]}
                </Chip>
              </div>
              {bill.channel && (
                <span className="rounded-xl bg-[#FFF1E3] px-3 py-2 text-[13px] text-[#8A3F05]">
                  {o.orderId(t.channels[bill.channel])} <strong>{bill.extOrderId ?? '—'}</strong>
                  {bill.commissionBp !== null && bill.commissionSatang !== null && <> · {o.commission(String(bill.commissionBp / 100), money(bill.commissionSatang))}</>}
                </span>
              )}
              {bill.voidReason && <span className="rounded-xl bg-danger px-3 py-2 text-[13px] text-danger-foreground">{bill.voidReason}</span>}
              <div className="flex flex-col gap-1.5">
                {bill.items.map((i) => (
                  <div key={i.id} className="flex items-start gap-2.5 rounded-xl bg-[#F7F5F2] px-3 py-2">
                    <span className="font-bold text-accent-foreground">{i.qty}×</span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-semibold">
                        {i.productName}
                        {i.sizeLabel ? ` (${i.sizeLabel})` : ''}
                      </span>
                      {(i.modifiers.length > 0 || i.note) && <span className="text-xs text-muted-foreground">{[...i.modifiers.map((m) => m.optionName), i.note ? `“${i.note}”` : null].filter(Boolean).join(' · ')}</span>}
                    </div>
                    <span className="text-sm font-semibold">{money(i.lineTotalSatang)}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 border-t border-border pt-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{o.subtotal}</span>
                  <span>{money(bill.subtotalSatang)}</span>
                </div>
                {bill.discounts.length > 0
                  ? bill.discounts.map((d, i) => (
                      <div key={i} className="flex justify-between">
                        <span className="text-muted-foreground">{d.description}</span>
                        <span>-{money(d.amountSatang)}</span>
                      </div>
                    ))
                  : bill.discountSatang > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{o.discount}</span>
                        <span>-{money(bill.discountSatang)}</span>
                      </div>
                    )}
                {bill.member && (
                  <span className="text-xs text-muted-foreground">
                    {t.pos.memberTitle}: {bill.member.name ?? bill.member.phoneMasked} · +{bill.member.pointsEarned}
                    {bill.member.pointsRedeemed ? ` / −${bill.member.pointsRedeemed}` : ''}
                  </span>
                )}
                {bill.vatMode === 'inclusive' && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{o.vat(vatPct(Math.round((bill.vatSatang * 10_000) / Math.max(1, bill.totalSatang - bill.vatSatang) / 100) * 100))}</span>
                    <span>{money(bill.vatSatang)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold">
                  <span>{o.net}</span>
                  <span>{money(bill.totalSatang)}</span>
                </div>
                {bill.payments.map((p, i) => (
                  <div key={i} className="flex justify-between text-[13px] text-muted-foreground">
                    <span>
                      {o.paidWith} {t.methods[p.method]}
                    </span>
                    <span>{p.tenderedSatang !== null && p.changeSatang !== null ? o.tendered(money(p.tenderedSatang), money(p.changeSatang)) : p.reference ?? ''}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-muted-foreground">{o.events}</span>
                {bill.events.map((e, i) => (
                  <span key={i} className="text-xs text-muted-foreground">
                    {formatDateTimeShort(e.at)} · {o.eventNames[e.event] ?? e.event} · {e.userName}
                    {e.approverName ? ` · ${o.approvedBy(e.approverName)}` : ''}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <OutlineButton className="min-h-12 flex-1" onClick={() => void reprint()}>
                  {o.reprint}
                </OutlineButton>
                <OutlineButton className="min-h-12 flex-1" disabled={bill.status !== 'paid' || !can('orders:tax_invoice')} onClick={() => setTaxOpen(true)}>
                  {o.taxInvoice}
                </OutlineButton>
              </div>
              {bill.status === 'paid' && (
                <div className="flex gap-2">
                  {bill.voidable && can('pos:create') && (
                    <DangerButton className="min-h-12 flex-1" onClick={() => setAction('void')}>
                      {o.void}
                    </DangerButton>
                  )}
                  <DangerButton className="min-h-12 flex-1" onClick={() => setAction('refund')}>
                    {o.refund}
                  </DangerButton>
                </div>
              )}
              <span className="text-xs text-[#7A8090]">{o.perms}</span>
            </>
          )}
        </aside>
      </div>
      {bill && taxOpen && <TaxIssueDialog bill={bill} onClose={() => setTaxOpen(false)} />}
      {bill && action && (
        <ReverseDialog
          bill={bill}
          kind={action}
          onClose={() => setAction(null)}
          onDone={(b) => {
            setAction(null)
            setBill(b)
            toast(o.done)
            void load()
          }}
        />
      )}
    </>
  )
}

/** Void / refund with a mandatory reason; asks for an approver PIN when the user lacks the permission. */
function ReverseDialog({ bill, kind, onClose, onDone }: { bill: BillDetailDto; kind: 'void' | 'refund'; onClose: () => void; onDone: (b: BillDetailDto) => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [other, setOther] = useState('')
  const [approver, setApprover] = useState<{ username: string; pin: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const finalReason = reason === '__other' ? other.trim() : reason

  async function submit() {
    setBusy(true)
    try {
      const input = { id: bill.id, reason: finalReason, ...(approver ? { approver } : {}) }
      onDone(kind === 'void' ? await call('orders.void', input) : await call('orders.refund', input))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED' && !approver) setApprover({ username: '', pin: '' })
      else toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={kind === 'void' ? o.voidTitle(bill.billNo) : o.refundTitle(bill.billNo)} onClose={onClose} width={460}>
      <Field label={o.reason}>
        <SelectInput value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">{o.pickReason}</option>
          {o.reasons.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          <option value="__other">{o.otherReason}</option>
        </SelectInput>
      </Field>
      {reason === '__other' && <input className={inputClass} placeholder={o.otherReasonPlaceholder} value={other} maxLength={200} onChange={(e) => setOther(e.target.value)} />}
      <span className="text-[13px] text-muted-foreground">{kind === 'void' ? o.voidNote : o.refundNote}</span>
      {approver && (
        <div className="flex flex-col gap-2 rounded-2xl bg-warning p-3 text-warning-foreground">
          <strong>{t.approval.title}</strong>
          <span className="text-[13px]">{t.approval.text}</span>
          <div className="grid grid-cols-2 gap-2">
            <TextInput aria-label={t.approval.username} placeholder={t.approval.username} autoFocus value={approver.username} onChange={(e) => setApprover({ ...approver, username: e.target.value })} />
            <TextInput aria-label={t.approval.pin} placeholder={t.approval.pin} type="password" inputMode="numeric" maxLength={6} value={approver.pin} onChange={(e) => setApprover({ ...approver, pin: e.target.value.replace(/\D/g, '') })} />
          </div>
        </div>
      )}
      <GradientButton size="lg" disabled={busy || finalReason.length < 3 || (!!approver && (!approver.username || approver.pin.length < 4))} onClick={() => void submit()}>
        {approver ? t.approval.approve : kind === 'void' ? o.confirmVoid : o.confirmRefund}
      </GradientButton>
    </Modal>
  )
}
