import { z } from 'zod'
import type { Access, Endpoint } from './api'
import type { AppliedPromo, PromoRules, PromoType } from './promotions'

/** Phase 3 IPC contract — promotions, coupons, members & points (Implement.md §6.9, D21). */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)
const satang = z.number().int().min(0).max(100_000_000_00)
const phone = z.string().trim().regex(/^0\d{8,9}$/)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const optional = (s: z.ZodString) =>
  z
    .string()
    .trim()
    .transform((v) => v || null)
    .pipe(s.nullable())
    .nullable()
    .default(null)

/** Member details beyond phone/name (members page). '' → null. */
export const memberProfile = z.object({
  name: z.string().trim().max(80).nullable().default(null),
  birthDate: optional(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)),
  email: optional(z.string().max(120).email()),
  lineId: optional(z.string().max(60)),
  phone2: optional(z.string().regex(/^0\d{8,9}$/)),
  note: optional(z.string().max(500)),
})

export const approverSchema = z.object({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) })

export const promoRulesSchema = z.object({
  minSpendSatang: satang.optional(),
  categoryIds: z.array(id).max(50).optional(),
  productIds: z.array(id).max(200).optional(),
  buyQty: z.number().int().min(1).max(20).optional(),
  getQty: z.number().int().min(1).max(20).optional(),
  combinable: z.boolean().optional(),
  couponOnly: z.boolean().optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  maxDiscountSatang: satang.optional(),
})

/** Discount inputs shared by pos.quote and pos.checkout. */
export const discountInputs = {
  memberId: id.nullable().default(null),
  couponCode: z.string().trim().max(40).nullable().default(null),
  excludedPromotionIds: z.array(id).max(50).default([]),
  manualDiscount: z
    .object({ kind: z.enum(['percent', 'amount']), value: z.number().int().min(1).max(100_000_000_00), reason: z.string().trim().min(3).max(200), approver: approverSchema.optional() })
    .nullable()
    .default(null),
  redeemPoints: z.number().int().min(0).max(10_000_000).default(0),
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface PromotionDto {
  id: string
  name: string
  type: PromoType
  value: number
  rules: PromoRules
  active: boolean
  startsAt: number | null
  endsAt: number | null
  /** bills that used it */
  usedCount: number
}

export interface CouponDto {
  id: string
  code: string
  promotionId: string
  promotionName: string
  maxUses: number | null
  usedCount: number
  expiresAt: number | null
}

export interface TierDto {
  id: string
  name: string
  minPoints: number
  multiplierMilli: number
}

export interface MemberDto {
  id: string
  /** 081xxx5678 — full numbers are never sent to the screen (PDPA) */
  phoneMasked: string
  name: string | null
  tierName: string | null
  pointsBalance: number
  lifetimePoints: number
  consentAt: number | null
  createdAt: number
  /** YYYY-MM-DD */
  birthDate: string | null
  email: string | null
  lineId: string | null
  /** second phone, masked like the first */
  phone2Masked: string | null
  note: string | null
  /** paid bills (refunded/void excluded) */
  visitCount: number
  totalSpentSatang: number
  lastVisitAt: number | null
}

export interface MemberBillDto {
  id: string
  billNo: string
  paidAt: number
  totalSatang: number
  status: 'paid' | 'void' | 'refunded'
  pointsEarned: number
  pointsRedeemed: number
}

export interface MemberDetailDto {
  member: MemberDto
  bills: { items: MemberBillDto[]; total: number }
}

/** Full phone numbers: only for promo:update, and every reveal is audited (D46). */
export interface MemberContactDto {
  phone: string
  phone2: string | null
}

export interface PointsRulesDto {
  /** spend this much to earn 1 point (satang) */
  earnEverySatang: number
  /** redeem this many points … */
  redeemPoints: number
  /** … for this discount (satang) */
  redeemValueSatang: number
}

export interface QuoteDto {
  subtotalSatang: number
  promotions: AppliedPromo[]
  couponError: 'not_found' | 'expired' | 'used_up' | null
  manualDiscountSatang: number
  pointsDiscountSatang: number
  pointsRedeemed: number
  discountSatang: number
  totalSatang: number
  vatSatang: number
  netSatang: number
  vatMode: 'inclusive' | 'none'
  member: MemberDto | null
  pointsToEarn: number
}

export interface BillDiscountDto {
  kind: 'promotion' | 'coupon' | 'manual' | 'points'
  description: string
  amountSatang: number
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const quoteItems = z
  .array(z.object({ productId: id, sizeId: id.nullable().default(null), qty: z.number().int().min(1).max(999), optionIds: z.array(id).max(30).default([]) }))
  .max(100)

export const promoApi = {
  'promo.list': ep<PromotionDto[]>()('promo:view', z.undefined()),
  'promo.save': ep<PromotionDto>()(
    'promo:update',
    z.object({
      id: id.optional(),
      name: z.string().trim().min(1).max(120),
      type: z.enum(['percent', 'amount', 'buy_x_get_y']),
      value: z.number().int().min(0).max(100_000_000_00),
      rules: promoRulesSchema.default({}),
      active: z.boolean().default(true),
      startsAt: z.number().int().nullable().default(null),
      endsAt: z.number().int().nullable().default(null),
    }),
  ),
  'promo.delete': ep<null>()('promo:delete', z.object({ id })),

  'coupons.list': ep<CouponDto[]>()('promo:view', z.undefined()),
  'coupons.save': ep<CouponDto>()(
    'promo:update',
    z.object({ id: id.optional(), code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/), promotionId: id, maxUses: z.number().int().min(1).nullable().default(null), expiresAt: z.number().int().nullable().default(null) }),
  ),
  'coupons.delete': ep<null>()('promo:delete', z.object({ id })),

  'members.tiers': ep<TierDto[]>()('promo:view', z.undefined()),
  'members.search': ep<MemberDto[]>()('pos:view', z.object({ phone: z.string().trim().regex(/^\d{4,10}$/) })),
  'members.list': ep<{ items: MemberDto[]; total: number }>()(
    'promo:view',
    z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(7), search: z.string().trim().max(20).optional(), tierId: id.optional() }),
  ),
  'members.detail': ep<MemberDetailDto>()('promo:view', z.object({ id, page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(6) })),
  'members.revealContact': ep<MemberContactDto>()('promo:update', z.object({ id })),
  /** Members page: create (consent required) or edit a profile. Omitted phone on edit = unchanged. */
  'members.save': ep<MemberDto>()('promo:update', memberProfile.extend({ id: id.optional(), phone: phone.optional(), consent: z.literal(true).optional() })),
  /** Cashiers register members at the POS; consent is mandatory (PDPA). */
  'members.register': ep<MemberDto>()('pos:create', z.object({ phone, name: z.string().trim().max(80).nullable().default(null), consent: z.literal(true) })),
  'members.adjustPoints': ep<MemberDto>()('promo:update', z.object({ id, delta: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0), reason: z.string().trim().min(3).max(200) })),
  /** PDPA erasure: personal data removed, points history kept anonymously. */
  'members.erase': ep<null>()('promo:delete', z.object({ id, reason: z.string().trim().min(3).max(200) })),
  'members.pointsRules': ep<PointsRulesDto>()('promo:view', z.undefined()),
  'members.savePointsRules': ep<PointsRulesDto>()(
    'promo:update',
    z.object({ earnEverySatang: satang.min(100), redeemPoints: z.number().int().min(1).max(100_000), redeemValueSatang: satang.min(1) }),
  ),

  /** Price preview for the POS: same calculation as checkout (main is authoritative). */
  'pos.quote': ep<QuoteDto>()('pos:view', z.object({ items: quoteItems, ...discountInputs })),
} as const
