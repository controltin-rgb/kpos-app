import { can, type Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { SalesRepo, type BillRow } from '@main/db/repos/sales.repo'
import { UsersRepo } from '@main/db/repos/users.repo'
import type { ParsedInput } from '@shared/api'
import type { BillDetailDto, BillList, BillSummaryDto, PaymentMethod, SaleResult, ShortageNoticeDto } from '@shared/api-sales'
import { requirementPerUnit, scaleRequirement } from '@shared/bom'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { percentOfSatang } from '@shared/money'
import type { Permission } from '@shared/permissions'
import { computeBillTotals } from '@shared/sale-totals'
import type { AuditService } from './audit.service'
import type { CatalogService } from './catalog.service'
import type { DocNumberService } from './doc-number.service'
import type { SettingsService } from './settings.service'
import type { ShiftService } from './shift.service'
import type { StockService } from './stock/stock.service'

type CheckoutInput = ParsedInput<'pos.checkout'>

interface PricedLine {
  productId: string
  sizeId: string | null
  productName: string
  sizeLabel: string | null
  qty: number
  unitPriceSatang: number
  vatType: 'vat7' | 'vat0' | 'exempt'
  note: string | null
  kdsStation: string | null
  modifiers: { optionId: string; groupName: string; optionName: string; priceSatang: number; highlight: boolean }[]
  requirementPerUnit: { ingredientId: string; qtyMilli: number }[]
}

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
    private readonly now: () => number = Date.now,
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

    const vatRateBp = this.settings.get('vat.rate_bp')
    const lines = input.items.map((i) => this.price(actor.branchId, i))
    const totals = computeBillTotals({ lines: lines.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })), vatRateBp })

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
      const shift = this.shifts.requireOpen()
      const deviceId = shift.device_id
      const billNo = this.docs.nextBillNo(actor.branchId, this.settings.get('bill.reset_policy'), at)
      const commissionSatang = input.commissionBp !== null ? percentOfSatang(totals.total, input.commissionBp) : null

      this.repo.insertBill({
        id: billId,
        branch_id: actor.branchId,
        bill_no: billNo,
        device_id: deviceId,
        shift_id: shift.id,
        order_type: input.orderType,
        channel: input.channel,
        ext_order_id: input.extOrderId ?? null,
        status: 'paid',
        vat_mode: totals.vatMode,
        subtotal_satang: totals.subtotal,
        discount_satang: totals.discount,
        vat_satang: totals.vat,
        total_satang: totals.total,
        commission_bp: input.commissionBp,
        commission_satang: commissionSatang,
        created_by: actor.userId,
        created_at: at,
        paid_at: at,
        updated_at: at,
      })

      const stockCtx = { branchId: actor.branchId, userId: actor.userId, deviceId, at }
      lines.forEach((l, idx) => {
        const itemId = uuidv7(at)
        const t = totals.lines[idx]!
        this.repo.insertItem({
          id: itemId,
          bill_id: billId,
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
            id: uuidv7(at),
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
        if (l.kdsStation) {
          this.db
            .prepare(
              `INSERT INTO kds_tickets (id, branch_id, bill_id, bill_item_id, station, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
            )
            .run(uuidv7(at), actor.branchId, billId, itemId, l.kdsStation, at, at)
        }
      })

      this.repo.insertPayment({
        id: uuidv7(at),
        bill_id: billId,
        method: pay.method,
        amount_satang: totals.total,
        tendered_satang: tendered,
        change_satang: change,
        status: 'confirmed',
        confirmation_source: 'manual',
        confirmed_by: actor.userId,
        confirmed_at: at,
        reference: 'reference' in pay ? (pay.reference ?? null) : null,
        created_at: at,
      })

      const ev = (event: string, data: unknown = {}) =>
        this.repo.insertEvent({ id: uuidv7(at), bill_id: billId, event, user_id: actor.userId, approved_by: null, reason: null, data_json: JSON.stringify(data), device_id: deviceId, created_at: at })
      ev('created', { items: lines.length })
      ev('paid', { method: pay.method, totalSatang: totals.total, tenderedSatang: tendered, changeSatang: change })

      if (pay.method === 'cash') {
        this.repo.insertCash({
          id: uuidv7(at),
          branch_id: actor.branchId,
          shift_id: shift.id,
          kind: 'sale',
          amount_satang: totals.total,
          ref_type: 'bill',
          ref_id: billId,
          reverses_id: null,
          note: null,
          user_id: actor.userId,
          device_id: deviceId,
          created_at: at,
        })
      }
    }).immediate()

    return { bill: this.detail(billId), shortages }
  }

  /** Prices one cart line from the DB and computes its per-unit BOM. */
  private price(branchId: string, item: CheckoutInput['items'][number]): PricedLine {
    const p = this.catalog.saleable(branchId, item.productId)
    if (!p) throw new AppError('PRODUCT_UNAVAILABLE', { productId: item.productId })
    const size = item.sizeId ? p.sizes.find((s) => s.id === item.sizeId) : (p.sizes.find((s) => s.isDefault) ?? p.sizes[0])
    if (item.sizeId && !size) throw new AppError('PRODUCT_UNAVAILABLE', { sizeId: item.sizeId })
    if (!size) throw new AppError('PRODUCT_UNAVAILABLE', { productId: item.productId })

    const chosen = new Set(item.optionIds)
    if (chosen.size !== item.optionIds.length) throw new AppError('INVALID_MODIFIERS')
    const modifiers: PricedLine['modifiers'] = []
    const modBoms = []
    let found = 0
    for (const g of p.groups) {
      const picked = g.options.filter((o) => chosen.has(o.id))
      if (picked.length < g.min_select || picked.length > g.max_select) throw new AppError('INVALID_MODIFIERS', { group: g.name })
      for (const o of picked) {
        modifiers.push({ optionId: o.id, groupName: g.name, optionName: o.name, priceSatang: o.priceSatang, highlight: g.kds_highlight === 1 })
        modBoms.push(o.items)
        found++
      }
    }
    if (found !== chosen.size) throw new AppError('INVALID_MODIFIERS') // option not offered for this product

    const category = p.product.category_id ? this.catalog.repo.category(p.product.category_id) : undefined
    return {
      productId: p.product.id,
      sizeId: size.id,
      productName: p.product.name,
      sizeLabel: p.sizes.length > 1 ? size.label : null,
      qty: item.qty,
      unitPriceSatang: size.priceSatang + modifiers.reduce((s, m) => s + m.priceSatang, 0),
      vatType: p.product.vat_type,
      note: item.note ?? null,
      kdsStation: p.product.kind === 'retail' ? null : (category?.kds_station ?? 'bar'),
      modifiers,
      requirementPerUnit: requirementPerUnit(p.recipe, { id: size.id, multiplierMilli: size.multiplierMilli }, modBoms),
    }
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
      const open = this.shifts.requireOpen() // cash leaves the drawer of the shift open now
      deviceId = open.device_id
      if (this.shifts.expected(open.id) < cashPaid) throw new AppError('PAYMENT_INVALID', { reason: 'drawer_insufficient' })
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
