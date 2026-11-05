import { describe, expect, it } from 'vitest'
import { bestPromotions, discountFor, isEligible, type PromoDef, type PromoLine } from '@shared/promotions'

const T = Date.UTC(2026, 10, 5, 8, 0) // Thu 05/11/2026 15:00 Bangkok
const promo = (p: Partial<PromoDef> & Pick<PromoDef, 'id' | 'type'>): PromoDef => ({
  name: p.id,
  value: 0,
  rules: {},
  active: true,
  startsAt: null,
  endsAt: null,
  ...p,
})
const lines: PromoLine[] = [
  { productId: 'tea', categoryId: 'cold', qty: 2, unitPriceSatang: 5_500 }, // 110
  { productId: 'latte', categoryId: 'hot', qty: 1, unitPriceSatang: 6_000 }, // 60
  { productId: 'croissant', categoryId: 'bakery', qty: 1, unitPriceSatang: 4_500 }, // 45
]

describe('eligibility', () => {
  it('honours active flag, date range, coupon-only and exclusions', () => {
    const p = promo({ id: 'p', type: 'percent', value: 1_000 })
    expect(isEligible(p, T, new Set())).toBe(true)
    expect(isEligible({ ...p, active: false }, T, new Set())).toBe(false)
    expect(isEligible({ ...p, startsAt: T + 1 }, T, new Set())).toBe(false)
    expect(isEligible({ ...p, endsAt: T }, T, new Set())).toBe(false) // end is exclusive
    expect(isEligible({ ...p, rules: { couponOnly: true } }, T, new Set())).toBe(false)
    expect(isEligible({ ...p, rules: { couponOnly: true } }, T, new Set(['p']))).toBe(true)
  })

  it('applies happy-hour windows and weekdays in Bangkok time', () => {
    const hh = promo({ id: 'hh', type: 'percent', value: 2_000, rules: { startTime: '14:00', endTime: '16:00' } })
    expect(isEligible(hh, T, new Set())).toBe(true) // 15:00
    expect(isEligible(hh, T + 2 * 3_600_000, new Set())).toBe(false) // 17:00
    expect(isEligible({ ...hh, rules: { daysOfWeek: [4] } }, T, new Set())).toBe(true) // Thursday
    expect(isEligible({ ...hh, rules: { daysOfWeek: [0, 6] } }, T, new Set())).toBe(false)
  })
})

describe('discount amounts', () => {
  it('percent on matching categories, half-up, with a cap', () => {
    expect(discountFor(promo({ id: 'a', type: 'percent', value: 1_000, rules: { categoryIds: ['cold'] } }), lines)).toBe(1_100)
    expect(discountFor(promo({ id: 'a', type: 'percent', value: 1_250 }), lines)).toBe(2_688) // 215 × 12.5% = 26.875
    expect(discountFor(promo({ id: 'a', type: 'percent', value: 5_000, rules: { maxDiscountSatang: 5_000 } }), lines)).toBe(5_000)
  })

  it('amount off with a minimum spend on the eligible items', () => {
    const p = promo({ id: 'b', type: 'amount', value: 2_000, rules: { minSpendSatang: 10_000 } })
    expect(discountFor(p, lines)).toBe(2_000)
    expect(discountFor({ ...p, rules: { minSpendSatang: 10_000, categoryIds: ['hot'] } }, lines)).toBe(0) // only 60 baht hot
    expect(discountFor(promo({ id: 'c', type: 'amount', value: 99_999 }), lines)).toBe(21_500) // never more than the items
  })

  it('buy X get Y: the cheapest unit(s) of each complete group are free', () => {
    const b2g1 = promo({ id: 'x', type: 'buy_x_get_y', rules: { buyQty: 2, getQty: 1 } })
    // units sorted by price: 60, 55, 55 | 45 → first group frees one 55; the lone 45 is not a full group
    expect(discountFor(b2g1, lines)).toBe(5_500)
    // 6 cups at 50 → two groups → two free
    expect(discountFor(b2g1, [{ productId: 'tea', categoryId: 'cold', qty: 6, unitPriceSatang: 5_000 }])).toBe(10_000)
    // limited to the promotion's products
    expect(discountFor({ ...b2g1, rules: { buyQty: 2, getQty: 1, productIds: ['croissant'] } }, lines)).toBe(0)
  })
})

describe('best combination (D21)', () => {
  const pct = promo({ id: 'pct10', type: 'percent', value: 1_000 }) // 21.50
  const amt = promo({ id: 'amt30', type: 'amount', value: 3_000 }) // 30.00 (not combinable)
  const c1 = promo({ id: 'c1', type: 'amount', value: 1_500, rules: { combinable: true } })
  const c2 = promo({ id: 'c2', type: 'amount', value: 2_000, rules: { combinable: true } })

  it('picks the single best non-combinable promotion', () => {
    const r = bestPromotions([pct, amt], lines, T, { coupons: new Set(), excluded: new Set() })
    expect(r.applied).toEqual([{ promotionId: 'amt30', name: 'amt30', discountSatang: 3_000 }])
  })

  it('stacks combinable promotions when that is better', () => {
    const r = bestPromotions([pct, amt, c1, c2], lines, T, { coupons: new Set(), excluded: new Set() })
    expect(r.applied.map((a) => a.promotionId)).toEqual(['c1', 'c2'])
    expect(r.totalSatang).toBe(3_500)
  })

  it('lets staff remove a promotion; never discounts more than the subtotal', () => {
    const r = bestPromotions([pct, amt, c1, c2], lines, T, { coupons: new Set(), excluded: new Set(['c2']) })
    expect(r.applied.map((a) => a.promotionId)).toEqual(['amt30'])
    const huge = [promo({ id: 'h1', type: 'amount', value: 20_000, rules: { combinable: true } }), promo({ id: 'h2', type: 'amount', value: 20_000, rules: { combinable: true } })]
    const r2 = bestPromotions(huge, lines, T, { coupons: new Set(), excluded: new Set() })
    expect(r2.totalSatang).toBe(21_500)
    expect(r2.applied.reduce((s, a) => s + a.discountSatang, 0)).toBe(21_500)
  })

  it('returns nothing when nothing applies', () => {
    expect(bestPromotions([], lines, T, { coupons: new Set(), excluded: new Set() })).toEqual({ applied: [], totalSatang: 0 })
  })
})
