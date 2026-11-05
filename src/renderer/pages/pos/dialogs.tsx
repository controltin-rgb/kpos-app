import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { SaleResult } from '@shared/api-sales'
import { MoneyInput, Modal, Segmented } from '@renderer/components/modal'
import { GradientButton, inputClass, OutlineButton, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { money, qty } from '@renderer/lib/format'

const p = t.pos

/** Cash payment: tendered amount with quick buttons, change shown live. */
export function CashDialog({ total, busy, onPay, onClose }: { total: number; busy: boolean; onPay: (tendered: number) => void; onClose: () => void }) {
  const [tendered, setTendered] = useState<number | null>(total)
  // next "round" notes above the total: 20, 50, 100, 500, 1000 baht
  const quick = [2_000, 5_000, 10_000, 50_000, 100_000].map((n) => Math.ceil(total / n) * n).filter((v, i, a) => v > total && a.indexOf(v) === i).slice(0, 4)
  const change = tendered === null ? null : tendered - total
  return (
    <Modal title={p.cashTitle} onClose={busy ? undefined : onClose} width={480}>
      <div className="flex items-baseline justify-between rounded-2xl bg-[#F7F5F2] px-4 py-3">
        <span className="text-muted-foreground">{p.amountDue}</span>
        <span className="text-[30px] font-bold text-accent-foreground">{money(total)}</span>
      </div>
      <label className="flex flex-col gap-2 text-sm font-bold">
        {p.tendered}
        <MoneyInput value={tendered} onChange={setTendered} autoFocus big ariaLabel={p.tendered} />
      </label>
      <div className="flex flex-wrap gap-2">
        <OutlineButton className="min-h-12 rounded-2xl" onClick={() => setTendered(total)}>
          {p.exact}
        </OutlineButton>
        {quick.map((v) => (
          <OutlineButton key={v} className="min-h-12 rounded-2xl" onClick={() => setTendered(v)}>
            {money(v)}
          </OutlineButton>
        ))}
      </div>
      <div className={`flex items-baseline justify-between rounded-2xl px-4 py-3 ${change !== null && change >= 0 ? 'bg-success text-success-foreground' : 'bg-danger text-danger-foreground'}`}>
        <span className="font-semibold">{change !== null && change >= 0 ? p.change : p.notEnough}</span>
        <span className="text-2xl font-bold">{change === null ? '—' : money(Math.abs(change))}</span>
      </div>
      <button
        type="button"
        disabled={busy || change === null || change < 0}
        onClick={() => tendered !== null && onPay(tendered)}
        className="min-h-14 cursor-pointer rounded-2xl border-0 bg-[linear-gradient(135deg,#34C98A,#1BA56B)] text-base font-bold text-white shadow-[0_10px_20px_rgba(27,165,107,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? t.common.saving : p.confirmPay}
      </button>
    </Modal>
  )
}

/** Shows the PromptPay QR; staff confirm manually after checking their banking app (CLAUDE.md). */
export function PromptPayDialog({ total, payload, busy, onConfirm, onClose }: { total: number; payload: string; busy: boolean; onConfirm: (reference: string) => void; onClose: () => void }) {
  const [img, setImg] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  useEffect(() => {
    let alive = true
    void QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then((url) => alive && setImg(url))
    return () => {
      alive = false
    }
  }, [payload])
  return (
    <Modal title={p.ppTitle} subtitle={p.ppScan} onClose={busy ? undefined : onClose} width={440}>
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-[248px] items-center justify-center rounded-[20px] border-2 border-border bg-white p-2">{img && <img src={img} alt="PromptPay QR" width={232} height={232} />}</div>
        <span className="text-[34px] font-bold text-accent-foreground">{money(total)}</span>
        <span className="rounded-full bg-warning px-4 py-2 text-sm font-semibold text-warning-foreground">{p.ppNote}</span>
      </div>
      <label className="flex flex-col gap-2 text-sm font-bold">
        {p.ppReference}
        <input className={inputClass} value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
      </label>
      <GradientButton size="lg" disabled={busy} onClick={() => onConfirm(reference.trim())}>
        {busy ? t.common.saving : p.ppConfirm}
      </GradientButton>
    </Modal>
  )
}

/** Sale finished: bill number, change, stock warnings, print. */
export function ResultDialog({ result, changeSatang, onClose }: { result: SaleResult; changeSatang: number | null; onClose: () => void }) {
  const toast = useToast()
  const [printing, setPrinting] = useState(false)
  async function print() {
    setPrinting(true)
    try {
      await call('orders.print', { id: result.bill.id })
      toast(p.printed)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setPrinting(false)
    }
  }
  return (
    <Modal title={p.paidTitle} subtitle={p.billNo(result.bill.billNo)} onClose={onClose} width={460}>
      {changeSatang !== null && (
        <div className="flex items-baseline justify-between rounded-2xl bg-success px-4 py-3 text-success-foreground">
          <span className="font-semibold">{p.change}</span>
          <span className="text-[34px] font-bold">{money(changeSatang)}</span>
        </div>
      )}
      {result.shortages.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-2xl bg-warning px-4 py-3 text-sm text-warning-foreground">
          <strong>{p.shortageTitle}</strong>
          {result.shortages.map((s) => (
            <span key={s.ingredientName}>• {p.shortageLine(s.ingredientName, qty(s.qtyMilli), t.units[s.baseUnit as keyof typeof t.units] ?? s.baseUnit)}</span>
          ))}
        </div>
      )}
      <div className="flex gap-2.5">
        <OutlineButton className="min-h-14 flex-1 rounded-2xl" disabled={printing} onClick={() => void print()}>
          {p.printReceipt}
        </OutlineButton>
        <GradientButton size="lg" className="flex-1 rounded-2xl" autoFocus onClick={onClose}>
          {p.newOrder}
        </GradientButton>
      </div>
    </Modal>
  )
}

/** No open shift on this device: enter the opening float. */
export function OpenShiftDialog({ canOpen, onOpened }: { canOpen: boolean; onOpened: () => void }) {
  const toast = useToast()
  const [float, setFloat] = useState<number | null>(0)
  const [busy, setBusy] = useState(false)
  async function open() {
    if (float === null) return
    setBusy(true)
    try {
      await call('shift.open', { openingFloatSatang: float })
      onOpened()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={p.openShiftTitle} subtitle={canOpen ? p.openShiftText : p.noShiftPermission} width={420}>
      {canOpen && (
        <>
          <label className="flex flex-col gap-2 text-sm font-bold">
            {p.openingFloat}
            <MoneyInput value={float} onChange={setFloat} autoFocus big ariaLabel={p.openingFloat} />
          </label>
          <GradientButton size="lg" disabled={busy || float === null} onClick={() => void open()}>
            {p.openShift}
          </GradientButton>
        </>
      )}
    </Modal>
  )
}

/** Cash in / cash out of the drawer with a reason (audited). */
export function CashMoveDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const toast = useToast()
  const [kind, setKind] = useState<'cash_in' | 'cash_out'>('cash_out')
  const [amount, setAmount] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!amount) return
    setBusy(true)
    try {
      await call('shift.cashMove', { kind, amountSatang: amount, reason: reason.trim() })
      toast(p.cashMoved)
      onDone()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={p.cashMoveTitle} onClose={onClose} width={440}>
      <Segmented
        label={p.cashMoveTitle}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'cash_in', label: p.cashIn },
          { value: 'cash_out', label: p.cashOut },
        ]}
      />
      <label className="flex flex-col gap-2 text-sm font-bold">
        {p.amount}
        <MoneyInput value={amount} onChange={setAmount} autoFocus big ariaLabel={p.amount} />
      </label>
      <label className="flex flex-col gap-2 text-sm font-bold">
        {p.reason}
        <input className={inputClass} value={reason} maxLength={200} placeholder={p.reasonPlaceholder} onChange={(e) => setReason(e.target.value)} />
      </label>
      <GradientButton size="lg" disabled={busy || !amount || reason.trim().length < 3} onClick={() => void save()}>
        {t.common.save}
      </GradientButton>
    </Modal>
  )
}
