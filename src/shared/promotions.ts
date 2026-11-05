import { mulDivHalfUp, type Satang } from './money'

/**
 * Promotion engine (Implement.md §6.9, decision D21). Pure functions shared by the main process
 * (authoritative at checkout) and the POS screen (preview).
 *
 * D21: eligible promotions are applied automatically and the cheapest combination for the customer
 * wins: either the single best non-combinable promotion, or all combinable ones together.
 * Staff may exclude promotions; coupons make coupon-only promotions eligible.
 */

export type PromoType = 'percent' | 'amount' | 'buy_x_get_y'

export interface PromoRules {
  minSpendSatang?: number
  /** limit to these categories / products (empty = all) */
  categoryIds?: string[]
  productIds?: string[]
  /** buy_x_get_y */
  buyQty?: number
  getQty?: number
  /** may be stacked with other combinable promotions */
  combinable?: boolean
  /** only when a coupon for it is entered */
  couponOnly?: boolean
  /** happy hour, Bangkok local time "HH:MM" (end exclusive) */
  startTime?: string
  endTime?: string
  /** 0 = Sunday … 6 = Saturday */
  daysOfWeek?: number[]
  /** percent promotions: maximum discount */
  maxDiscountSatang?: number
}

export interface PromoDef {
  id: string
  name: string
  type: PromoType
  /** percent → basis points, amount → satang, buy_x_get_y → unused */
  value: number
  rules: PromoRules
  active: boolean
  startsAt: number | null
  endsAt: number | null
}

export interface PromoLine {
  productId: string
  categoryId: string | null
  qty: number
  unitPriceSatang: Satang
}

export interface AppliedPromo {
  promotionId: string
  name: string
  discountSatang: Satang
}

const bkkParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function bangkokClock(ms: number): { minutes: number; weekday: number } {
  const p = Object.fromEntries(bkkParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { minutes: Number(p['hour']) * 60 + Number(p['minute']), weekday: WEEKDAY[String(p['weekday'])] ?? 0 }
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function isEligible(p: PromoDef, now: number, coupons: ReadonlySet<string>): boolean {
  if (!p.active) return false
  if (p.startsAt !== null && now < p.startsAt) return false
  if (p.endsAt !== null && now >= p.endsAt) return false
  if (p.rules.couponOnly && !coupons.has(p.id)) return false
  if (p.rules.startTime || p.rules.endTime || p.rules.daysOfWeek?.length) {
    const { minutes, weekday } = bangkokClock(now)
    if (p.rules.daysOfWeek?.length && !p.rules.daysOfWeek.includes(weekday)) return false
    if (p.rules.startTime && minutes < toMinutes(p.rules.startTime)) return false
    if (p.rules.endTime && minutes >= toMinutes(p.rules.endTime)) return false
  }
  return true
}

function matches(p: PromoDef, l: PromoLine): boolean {
  const cats = p.rules.categoryIds ?? []
  const prods = p.rules.productIds ?? []
  if (cats.length && (!l.categoryId || !cats.includes(l.categoryId))) return false
  if (prods.length && !prods.includes(l.productId)) return false
  return true
}

/** Discount a single promotion would give on these lines (0 if conditions are not met). */
export function discountFor(p: PromoDef, lines: readonly PromoLine[]): Satang {
  const eligible = lines.filter((l) => matches(p, l))
  const base = eligible.reduce((s, l) => s + l.unitPriceSatang * l.qty, 0)
  if (base <= 0 || base < (p.rules.minSpendSatang ?? 0)) return 0
  let d = 0
  if (p.type === 'percent') {
    d = mulDivHalfUp(base, Math.min(p.value, 10_000), 10_000)
    if (p.rules.maxDiscountSatang !== undefined) d = Math.min(d, p.rules.maxDiscountSatang)
  } else if (p.type === 'amount') {
    d = Math.min(p.value, base)
  } else {
    const buy = p.rules.buyQty ?? 0
    const get = p.rules.getQty ?? 0
    if (buy < 1 || get < 1) return 0
    const units = eligible.flatMap((l) => Array.from({ length: l.qty }, () => l.unitPriceSatang)).sort((a, b) => b - a)
    const group = buy + get
    for (let i = 0; i + group <= units.length; i += group) {
      for (let k = i + buy; k < i + group; k++) d += units[k]!
    }
  }
  return Math.max(0, Math.min(d, base))
}

/** D21: the combination with the largest total discount, capped at the subtotal. */
export function bestPromotions(
  promos: readonly PromoDef[],
  lines: readonly PromoLine[],
  now: number,
  opts: { coupons: ReadonlySet<string>; excluded: ReadonlySet<string> },
): { applied: AppliedPromo[]; totalSatang: Satang } {
  const subtotal = lines.reduce((s, l) => s + l.unitPriceSatang * l.qty, 0)
  const candidates = promos
    .filter((p) => !opts.excluded.has(p.id) && isEligible(p, now, opts.coupons))
    .map((p) => ({ p, d: discountFor(p, lines) }))
    .filter((c) => c.d > 0)

  const options: { p: PromoDef; d: number }[][] = candidates.filter((c) => !c.p.rules.combinable).map((c) => [c])
  const stack = candidates.filter((c) => c.p.rules.combinable)
  if (stack.length) options.push(stack)

  let best: { p: PromoDef; d: number }[] = []
  let bestTotal = 0
  for (const o of options) {
    const total = Math.min(subtotal, o.reduce((s, c) => s + c.d, 0))
    if (total > bestTotal || (total === bestTotal && o.length < best.length)) {
      best = o
      bestTotal = total
    }
  }

  // cap: later promotions in the stack give up what exceeds the subtotal
  let left = bestTotal
  const applied: AppliedPromo[] = []
  for (const c of best) {
    const take = Math.min(c.d, left)
    if (take <= 0) break
    applied.push({ promotionId: c.p.id, name: c.p.name, discountSatang: take })
    left -= take
  }
  return { applied, totalSatang: bestTotal }
}
