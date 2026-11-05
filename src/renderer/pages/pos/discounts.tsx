import { useEffect, useState } from 'react'
import type { MemberDto, PointsRulesDto, QuoteDto } from '@shared/api-promo'
import { MoneyInput, Modal, Segmented } from '@renderer/components/modal'
import { GradientButton, inputClass, OutlineButton, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { money } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

const p = t.pos

export interface DiscountState {
  member: MemberDto | null
  couponCode: string | null
  excludedPromotionIds: string[]
  manual: { kind: 'percent' | 'amount'; value: number; reason: string; approver?: { username: string; pin: string } } | null
  redeemPoints: number
}

export const emptyDiscounts = (): DiscountState => ({ member: null, couponCode: null, excludedPromotionIds: [], manual: null, redeemPoints: 0 })

/** Find or register a member by phone (PDPA consent required). */
export function MemberDialog({ onPick, onClose }: { onPick: (m: MemberDto) => void; onClose: () => void }) {
  const toast = useToast()
  const [phone, setPhone] = useState('')
  const [found, setFound] = useState<MemberDto[] | null>(null)
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (phone.length < 4) return
    let alive = true
    const h = setTimeout(() => void call('members.search', { phone }).then((r) => alive && setFound(r), () => {}), 200)
    return () => {
      alive = false
      clearTimeout(h)
    }
  }, [phone])

  async function register() {
    setBusy(true)
    try {
      onPick(await call('members.register', { phone, name: name.trim() || null, consent: true }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const canRegister = /^0\d{8,9}$/.test(phone) && consent && (found ?? []).every((m) => !m.phoneMasked.endsWith(phone.slice(-4)) || phone.length < 9)
  return (
    <Modal title={p.memberTitle} onClose={onClose} width={460}>
      <label className="flex flex-col gap-2 text-sm font-bold">
        {p.memberPhone}
        <input className={inputClass} inputMode="numeric" autoFocus value={phone} maxLength={10} placeholder={p.memberSearchHint} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
      </label>
      {phone.length >= 4 && found && (
        <div className="flex flex-col gap-1.5">
          {found.length === 0 && <span className="text-sm text-muted-foreground">{p.memberNone}</span>}
          {found.map((m) => (
            <button key={m.id} type="button" onClick={() => onPick(m)} className="flex min-h-12 cursor-pointer items-center justify-between rounded-2xl border-0 bg-[#F7F5F2] px-3.5 text-left text-sm">
              <span>{p.memberLine(m.name ?? '', m.phoneMasked, m.tierName, m.pointsBalance)}</span>
              <span className="font-semibold text-accent-foreground">{p.memberPick}</span>
            </button>
          ))}
        </div>
      )}
      {/^0\d{8,9}$/.test(phone) && found?.length === 0 && (
        <div className="flex flex-col gap-2.5 rounded-2xl border border-border p-3.5">
          <strong>{p.memberRegister}</strong>
          <input className={inputClass} placeholder={p.memberName} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px]">{p.memberConsent}</span>
            <Toggle checked={consent} label={p.memberConsent} onChange={setConsent} />
          </div>
          <GradientButton disabled={busy || !canRegister} onClick={() => void register()}>
            {p.memberSave}
          </GradientButton>
        </div>
      )}
    </Modal>
  )
}

/** Promotions (auto, removable), coupon, manual discount and point redemption for the current cart. */
export function DiscountDialog({
  state,
  quote,
  rules,
  onChange,
  onClose,
}: {
  state: DiscountState
  quote: QuoteDto | null
  rules: PointsRulesDto | null
  onChange: (s: DiscountState) => void
  onClose: () => void
}) {
  const [code, setCode] = useState(state.couponCode ?? '')
  const [manualOn, setManualOn] = useState(!!state.manual)
  const [kind, setKind] = useState<'percent' | 'amount'>(state.manual?.kind ?? 'percent')
  const [pct, setPct] = useState(state.manual?.kind === 'percent' ? String(state.manual.value / 100) : '')
  const [amount, setAmount] = useState<number | null>(state.manual?.kind === 'amount' ? state.manual.value : null)
  const [reason, setReason] = useState(state.manual?.reason ?? '')
  const [approver, setApprover] = useState(state.manual?.approver ?? { username: '', pin: '' })

  const manualValue = kind === 'percent' ? (/^\d{1,3}(\.\d{1,2})?$/.test(pct) ? Math.round(Number(pct) * 100) : 0) : (amount ?? 0)
  const manualValid = !manualOn || (manualValue > 0 && reason.trim().length >= 3)
  const balance = state.member?.pointsBalance ?? 0
  const steps = rules ? Array.from({ length: Math.floor(balance / rules.redeemPoints) }, (_, i) => (i + 1) * rules.redeemPoints).slice(0, 6) : []

  function apply() {
    onChange({
      ...state,
      couponCode: code.trim() || null,
      manual: manualOn && manualValue > 0 ? { kind, value: manualValue, reason: reason.trim(), ...(approver.username && approver.pin ? { approver } : {}) } : null,
    })
    onClose()
  }

  return (
    <Modal title={p.discountTitle} onClose={onClose} width={520}>
      <section className="flex flex-col gap-2">
        <span className="text-sm font-bold">{p.autoPromos}</span>
        {(quote?.promotions ?? []).length === 0 && <span className="text-sm text-muted-foreground">{p.noPromos}</span>}
        {quote?.promotions.map((a) => (
          <div key={a.promotionId} className="flex min-h-12 items-center justify-between gap-2 rounded-2xl bg-success px-3.5 text-sm text-success-foreground">
            <span className="font-semibold">
              {a.name} · −{money(a.discountSatang)}
            </span>
            <button type="button" onClick={() => onChange({ ...state, excludedPromotionIds: [...state.excludedPromotionIds, a.promotionId] })} className="min-h-10 cursor-pointer rounded-full border-0 bg-white px-3 text-[13px] font-semibold text-danger-foreground">
              {p.removePromo}
            </button>
          </div>
        ))}
        {state.excludedPromotionIds.length > 0 && (
          <button type="button" onClick={() => onChange({ ...state, excludedPromotionIds: [] })} className="self-start border-0 bg-transparent text-sm font-semibold text-accent-foreground">
            {p.restorePromos}
          </button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-bold">{p.coupon}</span>
        <div className="flex gap-2">
          <input className={cn(inputClass, 'flex-1 uppercase')} value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
          <OutlineButton className="rounded-[14px]" onClick={() => onChange({ ...state, couponCode: code.trim() || null })}>
            {p.couponApply}
          </OutlineButton>
        </div>
        {quote?.couponError && <span className="text-[13px] font-semibold text-danger-foreground">{p.couponErrors[quote.couponError]}</span>}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold">{p.manual}</span>
          <Toggle checked={manualOn} label={p.manual} onChange={setManualOn} />
        </div>
        {manualOn && (
          <>
            <Segmented label={p.manual} value={kind} onChange={setKind} options={[{ value: 'percent', label: p.manualPercent }, { value: 'amount', label: p.manualAmount }]} />
            {kind === 'percent' ? (
              <input className={inputClass} inputMode="decimal" aria-label={p.manualValue} placeholder="%" value={pct} onChange={(e) => setPct(e.target.value)} />
            ) : (
              <MoneyInput value={amount} onChange={setAmount} ariaLabel={p.manualValue} />
            )}
            <input className={inputClass} placeholder={p.manualReason} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            <div className="flex flex-col gap-2 rounded-2xl bg-warning p-3 text-warning-foreground">
              <span className="text-[13px]">{p.approverNeeded}</span>
              <div className="grid grid-cols-2 gap-2">
                <input className={inputClass} placeholder={t.approval.username} value={approver.username} onChange={(e) => setApprover({ ...approver, username: e.target.value })} />
                <input className={inputClass} placeholder={t.approval.pin} type="password" inputMode="numeric" maxLength={6} value={approver.pin} onChange={(e) => setApprover({ ...approver, pin: e.target.value.replace(/\D/g, '') })} />
              </div>
            </div>
          </>
        )}
      </section>

      {state.member && rules && (
        <section className="flex flex-col gap-2">
          <span className="text-sm font-bold">
            {p.redeem} · {p.redeemRule(rules.redeemPoints, money(rules.redeemValueSatang))}
          </span>
          <div className="flex flex-wrap gap-2">
            {[0, ...steps].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={state.redeemPoints === n}
                onClick={() => onChange({ ...state, redeemPoints: n })}
                className={cn('min-h-11 cursor-pointer rounded-2xl border-2 px-3.5 text-sm font-semibold', state.redeemPoints === n ? 'border-[#9776F6] bg-[#F5F2FE] text-accent-foreground' : 'border-transparent bg-[#F7F5F2]')}
              >
                {n === 0 ? p.redeemNone : p.redeemN(n, money((n / rules.redeemPoints) * rules.redeemValueSatang))}
              </button>
            ))}
          </div>
        </section>
      )}

      <GradientButton size="lg" disabled={!manualValid} onClick={apply}>
        {p.done}
      </GradientButton>
    </Modal>
  )
}
