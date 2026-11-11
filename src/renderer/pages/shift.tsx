import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ShiftSummaryDto } from '@shared/api-sales'
import { GRADIENTS, GradientButton, IconTile, inputClass, useToast } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'

const s = t.shift

// denominations shown in docs/design/Shift.dc.html (confirmed design), in satang
const ROWS: { d: number; label: string; short: string; g: string }[] = [
  { d: 100_000, label: s.note('1,000'), short: '1000', g: GRADIENTS.violet },
  { d: 50_000, label: s.note('500'), short: '500', g: GRADIENTS.pink },
  { d: 10_000, label: s.note('100'), short: '100', g: GRADIENTS.red },
  { d: 5_000, label: s.note('50'), short: '50', g: GRADIENTS.blue },
  { d: 2_000, label: s.note('20'), short: '20', g: GRADIENTS.green },
  { d: 1_000, label: s.coin('10'), short: '10', g: GRADIENTS.amber },
  { d: 500, label: s.coin('5'), short: '5', g: GRADIENTS.amber },
  { d: 200, label: s.coin('2'), short: '2', g: GRADIENTS.amber },
  { d: 100, label: s.coin('1'), short: '1', g: GRADIENTS.amber },
  { d: 50, label: s.coinSatang, short: '.50', g: GRADIENTS.amber },
]

const card = 'flex flex-col rounded-[22px] border border-border bg-white p-[22px]'
const line = 'flex justify-between text-sm'

/** docs/design/Shift.dc.html (confirmed design): count the drawer, Over/Short, Z-Report, close shift. */
export function ShiftPage() {
  const { user, can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [shift, setShift] = useState<ShiftSummaryDto | null | undefined>(undefined)
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<ShiftSummaryDto | null>(null)

  useEffect(() => {
    let alive = true
    call('shift.current').then(
      (v) => alive && setShift(v),
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])
  useAppEvent((e) => {
    if (e.type === 'shift.changed' || e.type === 'bill.changed') void call('shift.current').then(setShift)
  })

  const actual = useMemo(() => ROWS.reduce((sum, r) => sum + r.d * (counts[r.d] ?? 0), 0), [counts])
  const view = shift ?? closed
  const expected = view?.expectedCashSatang ?? 0
  const diff = (closed ? (closed.countedCashSatang ?? 0) : actual) - expected
  const diffStyle = diff === 0 ? { bg: '#DDF5E8', fg: '#11724A', label: s.match } : diff > 0 ? { bg: '#FFEBCC', fg: '#7A4A00', label: s.over } : { bg: '#FDE3E5', fg: '#A6232B', label: s.short }
  const diffText = (diff > 0 ? '+ ' : diff < 0 ? '− ' : '') + money(Math.abs(diff))

  async function close() {
    if (!shift || !(await confirm({ kind: 'warning', icon: 'clock', title: t.confirmDialog.closeShiftTitle, message: s.closeConfirm(diffText), confirmLabel: t.confirmDialog.closeShift }))) return
    setBusy(true)
    try {
      const res = await call('shift.close', {
        shiftId: shift.id,
        counts: ROWS.map((r) => ({ denominationSatang: r.d, count: counts[r.d] ?? 0 })),
        note: note.trim() || null,
      })
      setClosed(res)
      setShift(null)
      toast(s.closed)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function printZ() {
    if (!view) return
    try {
      await call('shift.printZ', { shiftId: view.id })
      toast(t.pos.printed)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const header = (
    <div className="flex flex-wrap items-center gap-3.5">
      <div className="flex flex-[1_1_360px] items-center gap-3.5">
        <IconTile icon="clock" tone="green" size={52} iconSize={26} radius={15} shadow />
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 text-[26px] font-bold">{s.title}</h1>
          {view && <div className="text-[13px] text-muted-foreground">{s.subtitle(view.openedByName, formatDateTimeShort(view.openedAt), user?.branchName ?? '')}</div>}
        </div>
      </div>
      <div className="inline-flex gap-2">
        <span className="inline-flex h-[38px] items-center gap-2 rounded-[19px] bg-success px-3.5 text-[13px] font-semibold text-success-foreground">
          <span className="inline-block size-2 rounded-full bg-[#1BA56B]" />
          {t.common.online}
        </span>
        {shift && <span className="inline-flex h-[38px] items-center rounded-[19px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground">{s.open}</span>}
      </div>
    </div>
  )

  if (shift === undefined) return header
  if (!view)
    return (
      <>
        {header}
        <div className={`${card} items-start gap-3`}>
          <strong>{s.noShift}</strong>
          <span className="text-sm text-muted-foreground">{s.noShiftHint}</span>
          {can('pos:view') && <GradientButton onClick={() => navigate('/pos')}>{s.goPos}</GradientButton>}
        </div>
      </>
    )

  const otherMethods = view.byMethod.card + view.byMethod.transfer + view.byMethod.other
  const readOnly = !!closed

  return (
    <>
      {header}
      <div className="flex flex-wrap items-start gap-4">
        <section className={`${card} min-w-0 flex-[1.3_1_460px] gap-4`}>
          <h2 className="m-0 text-[17px] font-semibold">{s.countTitle}</h2>
          <div className="grid grid-cols-[1fr_120px_130px] items-center gap-x-3.5 gap-y-2.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">{s.colType}</span>
            <span className="text-xs font-semibold text-muted-foreground">{s.colCount}</span>
            <span className="text-right text-xs font-semibold text-muted-foreground">{s.colSum}</span>
            {ROWS.map((r) => {
              const n = counts[r.d] ?? 0
              return (
                <div key={r.d} className="contents">
                  <span className="flex items-center gap-2.5">
                    <span className="box-border flex h-[30px] min-w-11 items-center justify-center rounded-[9px] px-1.5 text-xs font-bold text-white" style={{ background: r.g }}>
                      {r.short}
                    </span>
                    {r.label}
                  </span>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    aria-label={s.countAria(r.label)}
                    disabled={readOnly}
                    value={n || ''}
                    placeholder="0"
                    onChange={(e) => setCounts((c) => ({ ...c, [r.d]: Math.max(0, parseInt(e.target.value || '0', 10) || 0) }))}
                    className="box-border h-11 w-full rounded-xl border border-[#E8E4DF] bg-[#F8F6F3] px-3 text-right text-[15px] text-foreground"
                  />
                  <span className="text-right font-semibold">{money(r.d * n)}</span>
                </div>
              )
            })}
          </div>
          <div className="flex items-baseline justify-between border-t border-border pt-3.5">
            <span className="text-base font-bold">{s.actual}</span>
            <span className="text-[28px] font-bold text-accent-foreground">{money(readOnly ? (closed.countedCashSatang ?? 0) : actual)}</span>
          </div>
        </section>

        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
          <section className={`${card} gap-2.5`}>
            <h2 className="m-0 text-[17px] font-semibold">{s.diffTitle}</h2>
            <div className={line}>
              <span className="text-muted-foreground">{s.float}</span>
              <span>{money(view.openingFloatSatang)}</span>
            </div>
            <div className={line}>
              <span className="text-muted-foreground">{s.cashSales}</span>
              <span>+ {money(view.cashSalesSatang)}</span>
            </div>
            {view.cashInSatang > 0 && (
              <div className={line}>
                <span className="text-muted-foreground">{s.cashIn}</span>
                <span>+ {money(view.cashInSatang)}</span>
              </div>
            )}
            {view.cashRefundsSatang > 0 && (
              <div className={line}>
                <span className="text-muted-foreground">{s.refunds}</span>
                <span>− {money(view.cashRefundsSatang)}</span>
              </div>
            )}
            <div className={line}>
              <span className="text-muted-foreground">{s.expenses}</span>
              <span>− {money(view.cashOutSatang + view.expensesSatang)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2.5 text-[15px] font-semibold">
              <span>{s.expected}</span>
              <span>{money(expected)}</span>
            </div>
            <div className="flex justify-between text-[15px] font-semibold">
              <span>{s.actualShort}</span>
              <span>{money(readOnly ? (closed.countedCashSatang ?? 0) : actual)}</span>
            </div>
            <div className="flex items-center justify-between rounded-[14px] px-4 py-3" style={{ background: diffStyle.bg, color: diffStyle.fg }}>
              <span className="text-[15px] font-bold">{diffStyle.label}</span>
              <span className="text-2xl font-bold">{diffText}</span>
            </div>
            <div className="text-xs text-muted-foreground">{s.formula}</div>
          </section>

          <section className={`${card} gap-2.5`}>
            <h2 className="m-0 text-[17px] font-semibold">{s.zTitle}</h2>
            {[
              { label: s.zCash, color: '#1BA56B', v: view.byMethod.cash },
              { label: s.zPromptPay, color: '#6A47DB', v: view.byMethod.promptpay },
              { label: s.zDelivery, color: '#F7791E', v: view.byMethod.delivery },
              ...(otherMethods ? [{ label: s.zOther, color: '#4C8DF6', v: otherMethods }] : []),
            ].map((r) => (
              <div key={r.label} className={line}>
                <span className="inline-flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: r.color }} />
                  {r.label}
                </span>
                <span>{money(r.v)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-2.5 text-[15px] font-bold">
              <span>{s.zTotal}</span>
              <span>{money(view.totalSalesSatang)}</span>
            </div>
            <span className="text-xs text-muted-foreground">{s.bills(view.billCount, view.voidCount, view.refundCount)}</span>
          </section>

          {!readOnly && (
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              {s.closeNote}
              <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          <div className="flex flex-wrap gap-2.5">
            <button type="button" onClick={() => void printZ()} className="min-h-14 flex-[1_1_180px] cursor-pointer rounded-2xl border-0 bg-white text-[15px] font-semibold shadow-[0_1px_3px_rgba(40,30,60,0.15)]">
              {s.printZ}
            </button>
            {!readOnly && can('shift:update') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void close()}
                className="min-h-14 flex-[1_1_180px] cursor-pointer rounded-2xl border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-[15px] font-bold text-white shadow-[0_10px_22px_rgba(106,71,219,0.32)] disabled:opacity-60"
              >
                {s.confirmClose}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
