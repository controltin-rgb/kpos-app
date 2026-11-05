import { allocateSatang, vatInclusive, type Satang } from './money'

export type VatType = 'vat7' | 'vat0' | 'exempt'
export type VatMode = 'inclusive' | 'none'

export interface TotalsLineInput {
  /** price per unit including modifiers, VAT included (D15) */
  unitPriceSatang: Satang
  qty: number
  vatType: VatType
}

export interface TotalsLine {
  gross: Satang
  discount: Satang
  total: Satang
}

export interface BillTotals {
  lines: TotalsLine[]
  subtotal: Satang
  discount: Satang
  total: Satang
  vat: Satang
  /** total − vat */
  net: Satang
  vatMode: VatMode
}

/**
 * Bill totals (D9, D15): prices include VAT when the configured rate > 0, none at rate 0.
 * VAT is extracted ONCE from the sum of VAT-able lines after discount (ป. 86/2542 rounding in money.ts).
 * A bill-level discount is spread over lines by gross amount (largest remainder) so line totals add up exactly.
 */
export function computeBillTotals(input: { lines: readonly TotalsLineInput[]; billDiscountSatang?: Satang; vatRateBp: number }): BillTotals {
  const gross = input.lines.map((l) => {
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw new RangeError('qty must be a positive integer')
    if (!Number.isSafeInteger(l.unitPriceSatang) || l.unitPriceSatang < 0) throw new RangeError('price must be >= 0 satang')
    return l.unitPriceSatang * l.qty
  })
  const subtotal = gross.reduce((a, b) => a + b, 0)
  const discount = input.billDiscountSatang ?? 0
  if (!Number.isSafeInteger(discount) || discount < 0 || discount > subtotal) throw new RangeError('discount out of range')

  const lineDiscounts = discount === 0 || subtotal === 0 ? gross.map(() => 0) : allocateSatang(discount, gross)
  const lines = gross.map((g, i) => ({ gross: g, discount: lineDiscounts[i]!, total: g - lineDiscounts[i]! }))
  const total = subtotal - discount

  const vatMode: VatMode = input.vatRateBp > 0 ? 'inclusive' : 'none'
  const vatBase = lines.reduce((s, l, i) => (input.lines[i]!.vatType === 'vat7' ? s + l.total : s), 0)
  const vat = vatMode === 'none' ? 0 : vatInclusive(vatBase, input.vatRateBp).vat
  return { lines, subtotal, discount, total, vat, net: total - vat, vatMode }
}
