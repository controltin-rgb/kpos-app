import { can, type Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { SalesRepo, type BillRow, type ShiftRow } from '@main/db/repos/sales.repo'
import { UsersRepo } from '@main/db/repos/users.repo'
import type { ParsedInput } from '@shared/api'
import type { BillDetailDto, BillList, BillSummaryDto, PaymentMethod, SaleResult, ShortageNoticeDto } from '@shared/api-sales'
import { scaleRequirement } from '@shared/bom'
import { priceLine, type PricedLine } from '@shared/pricing'
import { formatBillNo } from '@shared/bill-number'
import type { OfflineBill, SyncResult } from '@shared/sync'
import { AppError } from '@shared/errors'
import { FULL_FEATURES, type FeatureSource } from '@shared/license'
import { uuidv7 } from '@shared/id'
import { percentOfSatang } from '@shared/money'
import type { Permission } from '@shared/permissions'
import { computeBillTotals, type BillTotals } from '@shared/sale-totals'
import type { AuditService } from './audit.service'
import type { CatalogService } from './catalog.service'
import type { DocNumberService } from './doc-number.service'
import type { SettingsService } from './settings.service'
import type { ShiftService } from './shift.service'
import type { StockService } from './stock/stock.service'
import { maskPhone, type PricedDiscounts, type PromoService } from './promo.service'
import type { BillDiscountDto, QuoteDto } from '@shared/api-promo'
import type { PromoLine } from '@shared/promotions'

const toPromoLine = (l: { productId: string; categoryId: string | null; qty: number; unitPriceSatang: number }): PromoLine => ({
  productId: l.productId,
  categoryId: l.categoryId,
  qty: l.qty,
  unitPriceSatang: l.unitPriceSatang,
})

type CheckoutInput = ParsedInput<'pos.checkout'>

/**
 * Sales: checkout, void, refund, bill queries.
 * Checkout runs as ONE synchronous BEGIN IMMEDIATE transaction (CLAUDE.md rule 2): bill, items,
 * payment, bill events, cash ledger, BOM stock deduction and KDS tickets commit together or not at all.
 */
export class SaleService {
  readonly repo: SalesRepo
  private readonly users: UsersRepo

  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly stock: StockService,
    private readonly shifts: ShiftService,
    private readonly docs: DocNumberService,
    private readonly settings: SettingsService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly promo: PromoService,
    private readonly now: () => number = Date.now,
    private readonly features: FeatureSource = () => FULL_FEATURES,
  ) {
    this.repo = new SalesRepo(db)
    this.users = new UsersRepo(db)
  }

  // -------------------------------------------------------------------------
  // checkout
  // -------------------------------------------------------------------------

  checkout(actor: Actor, input: CheckoutInput): SaleResult {
    // retrying the same request returns the original bill instead of selling twice
    const existing = this.repo.bill(input.requestId)
    if (existing) {
      if (existing.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
      return { bill: this.detail(existing.id), shortages: [] }
    }
    if ((input.orderType === 'delivery') !== (input.channel !== null)) throw new AppError('INVALID_INPUT', { fields: { channel: ['required for delivery only'] } })
    if (input.payment.method === 'delivery' && input.orderType !== 'delivery') throw new AppError('PAYMENT_INVALID')
    if (input.orderType === 'delivery' && !this.settings.get('sales.delivery_enabled')) throw new AppError('DELIVERY_DISABLED')

    const vatRateBp = this.settings.get('vat.rate_bp')
    const lines = input.items.map((i) => this.price(actor.branchId, i))
    // discounts first (may verify an approver PIN, so outside the write transaction)
    const priced = this.promo.price(actor, lines.map(toPromoLine), input, { verifyApprover: true })
    if (input.couponCode && priced.couponError) throw new AppError('COUPON_INVALID', { reason: priced.couponError })
    const totals = computeBillTotals({ lines: lines.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })), billDiscountSatang: priced.discountSatang, vatRateBp })
    const pointsEarned = priced.member ? this.promo.pointsFor(totals.total, priced.tierMultMilli) : 0

    if (totals.total <= 0) throw new AppError('PAYMENT_INVALID', { reason: 'zero_total' })
    const pay = input.payment
    let tendered: number | null = null
    let change: number | null = null
    if (pay.method === 'cash') {
      if (pay.tenderedSatang < totals.total) throw new AppError('PAYMENT_INSUFFICIENT', { totalSatang: totals.total })
      tendered = pay.tenderedSatang
      change = pay.tenderedSatang - totals.total
    }
    if (pay.method === 'promptpay' && !this.settings.get('promptpay.id')) throw new AppError('PROMPTPAY_NOT_CONFIGURED')

    const at = this.now()
    const billId = input.requestId
    const shortages: ShortageNoticeDto[] = []

    this.db.transaction(() => {
      const shift = this.shifts.requireOpen(actor)
      const billNo = this.docs.nextBillNo(actor.branchId, this.settings.get('bill.reset_policy'), at)
      shortages.push(...this.persist({ userId: actor.userId, branchId: actor.branchId, billId, billNo, shift, at, order: input, lines, totals, priced, pointsEarned, pay, tendered, change, kds: true }))
    }).immediate()

    return { bill: this.detail(billId), shortages }
  }

  /**
   * Records a bill a paired Client sold while the Host was down (D36). The Client's prices stand
   * (the customer paid them); the Host re-checks the arithmetic, the bill number block, the seller
   * and the shift, then writes it exactly like an online sale — stock is deducted now from the BOM
   * snapshot taken at the time of sale. Idempotent by bill id.
   */
  ingestOffline(deviceId: string, bill: OfflineBill, syncedAt: number): SyncResult {
    const reject = (reason: string): SyncResult => ({ id: bill.id, status: 'rejected', reason })
    const existing = this.repo.bill(bill.id)
    if (existing) return { id: bill.id, status: 'duplicate', billNo: existing.bill_no }

    const device = this.db.prepare(`SELECT branch_id FROM devices WHERE id = ? AND role = 'client'`).get(deviceId) as { branch_id: string } | undefined
    if (!device) return reject('device')
    const branchId = device.branch_id
    const block = this.db
      .prepare('SELECT id, period, prefix, from_no, to_no FROM bill_number_blocks WHERE id = ? AND device_id = ?')
      .get(bill.blockId, deviceId) as { id: string; period: string; prefix: string; from_no: number; to_no: number } | undefined
    if (!block || block.period !== bill.period || bill.seq < block.from_no || bill.seq > block.to_no) return reject('bill_number')
    const policy = this.settings.get('bill.reset_policy')
    if (formatBillNo(block.prefix, policy, block.period, bill.seq) !== bill.billNo) return reject('bill_number')
    if (this.db.prepare('SELECT 1 FROM bills WHERE branch_id = ? AND bill_no = ?').get(branchId, bill.billNo)) return reject('bill_number_taken')

    const seller = this.users.findById(bill.userId)
    if (!seller || seller.branch_id !== branchId || seller.deleted_at !== null) return reject('user')
    const shift = this.repo.shift(bill.shiftId)
    if (!shift || shift.device_id !== deviceId) return reject('shift')
    if ((bill.orderType === 'delivery') !== (bill.channel !== null)) return reject('channel')

    // the arithmetic must hold with the Client's own prices and promotions
    const discount = bill.promotions.reduce((s, p) => s + p.discountSatang, 0)
    const subtotal = bill.lines.reduce((s, l) => s + l.unitPriceSatang * l.qty, 0)
    if (discount > subtotal) return reject('totals')
    const totals = computeBillTotals({ lines: bill.lines.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })), billDiscountSatang: discount, vatRateBp: bill.vatRateBp })
    if (totals.total !== bill.totalSatang || totals.total <= 0) return reject('totals')
    let tendered: number | null = null
    let change: number | null = null
    if (bill.payment.method === 'cash') {
      if (bill.payment.tenderedSatang < totals.total) return reject('payment')
      tendered = bill.payment.tenderedSatang
      change = tendered - totals.total
    }
    const priced: PricedDiscounts = {
      subtotal,
      promotions: bill.promotions.map((p) => ({ ...p, couponId: null })),
      couponId: null,
      couponError: null,
      manual: null,
      points: { redeemed: 0, amount: 0 },
      discountSatang: discount,
      member: null,
      tierMultMilli: 1000,
    }

    this.db
      .transaction(() => {
        this.persist({
          userId: seller.id,
          branchId,
          billId: bill.id,
          billNo: bill.billNo,
          shift,
          at: bill.createdAt,
          order: { orderType: bill.orderType, channel: bill.channel, extOrderId: bill.extOrderId, commissionBp: bill.commissionBp },
          lines: bill.lines,
          totals,
          priced,
          pointsEarned: 0,
          pay: bill.payment as CheckoutInput['payment'],
          tendered,
          change,
          kds: false, // served already
          eventData: { offline: true, syncedAt },
        })
        this.db.prepare('UPDATE bills SET synced_at = ? WHERE id = ?').run(syncedAt, bill.id)
        this.db.prepare('UPDATE bill_number_blocks SET used_to = max(ifnull(used_to, 0), ?) WHERE id = ?').run(bill.seq, block.id)
        if (shift.status !== 'open')
          this.audit.append({ action: 'sync.late_bill', permission: 'pos:create', userId: seller.id, branchId, deviceId, entity: 'bills', entityId: bill.id, after: { billNo: bill.billNo, shiftId: shift.id, totalSatang: totals.total }, risk: 'high' })
      })
      .immediate()
    return { id: bill.id, status: 'ok', billNo: bill.billNo }
  }

  /**
   * Writes a priced, paid bill: bill, discounts, points, items (+BOM snapshot), stock deduction,
   * KDS tickets, payment, bill events and drawer cash. Must run inside the caller's transaction.
   * Shared by online checkout and bills a Client sold while the Host was down (D36).
   */
  private persist(a: {
    userId: string
    branchId: string
    billId: string
    billNo: string
    shift: ShiftRow
    at: number
    order: Pick<CheckoutInput, 'orderType' | 'channel' | 'extOrderId' | 'commissionBp'>
    lines: PricedLine[]
    totals: BillTotals
    priced: PricedDiscounts
    pointsEarned: number
    pay: CheckoutInput['payment']
    tendered: number | null
    change: number | null
    /** create KDS tickets (not for bills that were already served while offline) */
    kds: boolean
    /** extra data on the 'created' bill event */
    eventData?: Record<string, unknown>
  }): ShortageNoticeDto[] {
    const shortages: ShortageNoticeDto[] = []
    const kdsDoneOnPay = a.kds && this.settings.get('kds.complete_on_pay')
    const shift = a.shift
    const deviceId = shift.device_id
    const commissionSatang = a.order.commissionBp !== null ? percentOfSatang(a.totals.total, a.order.commissionBp) : null

    this.repo.insertBill({
      id: a.billId,
      branch_id: a.branchId,
      bill_no: a.billNo,
      device_id: deviceId,
      shift_id: shift.id,
      order_type: a.order.orderType,
      channel: a.order.channel,
      ext_order_id: a.order.extOrderId ?? null,
      status: 'paid',
      vat_mode: a.totals.vatMode,
      subtotal_satang: a.totals.subtotal,
      discount_satang: a.totals.discount,
      vat_satang: a.totals.vat,
      total_satang: a.totals.total,
      commission_bp: a.order.commissionBp,
      commission_satang: commissionSatang,
      member_id: a.priced.member?.id ?? null,
      promotion_id: a.priced.promotions[0]?.promotionId ?? null,
      coupon_id: a.priced.couponId,
      points_earned: a.pointsEarned,
      points_redeemed: a.priced.points.redeemed,
      created_by: a.userId,
      created_at: a.at,
      paid_at: a.at,
      updated_at: a.at,
    })
    this.recordDiscounts(a, a.billId, a.billNo, a.priced, a.at)
    if (a.priced.member) {
      if (a.priced.points.redeemed) {
        const balance = this.db.prepare('SELECT points_balance FROM members WHERE id = ?').pluck().get(a.priced.member.id) as number
        if (balance < a.priced.points.redeemed) throw new AppError('POINTS_INSUFFICIENT', { balance })
        this.promo.addPoints(a.priced.member.id, -a.priced.points.redeemed, 'redeem', 'bill', a.billId, null, a.userId, a.at, false)
      }
      if (a.pointsEarned) this.promo.addPoints(a.priced.member.id, a.pointsEarned, 'earn', 'bill', a.billId, null, a.userId, a.at, true)
    }

    const stockCtx = { branchId: a.branchId, userId: a.userId, deviceId, at: a.at }
    a.lines.forEach((l, idx) => {
      const itemId = uuidv7(a.at)
      const t = a.totals.lines[idx]!
      this.repo.insertItem({
        id: itemId,
        bill_id: a.billId,
        line_no: idx + 1,
        product_id: l.productId,
        size_id: l.sizeId,
        product_name: l.productName,
        size_label: l.sizeLabel,
        qty: l.qty,
        unit_price_satang: l.unitPriceSatang,
        discount_satang: t.discount,
        line_total_satang: t.total,
        vat_type: l.vatType,
        // per-unit BOM at the time of sale: void/refund use the ledger rows, never today's recipe
        bom_snapshot_json: JSON.stringify(l.requirementPerUnit),
        note: l.note,
      })
      for (const m of l.modifiers) {
        this.repo.insertModifier({
          id: uuidv7(a.at),
          bill_item_id: itemId,
          option_id: m.optionId,
          group_name: m.groupName,
          option_name: m.optionName,
          price_satang: m.priceSatang,
          kds_highlight: m.highlight ? 1 : 0,
        })
      }
      for (const n of this.stock.deduct(stockCtx, 'bill_item', itemId, scaleRequirement(l.requirementPerUnit, l.qty))) {
        shortages.push({ ingredientName: n.ingredientName, baseUnit: n.baseUnit, qtyMilli: n.qtyMilli })
      }
      // KDS off (D51): no tickets pile up on a screen nobody has
      if (a.kds && l.kdsStation && this.features().kds) {
        // 'kds.complete_on_pay': the drink is handed over at payment, so the ticket is done at once and
        // never waits on the bar screen (still recorded, e.g. for prep-time reports)
        const done = kdsDoneOnPay ? a.at : null
        this.db
          .prepare(
            `INSERT INTO kds_tickets (id, branch_id, bill_id, bill_item_id, station, status, created_at, started_at, ready_at, completed_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(a.at), a.branchId, a.billId, itemId, l.kdsStation, kdsDoneOnPay ? 'completed' : 'new', a.at, done, done, done, a.at)
      }
    })

    this.repo.insertPayment({
      id: uuidv7(a.at),
      bill_id: a.billId,
      method: a.pay.method,
      amount_satang: a.totals.total,
      tendered_satang: a.tendered,
      change_satang: a.change,
      status: 'confirmed',
      confirmation_source: 'manual',
      confirmed_by: a.userId,
      confirmed_at: a.at,
      reference: 'reference' in a.pay ? (a.pay.reference ?? null) : null,
      created_at: a.at,
    })

    const ev = (event: string, data: unknown = {}) =>
      this.repo.insertEvent({ id: uuidv7(a.at), bill_id: a.billId, event, user_id: a.userId, approved_by: null, reason: null, data_json: JSON.stringify(data), device_id: deviceId, created_at: a.at })
    ev('created', { items: a.lines.length, ...a.eventData })
    ev('paid', { method: a.pay.method, totalSatang: a.totals.total, tenderedSatang: a.tendered, changeSatang: a.change })

    if (a.pay.method === 'cash') {
      this.repo.insertCash({
        id: uuidv7(a.at),
        branch_id: a.branchId,
        shift_id: shift.id,
        kind: 'sale',
        amount_satang: a.totals.total,
        ref_type: 'bill',
        ref_id: a.billId,
        reverses_id: null,
        note: null,
        user_id: a.userId,
        device_id: deviceId,
        created_at: a.at,
      })
    }
    return shortages
  }

  /** Price preview for the POS (no approver PIN check, nothing written). */
  quote(actor: Actor, input: ParsedInput<'pos.quote'>): QuoteDto {
    const vatRateBp = this.settings.get('vat.rate_bp')
    const lines = input.items.map((i) => this.price(actor.branchId, { ...i, note: null }))
    const p = this.promo.price(actor, lines.map(toPromoLine), input, { verifyApprover: false })
    const totals = computeBillTotals({ lines: lines.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })), billDiscountSatang: p.discountSatang, vatRateBp })
    return {
      subtotalSatang: totals.subtotal,
      promotions: p.promotions.map(({ couponId: _c, ...a }) => a),
      couponError: input.couponCode ? p.couponError : null,
      manualDiscountSatang: p.manual?.amount ?? 0,
      pointsDiscountSatang: p.points.amount,
      pointsRedeemed: p.points.redeemed,
      discountSatang: totals.discount,
      totalSatang: totals.total,
      vatSatang: totals.vat,
      netSatang: totals.net,
      vatMode: totals.vatMode,
      member: p.member ? this.promo.memberDto(actor, p.member) : null,
      pointsToEarn: p.member ? this.promo.pointsFor(totals.total, p.tierMultMilli) : 0,
    }
  }

  /** One bill_discounts row per discount; the manual one is audited (CLAUDE.md rule 4). */
  private recordDiscounts(actor: Pick<Actor, 'userId' | 'branchId'>, billId: string, billNo: string, p: PricedDiscounts, at: number) {
    const ins = this.db.prepare(
      `INSERT INTO bill_discounts (id, bill_id, kind, promotion_id, coupon_id, description, amount_satang, points, approved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const a of p.promotions) ins.run(uuidv7(at), billId, a.couponId ? 'coupon' : 'promotion', a.promotionId, a.couponId, a.name, a.discountSatang, null, null, at)
    if (p.couponId) this.promo.useCoupon(p.couponId, at)
    if (p.manual) {
      ins.run(uuidv7(at), billId, 'manual', null, null, p.manual.description, p.manual.amount, null, p.manual.approvedBy, at)
      this.audit.append({
        action: 'bill.discount',
        permission: 'pos:discount',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'bills',
        entityId: billId,
        after: { billNo, amountSatang: p.manual.amount, subtotalSatang: p.subtotal, approvedBy: p.manual.approvedBy },
        reason: p.manual.description,
        risk: p.manual.approvedBy ? 'high' : 'medium',
      })
    }
    if (p.points.redeemed) ins.run(uuidv7(at), billId, 'points', null, null, `แลก ${p.points.redeemed} แต้ม`, p.points.amount, p.points.redeemed, null, at)
  }

  /** Prices one cart line from the DB (same rules a Client uses offline: shared/pricing.ts). */
  private price(branchId: string, item: CheckoutInput['items'][number]): PricedLine {
    return priceLine(this.catalog.saleSnapshot(branchId, item.productId), item)
  }

  // -------------------------------------------------------------------------
  // void / refund
  // -------------------------------------------------------------------------

  /**
   * Void: cancel a paid bill of a shift that is still open (Implement.md §6.2). Needs pos:void —
   * from the actor, or from an approver who enters their PIN (Design-Spec §2). Returns stock to the
   * original lots, reverses drawer cash, cancels KDS tickets, audit risk = high.
   */
  void(actor: Actor, input: ParsedInput<'orders.void'>): BillDetailDto {
    const approverId = this.approve(actor, 'pos:void', input.approver)
    const at = this.now()
    this.db.transaction(() => {
      const bill = this.mustFind(actor, input.id)
      if (bill.status !== 'paid') throw new AppError('BILL_NOT_VOIDABLE', { status: bill.status })
      const shift = this.repo.shift(bill.shift_id)!
      if (shift.status !== 'open') throw new AppError('BILL_NOT_VOIDABLE', { reason: 'shift_closed' })
      this.reverse(actor, bill, approverId, input.reason, 'void', at)
    }).immediate()
    return this.detail(input.id)
  }

  /**
   * Refund the whole bill (D17). Needs orders:refund (actor or approver PIN). Cash goes out of the
   * drawer of the shift currently open on this device. Audit risk = high.
   */
  refund(actor: Actor, input: ParsedInput<'orders.refund'>): BillDetailDto {
    const approverId = this.approve(actor, 'orders:refund', input.approver)
    const at = this.now()
    this.db.transaction(() => {
      const bill = this.mustFind(actor, input.id)
      if (bill.status !== 'paid') throw new AppError('BILL_NOT_REFUNDABLE', { status: bill.status })
      this.reverse(actor, bill, approverId, input.reason, 'refund', at)
    }).immediate()
    return this.detail(input.id)
  }

  private reverse(actor: Actor, bill: BillRow, approverId: string | null, reason: string, kind: 'void' | 'refund', at: number) {
    const items = this.repo.items(bill.id)
    const before = { status: bill.status, totalSatang: bill.total_satang }
    const drawerShift = kind === 'void' ? this.repo.shift(bill.shift_id)! : null
    const payments = this.repo.payments(bill.id)
    const cashPaid = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount_satang, 0)

    let deviceId: string | null = bill.device_id
    if (kind === 'refund' && cashPaid > 0) {
      const open = this.shifts.requireOpen(actor) // cash leaves the drawer of the shift open now
      deviceId = open.device_id
      if (this.shifts.drawerEnabled() && this.shifts.expected(open.id) < cashPaid) throw new AppError('PAYMENT_INVALID', { reason: 'drawer_insufficient' })
      this.repo.insertCash({
        id: uuidv7(at),
        branch_id: bill.branch_id,
        shift_id: open.id,
        kind: 'refund',
        amount_satang: -cashPaid,
        ref_type: 'bill',
        ref_id: bill.id,
        reverses_id: null,
        note: reason,
        user_id: actor.userId,
        device_id: deviceId,
        created_at: at,
      })
    }
    if (kind === 'void') {
      for (const c of this.repo.cashFor('bill', bill.id)) {
        this.repo.insertCash({
          id: uuidv7(at),
          branch_id: bill.branch_id,
          shift_id: drawerShift!.id,
          kind: 'void_reversal',
          amount_satang: -c.amount_satang,
          ref_type: 'bill',
          ref_id: bill.id,
          reverses_id: c.id,
          note: reason,
          user_id: actor.userId,
          device_id: deviceId,
          created_at: at,
        })
      }
    }

    // points and coupon usage go back too
    const pointRows = this.db
      .prepare(`SELECT * FROM point_ledger l WHERE ref_type = 'bill' AND ref_id = ? AND reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM point_ledger r WHERE r.reverses_id = l.id)`)
      .all(bill.id) as { id: string; member_id: string; delta: number; reason: string }[]
    for (const r of pointRows) this.promo.addPoints(r.member_id, -r.delta, 'void_reversal', 'bill', bill.id, r.id, actor.userId, at, r.reason === 'earn')
    const couponId = this.db.prepare('SELECT coupon_id FROM bills WHERE id = ?').pluck().get(bill.id) as string | null
    if (couponId) this.promo.releaseCoupon(couponId, at)

    this.stock.reverse(
      { branchId: bill.branch_id, userId: actor.userId, deviceId, at },
      'bill_item',
      items.map((i) => i.id),
      kind === 'void' ? 'void_reversal' : 'refund_reversal',
    )
    this.db.prepare(`UPDATE kds_tickets SET status = 'cancelled', updated_at = ? WHERE bill_id = ? AND status <> 'completed'`).run(at, bill.id)

    this.repo.updateBill(
      bill.id,
      kind === 'void'
        ? { status: 'void', voided_at: at, voided_by: actor.userId, void_approved_by: approverId, void_reason: reason }
        : { status: 'refunded' },
      at,
    )
    this.repo.insertEvent({
      id: uuidv7(at),
      bill_id: bill.id,
      event: kind,
      user_id: actor.userId,
      approved_by: approverId,
      reason,
      data_json: JSON.stringify({ cashSatang: cashPaid }),
      device_id: deviceId,
      created_at: at,
    })
    this.audit.append({
      action: `bill.${kind}`,
      permission: kind === 'void' ? 'pos:void' : 'orders:refund',
      userId: actor.userId,
      branchId: bill.branch_id,
      deviceId,
      entity: 'bills',
      entityId: bill.id,
      before,
      after: { status: kind === 'void' ? 'void' : 'refunded', billNo: bill.bill_no, approvedBy: approverId },
      reason,
      risk: 'high',
    })
  }

  /** Returns the approver's user id (or null when the actor holds the permission). */
  private approve(actor: Actor, perm: Permission, approver?: { username: string; pin: string }): string | null {
    if (can(actor, perm)) return null
    if (!approver) throw new AppError('APPROVAL_REQUIRED', { permission: perm })
    const user = this.users.findByUsername(approver.username)
    if (!user || user.branch_id !== actor.branchId) throw new AppError('INVALID_CREDENTIALS')
    const approverActor = this.authService.verifyPin(user.id, approver.pin)
    if (!can(approverActor, perm)) throw new AppError('FORBIDDEN', { permission: perm })
    return approverActor.userId
  }

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  list(actor: Actor, q: ParsedInput<'orders.list'>): BillList {
    const { rows, total } = this.repo.list({
      branchId: actor.branchId,
      search: q.search || undefined,
      status: q.status,
      from: q.from,
      to: q.to,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    })
    return { items: rows.map((r) => this.summaryOf(r)), total, page: q.page, pageSize: q.pageSize }
  }

  get(actor: Actor, id: string): BillDetailDto {
    this.mustFind(actor, id)
    return this.detail(id)
  }

  detail(id: string): BillDetailDto {
    const b = this.repo.billWithMeta(id)
    if (!b) throw new AppError('NOT_FOUND')
    const items = this.repo.items(id)
    const mods = this.repo.modifiers(items.map((i) => i.id))
    return {
      ...this.summaryOf(b),
      shiftId: b.shift_id,
      extOrderId: b.ext_order_id,
      subtotalSatang: b.subtotal_satang,
      discountSatang: b.discount_satang,
      vatSatang: b.vat_satang,
      vatMode: b.vat_mode,
      commissionBp: b.commission_bp,
      commissionSatang: b.commission_satang,
      items: items.map((i) => ({
        id: i.id,
        lineNo: i.line_no,
        productName: i.product_name,
        sizeLabel: i.size_label,
        qty: i.qty,
        unitPriceSatang: i.unit_price_satang,
        discountSatang: i.discount_satang,
        lineTotalSatang: i.line_total_satang,
        modifiers: mods.filter((m) => m.bill_item_id === i.id).map((m) => ({ groupName: m.group_name, optionName: m.option_name, priceSatang: m.price_satang })),
        note: i.note,
      })),
      payments: this.repo.payments(id).map((p) => ({
        method: p.method as PaymentMethod,
        amountSatang: p.amount_satang,
        tenderedSatang: p.tendered_satang,
        changeSatang: p.change_satang,
        reference: p.reference,
        confirmedByName: p.confirmed_by_name,
      })),
      events: this.repo.events(id).map((e) => ({ event: e.event, at: e.created_at, userName: e.user_name, approverName: e.approver_name, reason: e.reason })),
      voidReason: b.void_reason,
      voidable: b.status === 'paid' && b.shift_status === 'open',
      discounts: this.db.prepare('SELECT kind, description, amount_satang FROM bill_discounts WHERE bill_id = ? ORDER BY rowid').all(id).map((r) => {
        const d = r as { kind: BillDiscountDto['kind']; description: string; amount_satang: number }
        return { kind: d.kind, description: d.description, amountSatang: d.amount_satang }
      }),
      member: this.memberOf(b),
    }
  }

  /** Records a reprint (bill_events) — printing itself is done by the print module. */
  recordPrint(actor: Actor, id: string, deviceId: string | null): BillDetailDto {
    const bill = this.mustFind(actor, id)
    const at = this.now()
    this.db.transaction(() => {
      this.repo.insertEvent({ id: uuidv7(at), bill_id: bill.id, event: 'reprint', user_id: actor.userId, approved_by: null, reason: null, data_json: '{}', device_id: deviceId, created_at: at })
    }).immediate()
    return this.detail(id)
  }

  private memberOf(b: BillRow): BillDetailDto['member'] {
    if (!b.member_id) return null
    const m = this.db.prepare('SELECT phone, name, deleted_at FROM members WHERE id = ?').get(b.member_id) as { phone: string; name: string | null; deleted_at: number | null } | undefined
    const pts = this.db.prepare('SELECT points_earned, points_redeemed FROM bills WHERE id = ?').get(b.id) as { points_earned: number; points_redeemed: number }
    return { name: m?.deleted_at ? null : (m?.name ?? null), phoneMasked: m && !m.deleted_at ? maskPhone(m.phone) : '—', pointsEarned: pts.points_earned, pointsRedeemed: pts.points_redeemed }
  }

  private mustFind(actor: Actor, id: string): BillRow {
    const b = this.repo.bill(id)
    if (!b || b.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    return b
  }

  private summaryOf(b: BillRow & { created_by_name: string; item_count: number | null; payment_method: string | null }): BillSummaryDto {
    return {
      id: b.id,
      billNo: b.bill_no,
      status: b.status,
      orderType: b.order_type,
      channel: b.channel,
      totalSatang: b.total_satang,
      paymentMethod: b.payment_method as PaymentMethod | null,
      createdAt: b.created_at,
      createdByName: b.created_by_name,
      itemCount: b.item_count ?? 0,
    }
  }
}
