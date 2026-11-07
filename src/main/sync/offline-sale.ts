import type { Input, SessionUser } from '@shared/api'
import type { QuoteDto } from '@shared/api-promo'
import type { BillDetailDto, ShiftSummaryDto } from '@shared/api-sales'
import { formatBillNo } from '@shared/bill-number'
import { AppError } from '@shared/errors'
import { percentOfSatang } from '@shared/money'
import { priceLine, type PricedLine } from '@shared/pricing'
import { bestPromotions } from '@shared/promotions'
import { computeBillTotals, type BillTotals } from '@shared/sale-totals'
import type { OfflineBill, SyncSnapshot } from '@shared/sync'

type CheckoutInput = Input<'pos.checkout'>
type QuoteInput = Input<'pos.quote'>

/** Coupons, members/points and manual discounts need the Host (D37). */
function assertOfflineDiscounts(d: { memberId?: string | null | undefined; couponCode?: string | null | undefined; manualDiscount?: unknown; redeemPoints?: number | undefined }) {
  if (d.memberId || d.couponCode || d.manualDiscount || (d.redeemPoints ?? 0) > 0) throw new AppError('OFFLINE_NOT_SUPPORTED')
}

interface Priced {
  lines: PricedLine[]
  promotions: { promotionId: string; name: string; discountSatang: number }[]
  totals: BillTotals
}

/** Same rules as the Host (shared/pricing + shared/promotions + shared/sale-totals), from the synced copy. */
function priceCart(snap: SyncSnapshot, items: CheckoutInput['items'], excluded: readonly string[], now: number): Priced {
  const products = new Map(snap.products.map((p) => [p.id, p]))
  const lines = items.map((i) => priceLine(products.get(i.productId), { productId: i.productId, sizeId: i.sizeId ?? null, qty: i.qty, optionIds: i.optionIds ?? [], note: i.note ?? null }))
  const best = bestPromotions(
    snap.promotions,
    lines.map((l) => ({ productId: l.productId, categoryId: l.categoryId, qty: l.qty, unitPriceSatang: l.unitPriceSatang })),
    now,
    { coupons: new Set(), excluded: new Set(excluded) },
  )
  const totals = computeBillTotals({
    lines: lines.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })),
    billDiscountSatang: best.totalSatang,
    vatRateBp: snap.settings.vatRateBp,
  })
  return { lines, promotions: best.applied, totals }
}

export function offlineQuote(snap: SyncSnapshot, input: QuoteInput, now: number): QuoteDto {
  assertOfflineDiscounts(input)
  const p = priceCart(snap, input.items, input.excludedPromotionIds ?? [], now)
  return {
    subtotalSatang: p.totals.subtotal,
    promotions: p.promotions,
    couponError: null,
    manualDiscountSatang: 0,
    pointsDiscountSatang: 0,
    pointsRedeemed: 0,
    discountSatang: p.totals.discount,
    totalSatang: p.totals.total,
    vatSatang: p.totals.vat,
    netSatang: p.totals.net,
    vatMode: p.totals.vatMode,
    member: null,
    pointsToEarn: 0,
  }
}

/**
 * Builds a bill sold while the Host is down: the queued payload for the Host and the detail the POS
 * shows / prints right away. The caller supplies the reserved bill number.
 */
export function buildOfflineSale(
  snap: SyncSnapshot,
  input: CheckoutInput,
  ctx: { user: SessionUser; shift: ShiftSummaryDto; number: { blockId: string; period: string; prefix: string; seq: number }; now: number },
): { bill: OfflineBill; detail: BillDetailDto } {
  assertOfflineDiscounts(input)
  const channel = input.channel ?? null
  if ((input.orderType === 'delivery') !== (channel !== null)) throw new AppError('INVALID_INPUT', { fields: { channel: ['required for delivery only'] } })
  if (input.payment.method === 'delivery' && input.orderType !== 'delivery') throw new AppError('PAYMENT_INVALID')
  if (input.payment.method === 'promptpay' && !snap.settings.promptPayId) throw new AppError('PROMPTPAY_NOT_CONFIGURED')

  const p = priceCart(snap, input.items, input.excludedPromotionIds ?? [], ctx.now)
  const total = p.totals.total
  if (total <= 0) throw new AppError('PAYMENT_INVALID', { reason: 'zero_total' })
  const pay = input.payment
  let tendered: number | null = null
  let change: number | null = null
  if (pay.method === 'cash') {
    if (pay.tenderedSatang < total) throw new AppError('PAYMENT_INSUFFICIENT', { totalSatang: total })
    tendered = pay.tenderedSatang
    change = pay.tenderedSatang - total
  }
  const billNo = formatBillNo(ctx.number.prefix, snap.settings.billPolicy, ctx.number.period, ctx.number.seq)
  const commissionBp = input.commissionBp ?? null
  const reference = 'reference' in pay ? (pay.reference ?? null) : null

  const bill: OfflineBill = {
    id: input.requestId,
    billNo,
    blockId: ctx.number.blockId,
    period: ctx.number.period,
    seq: ctx.number.seq,
    createdAt: ctx.now,
    userId: ctx.user.userId,
    shiftId: ctx.shift.id,
    orderType: input.orderType,
    channel,
    extOrderId: input.extOrderId ?? null,
    commissionBp,
    lines: p.lines,
    promotions: p.promotions,
    vatRateBp: snap.settings.vatRateBp,
    totalSatang: total,
    payment:
      pay.method === 'cash'
        ? { method: 'cash', tenderedSatang: pay.tenderedSatang }
        : pay.method === 'promptpay'
          ? { method: 'promptpay', confirmed: true, reference }
          : pay.method === 'delivery'
            ? { method: 'delivery' }
            : { method: pay.method, reference },
  }

  const detail: BillDetailDto = {
    id: bill.id,
    billNo,
    status: 'paid',
    orderType: input.orderType,
    channel,
    totalSatang: total,
    paymentMethod: pay.method,
    createdAt: ctx.now,
    createdByName: ctx.user.displayName,
    itemCount: p.lines.reduce((s, l) => s + l.qty, 0),
    shiftId: ctx.shift.id,
    extOrderId: input.extOrderId ?? null,
    subtotalSatang: p.totals.subtotal,
    discountSatang: p.totals.discount,
    vatSatang: p.totals.vat,
    vatMode: p.totals.vatMode,
    commissionBp,
    commissionSatang: commissionBp !== null ? percentOfSatang(total, commissionBp) : null,
    items: p.lines.map((l, i) => ({
      id: `${bill.id}:${i + 1}`,
      lineNo: i + 1,
      productName: l.productName,
      sizeLabel: l.sizeLabel,
      qty: l.qty,
      unitPriceSatang: l.unitPriceSatang,
      discountSatang: p.totals.lines[i]!.discount,
      lineTotalSatang: p.totals.lines[i]!.total,
      modifiers: l.modifiers.map((m) => ({ groupName: m.groupName, optionName: m.optionName, priceSatang: m.priceSatang })),
      note: l.note,
    })),
    payments: [{ method: pay.method, amountSatang: total, tenderedSatang: tendered, changeSatang: change, reference, confirmedByName: ctx.user.displayName }],
    events: [{ event: 'created', at: ctx.now, userName: ctx.user.displayName, approverName: null, reason: null }],
    voidReason: null,
    voidable: false, // void needs the Host (D36)
    discounts: p.promotions.map((a) => ({ kind: 'promotion' as const, description: a.name, amountSatang: a.discountSatang })),
    member: null,
  }
  return { bill, detail }
}
