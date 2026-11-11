import { can, type Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { UsersRepo } from '@main/db/repos/users.repo'
import type { ParsedInput } from '@shared/api'
import type { CouponDto, MemberBillDto, MemberContactDto, MemberDetailDto, MemberDto, PointsRulesDto, PromotionDto, TierDto } from '@shared/api-promo'
import { AppError } from '@shared/errors'
import { FULL_FEATURES, type FeatureSource } from '@shared/license'
import { uuidv7 } from '@shared/id'
import { mulDivHalfUp, percentOfSatang } from '@shared/money'
import { bestPromotions, type AppliedPromo, type PromoDef, type PromoLine, type PromoRules } from '@shared/promotions'
import type { AuditService } from './audit.service'
import type { SettingsService } from './settings.service'

/** Default tiers (Promo prototype: เงิน / ทอง / แพลทินัม), by lifetime points. Editable later. */
const DEFAULT_TIERS = [
  { name: 'เงิน', min: 0, mult: 1000 },
  { name: 'ทอง', min: 500, mult: 1250 },
  { name: 'แพลทินัม', min: 2000, mult: 1500 },
]

export const maskPhone = (p: string) => (p.length >= 7 ? `${p.slice(0, 3)}xxx${p.slice(-4)}` : 'xxx')

interface MemberRow {
  id: string
  branch_id: string
  phone: string
  name: string | null
  tier_id: string | null
  points_balance: number
  lifetime_points: number
  consent_at: number | null
  created_at: number
  deleted_at: number | null
  birth_date: string | null
  email: string | null
  line_id: string | null
  phone2: string | null
  note: string | null
  /** joined by memberSelect */
  visit_count?: number
  total_spent?: number
  last_visit?: number | null
}

/** members + purchase stats from paid bills */
const MEMBER_SELECT = `SELECT m.*,
  (SELECT count(*) FROM bills b WHERE b.member_id = m.id AND b.status = 'paid') AS visit_count,
  (SELECT coalesce(sum(b.total_satang), 0) FROM bills b WHERE b.member_id = m.id AND b.status = 'paid') AS total_spent,
  (SELECT max(b.paid_at) FROM bills b WHERE b.member_id = m.id AND b.status = 'paid') AS last_visit
FROM members m`

export interface DiscountInput {
  memberId: string | null
  couponCode: string | null
  excludedPromotionIds: string[]
  manualDiscount: { kind: 'percent' | 'amount'; value: number; reason: string; approver?: { username: string; pin: string } | undefined } | null
  redeemPoints: number
}

export interface PricedDiscounts {
  subtotal: number
  promotions: (AppliedPromo & { couponId: string | null })[]
  couponId: string | null
  couponError: 'not_found' | 'expired' | 'used_up' | null
  manual: { amount: number; description: string; approvedBy: string | null } | null
  points: { redeemed: number; amount: number }
  discountSatang: number
  member: MemberRow | null
  tierMultMilli: number
}

/**
 * Promotions, coupons, members and points (Implement.md §6.9).
 * `price()` is the single discount calculation used by both pos.quote and checkout; the order is
 * automatic promotions (D21) → manual discount (pos:discount within the role limit, else approver PIN)
 * → point redemption. The total discount never exceeds the subtotal.
 */
export class PromoService {
  private readonly users: UsersRepo

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
    private readonly features: FeatureSource = () => FULL_FEATURES,
  ) {
    this.users = new UsersRepo(db)
  }

  /** Members cap of the license (D51); 0 = unlimited. Existing members stay usable when the cap is lowered. */
  private assertMemberCap(): void {
    const cap = this.features().maxMembers
    if (cap > 0 && (this.db.prepare('SELECT count(*) FROM members WHERE deleted_at IS NULL').pluck().get() as number) >= cap) throw new AppError('MEMBER_CAP_REACHED', { cap })
  }

  // ===========================================================================
  // promotions
  // ===========================================================================

  /** Promotion definitions of the branch (also copied to Clients for offline sales). */
  defs(branchId: string): (PromoDef & { usedCount: number })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT count(DISTINCT d.bill_id) FROM bill_discounts d JOIN bills b ON b.id = d.bill_id WHERE d.promotion_id = p.id AND b.status = 'paid') AS used
         FROM promotions p WHERE p.branch_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at`,
      )
      .all(branchId) as { id: string; name: string; type: PromoDef['type']; value: number; rules_json: string; active: number; starts_at: number | null; ends_at: number | null; used: number }[]
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, value: r.value, rules: JSON.parse(r.rules_json) as PromoRules, active: r.active === 1, startsAt: r.starts_at, endsAt: r.ends_at, usedCount: r.used }))
  }

  promotions(actor: Actor): PromotionDto[] {
    return this.defs(actor.branchId)
  }

  savePromotion(actor: Actor, input: ParsedInput<'promo.save'>): PromotionDto {
    if (input.type === 'percent' && input.value > 10_000) throw new AppError('INVALID_INPUT', { fields: { value: ['max_100_percent'] } })
    if (input.type === 'buy_x_get_y' && (!input.rules.buyQty || !input.rules.getQty)) throw new AppError('INVALID_INPUT', { fields: { rules: ['buy_get_required'] } })
    if (input.startsAt !== null && input.endsAt !== null && input.endsAt <= input.startsAt) throw new AppError('INVALID_INPUT', { fields: { endsAt: ['before_start'] } })
    const at = this.now()
    let id = input.id
    this.db.transaction(() => {
      const row = { name: input.name, type: input.type, value: input.type === 'buy_x_get_y' ? 0 : input.value, rules_json: JSON.stringify(input.rules), active: input.active ? 1 : 0, starts_at: input.startsAt, ends_at: input.endsAt }
      const before = id ? this.defs(actor.branchId).find((p) => p.id === id) : null
      if (id) {
        if (!before) throw new AppError('NOT_FOUND')
        this.db
          .prepare('UPDATE promotions SET name = @name, type = @type, value = @value, rules_json = @rules_json, active = @active, starts_at = @starts_at, ends_at = @ends_at, updated_at = @at, rev = rev + 1 WHERE id = @id')
          .run({ ...row, at, id })
      } else {
        id = uuidv7(at)
        this.db
          .prepare(
            `INSERT INTO promotions (id, branch_id, name, type, value, rules_json, active, starts_at, ends_at, created_at, updated_at)
             VALUES (@id, @b, @name, @type, @value, @rules_json, @active, @starts_at, @ends_at, @at, @at)`,
          )
          .run({ ...row, id, b: actor.branchId, at })
      }
      this.audit.append({ action: before ? 'promo.update' : 'promo.create', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'promotions', entityId: id, before, after: input, risk: 'medium' })
    }).immediate()
    return this.promotions(actor).find((p) => p.id === id)!
  }

  deletePromotion(actor: Actor, id: string): void {
    const at = this.now()
    this.db.transaction(() => {
      const r = this.db.prepare('UPDATE promotions SET deleted_at = ?, active = 0, updated_at = ? WHERE id = ? AND branch_id = ? AND deleted_at IS NULL').run(at, at, id, actor.branchId)
      if (!r.changes) throw new AppError('NOT_FOUND')
      this.audit.append({ action: 'promo.delete', permission: 'promo:delete', userId: actor.userId, branchId: actor.branchId, entity: 'promotions', entityId: id, risk: 'medium' })
    }).immediate()
  }

  // ===========================================================================
  // coupons
  // ===========================================================================

  coupons(actor: Actor): CouponDto[] {
    return (
      this.db
        .prepare(
          `SELECT c.*, p.name AS promotion_name FROM coupons c JOIN promotions p ON p.id = c.promotion_id
           WHERE c.branch_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC`,
        )
        .all(actor.branchId) as { id: string; code: string; promotion_id: string; promotion_name: string; max_uses: number | null; used_count: number; expires_at: number | null }[]
    ).map((c) => ({ id: c.id, code: c.code, promotionId: c.promotion_id, promotionName: c.promotion_name, maxUses: c.max_uses, usedCount: c.used_count, expiresAt: c.expires_at }))
  }

  saveCoupon(actor: Actor, input: ParsedInput<'coupons.save'>): CouponDto {
    if (!this.defs(actor.branchId).some((p) => p.id === input.promotionId)) throw new AppError('NOT_FOUND', { entity: 'promotions' })
    const at = this.now()
    let id = input.id
    const code = input.code.toUpperCase()
    this.db.transaction(() => {
      const dup = this.db.prepare('SELECT id FROM coupons WHERE branch_id = ? AND code = ? AND deleted_at IS NULL AND id IS NOT ?').get(actor.branchId, code, id ?? null)
      if (dup) throw new AppError('INVALID_INPUT', { fields: { code: ['duplicate'] } })
      if (id) {
        const r = this.db.prepare('UPDATE coupons SET code = ?, promotion_id = ?, max_uses = ?, expires_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND branch_id = ?').run(code, input.promotionId, input.maxUses, input.expiresAt, at, id, actor.branchId)
        if (!r.changes) throw new AppError('NOT_FOUND')
      } else {
        id = uuidv7(at)
        this.db.prepare('INSERT INTO coupons (id, branch_id, promotion_id, code, max_uses, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, actor.branchId, input.promotionId, code, input.maxUses, input.expiresAt, at, at)
      }
      this.audit.append({ action: 'coupons.save', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'coupons', entityId: id, after: { ...input, code } })
    }).immediate()
    return this.coupons(actor).find((c) => c.id === id)!
  }

  deleteCoupon(actor: Actor, id: string): void {
    const at = this.now()
    this.db.transaction(() => {
      const r = this.db.prepare('UPDATE coupons SET deleted_at = ?, updated_at = ? WHERE id = ? AND branch_id = ? AND deleted_at IS NULL').run(at, at, id, actor.branchId)
      if (!r.changes) throw new AppError('NOT_FOUND')
      this.audit.append({ action: 'coupons.delete', permission: 'promo:delete', userId: actor.userId, branchId: actor.branchId, entity: 'coupons', entityId: id })
    }).immediate()
  }

  private findCoupon(branchId: string, code: string) {
    return this.db.prepare('SELECT * FROM coupons WHERE branch_id = ? AND code = ? AND deleted_at IS NULL').get(branchId, code.toUpperCase()) as
      | { id: string; promotion_id: string; max_uses: number | null; used_count: number; expires_at: number | null }
      | undefined
  }

  // ===========================================================================
  // members & points
  // ===========================================================================

  tiers(actor: Actor): TierDto[] {
    const list = () =>
      (this.db.prepare('SELECT * FROM member_tiers WHERE branch_id = ? AND deleted_at IS NULL ORDER BY min_points').all(actor.branchId) as { id: string; name: string; min_points: number; points_multiplier_milli: number }[]).map(
        (t) => ({ id: t.id, name: t.name, minPoints: t.min_points, multiplierMilli: t.points_multiplier_milli }),
      )
    let rows = list()
    if (!rows.length) {
      const at = this.now()
      this.db.transaction(() => {
        DEFAULT_TIERS.forEach((t, i) =>
          this.db
            .prepare('INSERT INTO member_tiers (id, branch_id, name, min_points, points_multiplier_milli, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(uuidv7(at), actor.branchId, t.name, t.min, t.mult, i, at, at),
        )
      }).immediate()
      rows = list()
    }
    return rows
  }

  private tierFor(actor: Actor, lifetime: number): TierDto | null {
    return [...this.tiers(actor)].reverse().find((t) => lifetime >= t.minPoints) ?? null
  }

  private member(id: string): MemberRow | undefined {
    return this.db.prepare(`${MEMBER_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`).get(id) as MemberRow | undefined
  }

  memberDto(actor: Actor, m: MemberRow): MemberDto {
    return {
      id: m.id,
      phoneMasked: maskPhone(m.phone),
      name: m.name,
      tierName: this.tierFor(actor, m.lifetime_points)?.name ?? null,
      pointsBalance: m.points_balance,
      lifetimePoints: m.lifetime_points,
      consentAt: m.consent_at,
      createdAt: m.created_at,
      birthDate: m.birth_date,
      email: m.email,
      lineId: m.line_id,
      phone2Masked: m.phone2 ? maskPhone(m.phone2) : null,
      note: m.note,
      visitCount: m.visit_count ?? 0,
      totalSpentSatang: m.total_spent ?? 0,
      lastVisitAt: m.last_visit ?? null,
    }
  }

  search(actor: Actor, phone: string): MemberDto[] {
    return (this.db.prepare(`${MEMBER_SELECT} WHERE m.deleted_at IS NULL AND m.phone LIKE ? ORDER BY m.phone LIMIT 7`).all(`${phone}%`) as MemberRow[]).map((m) => this.memberDto(actor, m))
  }

  list(actor: Actor, q: ParsedInput<'members.list'>) {
    const tiers = this.tiers(actor)
    const rows = this.db
      .prepare(`${MEMBER_SELECT} WHERE m.deleted_at IS NULL ${q.search ? `AND (m.phone LIKE @q OR m.phone2 LIKE @q OR m.name LIKE @n OR m.line_id LIKE @n)` : ''} ORDER BY m.lifetime_points DESC, m.created_at`)
      .all({ q: `${q.search ?? ''}%`, n: `%${q.search ?? ''}%` }) as MemberRow[]
    const filtered = q.tierId ? rows.filter((m) => this.tierFor(actor, m.lifetime_points)?.id === q.tierId) : rows
    void tiers
    return { items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((m) => this.memberDto(actor, m)), total: filtered.length }
  }

  register(actor: Actor, input: ParsedInput<'members.register'>): MemberDto {
    const at = this.now()
    const id = uuidv7(at)
    this.db.transaction(() => {
      this.assertMemberCap()
      if (this.db.prepare('SELECT 1 FROM members WHERE phone = ? AND deleted_at IS NULL').get(input.phone)) throw new AppError('INVALID_INPUT', { fields: { phone: ['duplicate'] } })
      this.db
        .prepare('INSERT INTO members (id, branch_id, phone, name, consent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, actor.branchId, input.phone, input.name, at, at, at)
      this.audit.append({ action: 'members.register', permission: 'pos:create', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, after: { phone: maskPhone(input.phone), consent: true } })
    }).immediate()
    return this.memberDto(actor, this.member(id)!)
  }

  /** Members page: create with consent, or edit the profile. Audited with masked contact data. */
  save(actor: Actor, input: ParsedInput<'members.save'>): MemberDto {
    const at = this.now()
    const id = input.id ?? uuidv7(at)
    const view = (m: { phone: string; name: string | null; birth_date: string | null; email: string | null; line_id: string | null; phone2: string | null; note: string | null }) => ({
      phone: maskPhone(m.phone),
      name: m.name,
      birthDate: m.birth_date,
      email: m.email,
      lineId: m.line_id,
      phone2: m.phone2 ? maskPhone(m.phone2) : null,
      note: m.note,
    })
    this.db.transaction(() => {
      const before = input.id ? this.member(input.id) : undefined
      if (input.id && !before) throw new AppError('NOT_FOUND')
      if (!before && (!input.phone || !input.consent)) throw new AppError('INVALID_INPUT', { fields: { [input.phone ? 'consent' : 'phone']: ['required'] } })
      const phone = input.phone ?? before!.phone
      if (this.db.prepare('SELECT 1 FROM members WHERE phone = ? AND deleted_at IS NULL AND id <> ?').get(phone, id)) throw new AppError('INVALID_INPUT', { fields: { phone: ['duplicate'] } })
      const row = { phone, name: input.name, birth_date: input.birthDate, email: input.email, line_id: input.lineId, phone2: input.phone2, note: input.note }
      if (before) {
        this.db
          .prepare('UPDATE members SET phone = @phone, name = @name, birth_date = @birth_date, email = @email, line_id = @line_id, phone2 = @phone2, note = @note, updated_at = @at, rev = rev + 1 WHERE id = @id')
          .run({ ...row, at, id })
        this.audit.append({ action: 'members.update', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, before: view(before), after: view(row), risk: 'low' })
      } else {
        this.assertMemberCap()
        this.db
          .prepare(
            'INSERT INTO members (id, branch_id, phone, name, birth_date, email, line_id, phone2, note, consent_at, created_at, updated_at) VALUES (@id, @branch, @phone, @name, @birth_date, @email, @line_id, @phone2, @note, @at, @at, @at)',
          )
          .run({ ...row, id, branch: actor.branchId, at })
        this.audit.append({ action: 'members.register', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, after: { ...view(row), consent: true } })
      }
    }).immediate()
    return this.memberDto(actor, this.member(id)!)
  }

  /** Profile + purchase history (newest first). */
  detail(actor: Actor, id: string, page: number, pageSize: number): MemberDetailDto {
    const m = this.member(id)
    if (!m) throw new AppError('NOT_FOUND')
    const total = this.db.prepare('SELECT count(*) FROM bills WHERE member_id = ? AND paid_at IS NOT NULL').pluck().get(id) as number
    const items = (
      this.db
        .prepare('SELECT id, bill_no, paid_at, total_satang, status, points_earned, points_redeemed FROM bills WHERE member_id = ? AND paid_at IS NOT NULL ORDER BY paid_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(id, pageSize, (page - 1) * pageSize) as { id: string; bill_no: string; paid_at: number; total_satang: number; status: MemberBillDto['status']; points_earned: number; points_redeemed: number }[]
    ).map((b) => ({ id: b.id, billNo: b.bill_no, paidAt: b.paid_at, totalSatang: b.total_satang, status: b.status, pointsEarned: b.points_earned, pointsRedeemed: b.points_redeemed }))
    return { member: this.memberDto(actor, m), bills: { items, total } }
  }

  /** Full phone numbers for staff who manage members; each reveal is in the audit log (PDPA). */
  revealContact(actor: Actor, id: string): MemberContactDto {
    const m = this.member(id)
    if (!m) throw new AppError('NOT_FOUND')
    this.audit.append({ action: 'members.reveal_contact', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, after: { phone: maskPhone(m.phone) }, risk: 'medium' })
    return { phone: m.phone, phone2: m.phone2 }
  }

  adjustPoints(actor: Actor, id: string, delta: number, reason: string): MemberDto {
    const at = this.now()
    this.db.transaction(() => {
      const m = this.member(id)
      if (!m) throw new AppError('NOT_FOUND')
      if (m.points_balance + delta < 0) throw new AppError('POINTS_INSUFFICIENT', { balance: m.points_balance })
      this.addPoints(m.id, delta, 'adjust', 'manual', null, null, actor.userId, at, false)
      this.audit.append({ action: 'members.adjust_points', permission: 'promo:update', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, before: { points: m.points_balance }, after: { points: m.points_balance + delta }, reason, risk: 'medium' })
    }).immediate()
    return this.memberDto(actor, this.member(id)!)
  }

  /** PDPA erasure: phone and name removed; the anonymous points history stays for accounting. */
  erase(actor: Actor, id: string, reason: string): void {
    const at = this.now()
    this.db.transaction(() => {
      const m = this.member(id)
      if (!m) throw new AppError('NOT_FOUND')
      this.db
        .prepare(`UPDATE members SET phone = ?, name = NULL, birth_date = NULL, email = NULL, line_id = NULL, phone2 = NULL, note = NULL, deleted_at = ?, updated_at = ? WHERE id = ?`)
        .run(`erased:${id}`, at, at, id)
      this.audit.append({ action: 'members.erase', permission: 'promo:delete', userId: actor.userId, branchId: actor.branchId, entity: 'members', entityId: id, reason, risk: 'high' })
    }).immediate()
  }

  pointsRules(): PointsRulesDto {
    return { earnEverySatang: this.settings.get('points.earn_every_satang'), redeemPoints: this.settings.get('points.redeem_points'), redeemValueSatang: this.settings.get('points.redeem_value_satang') }
  }

  /** Points rules live in settings but belong to the promo screen (promo:update), audited there. */
  savePointsRules(actor: Actor, input: PointsRulesDto): PointsRulesDto {
    this.settings.update(actor, { 'points.earn_every_satang': input.earnEverySatang, 'points.redeem_points': input.redeemPoints, 'points.redeem_value_satang': input.redeemValueSatang }, 'promo:update')
    return this.pointsRules()
  }

  /** Appends to point_ledger and keeps the member caches in step. Caller holds the transaction. */
  addPoints(memberId: string, delta: number, reason: 'earn' | 'redeem' | 'void_reversal' | 'adjust', refType: string, refId: string | null, reversesId: string | null, userId: string, at: number, lifetime: boolean) {
    const id = uuidv7(at)
    this.db
      .prepare('INSERT INTO point_ledger (id, member_id, delta, reason, ref_type, ref_id, reverses_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, memberId, delta, reason, refType, refId, reversesId, userId, at)
    this.db
      .prepare('UPDATE members SET points_balance = points_balance + ?, lifetime_points = max(0, lifetime_points + ?), updated_at = ?, rev = rev + 1 WHERE id = ?')
      .run(delta, lifetime ? delta : 0, at, memberId)
    return id
  }

  /** Points a payment earns: floor(total / earnEvery) × tier multiplier. */
  pointsFor(totalSatang: number, tierMultMilli: number): number {
    const base = Math.floor(totalSatang / this.settings.get('points.earn_every_satang'))
    return Math.floor((base * tierMultMilli) / 1000)
  }

  // ===========================================================================
  // pricing (shared by quote and checkout)
  // ===========================================================================

  /**
   * Computes every discount for a cart. Verifies an approver PIN when the manual discount needs it
   * (so it must run OUTSIDE the write transaction — PIN failures are recorded for lockout).
   */
  price(actor: Actor, lines: readonly PromoLine[], d: DiscountInput, opts: { verifyApprover: boolean }): PricedDiscounts {
    const now = this.now()
    const subtotal = lines.reduce((s, l) => s + l.unitPriceSatang * l.qty, 0)

    // coupon → makes its promotion eligible (even coupon-only ones)
    let couponId: string | null = null
    let couponError: PricedDiscounts['couponError'] = null
    const couponPromos = new Set<string>()
    const promotionsOn = this.features().promotions
    if (d.couponCode && !promotionsOn) throw new AppError('FEATURE_NOT_LICENSED', { feature: 'promotions' })
    if (d.couponCode) {
      const c = this.findCoupon(actor.branchId, d.couponCode)
      if (!c) couponError = 'not_found'
      else if (c.expires_at !== null && c.expires_at <= now) couponError = 'expired'
      else if (c.max_uses !== null && c.used_count >= c.max_uses) couponError = 'used_up'
      else {
        couponId = c.id
        couponPromos.add(c.promotion_id)
      }
    }
    // promotions off (D51): no automatic promotions; manual discount and points below still work
    const best = promotionsOn ? bestPromotions(this.defs(actor.branchId), lines, now, { coupons: couponPromos, excluded: new Set(d.excludedPromotionIds) }) : { applied: [], totalSatang: 0 }
    const promotions = best.applied.map((a) => ({ ...a, couponId: couponPromos.has(a.promotionId) ? couponId : null }))
    let remaining = subtotal - best.totalSatang

    // manual discount (rule 4: audited at checkout)
    let manual: PricedDiscounts['manual'] = null
    if (d.manualDiscount && remaining > 0) {
      const m = d.manualDiscount
      const amount = Math.min(remaining, m.kind === 'percent' ? percentOfSatang(remaining, Math.min(m.value, 10_000)) : m.value)
      const bpOfSubtotal = subtotal > 0 ? mulDivHalfUp(amount, 10_000, subtotal) : 0
      const allowed = (a: Actor) => can(a, 'pos:discount') && bpOfSubtotal <= this.maxDiscountBp(a.roleId)
      let approvedBy: string | null = null
      if (!allowed(actor)) {
        if (!m.approver) throw new AppError(can(actor, 'pos:discount') ? 'DISCOUNT_LIMIT' : 'APPROVAL_REQUIRED', { permission: 'pos:discount', bp: bpOfSubtotal })
        if (opts.verifyApprover) {
          const u = this.users.findByUsername(m.approver.username)
          if (!u || u.branch_id !== actor.branchId) throw new AppError('INVALID_CREDENTIALS')
          const approver = this.authService.verifyPin(u.id, m.approver.pin)
          if (!allowed(approver)) throw new AppError('DISCOUNT_LIMIT', { bp: bpOfSubtotal })
          approvedBy = approver.userId
        }
      }
      manual = { amount, description: `${m.kind === 'percent' ? `ส่วนลด ${m.value / 100}%` : 'ส่วนลด'} · ${m.reason}`, approvedBy }
      remaining -= amount
    }

    // points
    const member = d.memberId ? (this.member(d.memberId) ?? null) : null
    if (d.memberId && !member) throw new AppError('NOT_FOUND', { entity: 'members' })
    const points = { redeemed: 0, amount: 0 }
    if (d.redeemPoints > 0) {
      if (!member) throw new AppError('INVALID_INPUT', { fields: { memberId: ['required'] } })
      const rules = this.pointsRules()
      if (d.redeemPoints % rules.redeemPoints !== 0) throw new AppError('INVALID_INPUT', { fields: { redeemPoints: ['multiple'] } })
      if (d.redeemPoints > member.points_balance) throw new AppError('POINTS_INSUFFICIENT', { balance: member.points_balance })
      const amount = (d.redeemPoints / rules.redeemPoints) * rules.redeemValueSatang
      if (amount > remaining) throw new AppError('INVALID_INPUT', { fields: { redeemPoints: ['exceeds_total'] } })
      points.redeemed = d.redeemPoints
      points.amount = amount
      remaining -= amount
    }
    const tier = member ? this.tierFor(actor, member.lifetime_points) : null
    return {
      subtotal,
      promotions,
      couponId,
      couponError,
      manual,
      points,
      discountSatang: subtotal - remaining,
      member,
      tierMultMilli: tier?.multiplierMilli ?? 1000,
    }
  }

  private maxDiscountBp(roleId: string): number {
    return (this.db.prepare('SELECT max_discount_bp FROM roles WHERE id = ?').pluck().get(roleId) as number | undefined) ?? 0
  }

  /** Bumps coupon usage inside the checkout transaction; re-checks the limit to avoid races. */
  useCoupon(couponId: string, at: number): void {
    const r = this.db.prepare('UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)').run(at, couponId)
    if (!r.changes) throw new AppError('COUPON_INVALID', { reason: 'used_up' })
  }

  releaseCoupon(couponId: string, at: number): void {
    this.db.prepare('UPDATE coupons SET used_count = max(0, used_count - 1), updated_at = ? WHERE id = ?').run(at, couponId)
  }
}
