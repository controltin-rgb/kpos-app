import { can, type Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { StockDocsRepo, type CountLineRow, type CountRow, type PoRow, type WasteRow } from '@main/db/repos/stock-docs.repo'
import type { ParsedInput } from '@shared/api'
import type { ExpiringLotDto, PurchaseOrderDto, StockCountDto, SupplierDto, WasteDto, WasteReason, WasteSummaryDto } from '@shared/api-stock'
import { requirementPerUnit, scaleRequirement } from '@shared/bom'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { mulDivHalfUp } from '@shared/money'
import type { AuditService } from './audit.service'
import type { CatalogService } from './catalog.service'
import type { DocNumberService } from './doc-number.service'
import type { SettingsService } from './settings.service'
import type { ShiftService } from './shift.service'
import { consumedCost } from './stock/allocate'
import type { StockContext, StockService } from './stock/stock.service'

const REASONS: WasteReason[] = ['expired', 'wrong_made', 'dropped', 'customer_return', 'other']

/**
 * Purchasing & receiving, stock counts with approval, waste and manual adjustments (Implement.md §6.7–6.8).
 * Every write runs in one BEGIN IMMEDIATE transaction; stock moves go through StockService (append-only ledger).
 */
export class StockOpsService {
  readonly repo: StockDocsRepo

  constructor(
    private readonly db: Db,
    private readonly stock: StockService,
    private readonly catalog: CatalogService,
    private readonly shifts: ShiftService,
    private readonly docs: DocNumberService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly deviceId: (branchId: string) => string,
    private readonly now: () => number = Date.now,
  ) {
    this.repo = new StockDocsRepo(db)
  }

  private ctx(actor: Actor, at: number): StockContext {
    return { branchId: actor.branchId, userId: actor.userId, deviceId: this.deviceId(actor.branchId), at }
  }

  private ingredient(actor: Actor, id: string) {
    const ing = this.stock.repo.ingredient(id)
    if (!ing || ing.branch_id !== actor.branchId || ing.deleted_at) throw new AppError('NOT_FOUND', { entity: 'ingredients' })
    return ing
  }

  /** Unit cost of the most recent lot × qty (estimate for surplus adjustments and count values). */
  private estimateValue(ingredientId: string, qtyMilli: number): number {
    const lots = this.stock.repo.lotsOf(ingredientId).sort((a, b) => b.received_at - a.received_at)
    const l = lots[0]
    return l ? mulDivHalfUp(l.total_cost_satang, qtyMilli, l.qty_received_milli) : 0
  }

  /** Adds stock as a 'count_adjust' lot (positive) or takes it FEFO/FIFO (negative). */
  private adjustLots(ctx: StockContext, ingredientId: string, deltaMilli: number, reason: 'count_adjust' | 'adjust', refType: string, refId: string, allowShortage: boolean) {
    if (deltaMilli > 0) {
      this.stock.receive(ctx, {
        ingredientId,
        qtyMilli: deltaMilli,
        totalCostSatang: this.estimateValue(ingredientId, deltaMilli),
        expiresAt: null,
        lotNo: null,
        receivedAt: ctx.at,
        source: 'count_adjust',
        reason,
        refType,
        refId,
      })
    } else if (deltaMilli < 0) {
      this.stock.deduct(ctx, refType, refId, [{ ingredientId, qtyMilli: -deltaMilli }], { reason, allowShortage })
    }
  }

  // ===========================================================================
  // suppliers & purchase orders
  // ===========================================================================

  suppliers(actor: Actor): SupplierDto[] {
    return this.repo.suppliers(actor.branchId).map((s) => ({ id: s.id, name: s.name, phone: s.phone, taxId: s.tax_id, note: s.note }))
  }

  saveSupplier(actor: Actor, input: ParsedInput<'purchasing.saveSupplier'>): SupplierDto {
    const at = this.now()
    const row = { name: input.name, phone: input.phone ?? null, tax_id: input.taxId ?? null, note: input.note ?? null }
    let id = input.id
    this.db.transaction(() => {
      if (id) {
        if (this.repo.supplier(id)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        this.repo.updateSupplier(id, row, at)
      } else {
        id = uuidv7(at)
        this.repo.insertSupplier({ id, branch_id: actor.branchId, ...row, created_at: at, updated_at: at })
      }
      this.audit.append({ action: 'purchasing.supplier_save', permission: 'inventory:update', userId: actor.userId, branchId: actor.branchId, entity: 'suppliers', entityId: id, after: row })
    }).immediate()
    return this.suppliers(actor).find((s) => s.id === id)!
  }

  orders(actor: Actor, openOnly: boolean): PurchaseOrderDto[] {
    return this.repo.pos(actor.branchId, openOnly).map((p) => this.poDto(p))
  }

  private poDto(p: PoRow): PurchaseOrderDto {
    return {
      id: p.id,
      poNo: p.po_no,
      status: p.status,
      supplierId: p.supplier_id,
      supplierName: p.supplier_id ? (this.repo.supplier(p.supplier_id)?.name ?? null) : null,
      orderedAt: p.ordered_at,
      expectedAt: p.expected_at,
      totalSatang: p.total_satang,
      note: p.note,
      createdByName: this.repo.userName(p.created_by) ?? '',
      createdAt: p.created_at,
      lines: this.repo.poLines(p.id).map((l) => {
        const ing = this.stock.repo.ingredient(l.ingredient_id)
        return {
          id: l.id,
          ingredientId: l.ingredient_id,
          ingredientName: ing?.name ?? '',
          baseUnit: ing?.base_unit ?? 'pcs',
          hasExpiry: ing?.has_expiry === 1,
          qtyOrderedMilli: l.qty_ordered_milli,
          qtyReceivedMilli: l.qty_received_milli,
          lineTotalSatang: l.line_total_satang,
        }
      }),
    }
  }

  saveOrder(actor: Actor, input: ParsedInput<'purchasing.saveOrder'>): PurchaseOrderDto {
    if (input.supplierId && this.repo.supplier(input.supplierId)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND', { entity: 'suppliers' })
    for (const l of input.lines) this.ingredient(actor, l.ingredientId)
    const at = this.now()
    let id = input.id
    this.db.transaction(() => {
      const total = input.lines.reduce((s, l) => s + l.lineTotalSatang, 0)
      if (id) {
        const po = this.repo.po(id)
        if (!po || po.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        if (po.status !== 'draft') throw new AppError('NOT_EDITABLE', { status: po.status })
        this.repo.updatePo(id, { supplier_id: input.supplierId, expected_at: input.expectedAt, note: input.note ?? null, total_satang: total }, at)
      } else {
        id = uuidv7(at)
        this.repo.insertPo({
          id,
          branch_id: actor.branchId,
          po_no: this.docs.nextDocNo(actor.branchId, 'PO', at),
          supplier_id: input.supplierId,
          status: 'draft',
          expected_at: input.expectedAt,
          total_satang: total,
          note: input.note ?? null,
          created_by: actor.userId,
          created_at: at,
          updated_at: at,
        })
      }
      const poId = id
      this.repo.replacePoLines(
        poId,
        input.lines.map((l, i) => ({ id: uuidv7(at), po_id: poId, ingredient_id: l.ingredientId, qty_ordered_milli: l.qtyOrderedMilli, qty_received_milli: 0, line_total_satang: l.lineTotalSatang, sort_order: i })),
      )
      this.audit.append({ action: 'purchasing.po_save', permission: 'inventory:create', userId: actor.userId, branchId: actor.branchId, entity: 'purchase_orders', entityId: poId, after: { lines: input.lines, totalSatang: total } })
    }).immediate()
    return this.poDto(this.repo.po(id!)!)
  }

  setStatus(actor: Actor, id: string, status: 'ordered' | 'cancelled'): PurchaseOrderDto {
    const at = this.now()
    this.db.transaction(() => {
      const po = this.repo.po(id)
      if (!po || po.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
      const allowed = status === 'ordered' ? po.status === 'draft' : po.status === 'draft' || po.status === 'ordered'
      if (!allowed) throw new AppError('NOT_EDITABLE', { status: po.status })
      this.repo.updatePo(id, { status, ...(status === 'ordered' ? { ordered_at: at } : {}) }, at)
      this.audit.append({ action: `purchasing.po_${status}`, permission: 'inventory:update', userId: actor.userId, branchId: actor.branchId, entity: 'purchase_orders', entityId: id, before: { status: po.status }, after: { status } })
    }).immediate()
    return this.poDto(this.repo.po(id)!)
  }

  /** Goods receipt: one lot per line (expiry required for FEFO ingredients), PO progress, shortage settlement. */
  receive(actor: Actor, input: ParsedInput<'purchasing.receive'>) {
    const at = this.now()
    return this.db.transaction(() => {
      let po: PoRow | undefined
      if (input.poId) {
        po = this.repo.po(input.poId)
        if (!po || po.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        if (po.status !== 'ordered' && po.status !== 'partial' && po.status !== 'draft') throw new AppError('NOT_EDITABLE', { status: po.status })
      }
      const receiptId = uuidv7(at)
      const receiptNo = this.docs.nextDocNo(actor.branchId, 'R', at)
      this.repo.insertReceipt({ id: receiptId, branch_id: actor.branchId, receipt_no: receiptNo, po_id: po?.id ?? null, supplier_id: input.supplierId ?? po?.supplier_id ?? null, received_by: actor.userId, received_at: at, note: input.note ?? null, created_at: at })
      const ctx = this.ctx(actor, at)
      const lotIds: string[] = []
      let settled = 0
      input.lines.forEach((l, i) => {
        const ing = this.ingredient(actor, l.ingredientId)
        if (ing.has_expiry === 1 && l.expiresAt === null) throw new AppError('INVALID_INPUT', { fields: { [`lines.${i}.expiresAt`]: ['required'] } })
        if (l.poLineId) {
          const pl = this.repo.poLine(l.poLineId)
          if (!pl || pl.po_id !== po?.id || pl.ingredient_id !== l.ingredientId) throw new AppError('INVALID_INPUT', { fields: { [`lines.${i}.poLineId`]: ['mismatch'] } })
          this.repo.addReceived(pl.id, l.qtyMilli)
        }
        const r = this.stock.receive(ctx, {
          ingredientId: l.ingredientId,
          qtyMilli: l.qtyMilli,
          totalCostSatang: l.totalCostSatang,
          expiresAt: l.expiresAt,
          lotNo: l.lotNo ?? null,
          receivedAt: at,
          receiptId,
          poLineId: l.poLineId,
          refType: 'stock_receipt',
          refId: receiptId,
        })
        lotIds.push(r.lotId)
        settled += r.settledMilli
      })
      if (po) {
        const lines = this.repo.poLines(po.id)
        const full = lines.every((l) => l.qty_received_milli >= l.qty_ordered_milli)
        this.repo.updatePo(po.id, { status: full ? 'received' : 'partial', ...(po.ordered_at ? {} : { ordered_at: at }) }, at)
      }
      this.audit.append({
        action: 'inventory.receive',
        permission: 'inventory:create',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'stock_receipts',
        entityId: receiptId,
        after: { receiptNo, poId: po?.id ?? null, lines: input.lines.map((l) => ({ ingredientId: l.ingredientId, qtyMilli: l.qtyMilli, totalCostSatang: l.totalCostSatang, expiresAt: l.expiresAt })), settledShortageMilli: settled },
      })
      return { receiptId, receiptNo, lotIds, settledMilli: settled }
    }).immediate()
  }

  // ===========================================================================
  // stock counts (draft → pending → approved / rejected)
  // ===========================================================================

  counts(actor: Actor, openOnly: boolean): StockCountDto[] {
    return this.repo.counts(actor.branchId, openOnly).map((c) => this.countDto(c))
  }

  getCount(actor: Actor, id: string): StockCountDto {
    return this.countDto(this.mustCount(actor, id))
  }

  private mustCount(actor: Actor, id: string): CountRow {
    const c = this.repo.count(id)
    if (!c || c.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    return c
  }

  private countDto(c: CountRow): StockCountDto {
    const lines = this.repo.countLines(c.id).map((l) => this.countLineDto(l))
    return {
      id: c.id,
      countNo: c.count_no,
      kind: c.kind,
      status: c.status,
      note: c.note,
      createdByName: this.repo.userName(c.created_by) ?? '',
      createdById: c.created_by,
      createdAt: c.created_at,
      submittedAt: c.submitted_at,
      decidedByName: this.repo.userName(c.decided_by),
      decidedAt: c.decided_at,
      rejectReason: c.reject_reason,
      lines,
      totalDiffValueSatang: lines.reduce((s, l) => s + (l.diffValueSatang ?? 0), 0),
    }
  }

  private countLineDto(l: CountLineRow) {
    const ing = this.stock.repo.ingredient(l.ingredient_id)
    const diff = l.counted_qty_milli === null ? null : l.counted_qty_milli - l.system_qty_milli
    return {
      id: l.id,
      ingredientId: l.ingredient_id,
      ingredientName: ing?.name ?? '',
      baseUnit: ing?.base_unit ?? ('pcs' as const),
      systemQtyMilli: l.system_qty_milli,
      countedQtyMilli: l.counted_qty_milli,
      diffMilli: diff,
      diffValueSatang: diff === null || diff === 0 ? (diff === 0 ? 0 : null) : Math.sign(diff) * this.estimateValue(l.ingredient_id, Math.abs(diff)),
      reason: l.reason,
    }
  }

  /** Snapshots lot quantity and open shortages of every included ingredient. */
  createCount(actor: Actor, input: ParsedInput<'counts.create'>): StockCountDto {
    const at = this.now()
    const all = this.stock.repo.ingredientsWithStock(actor.branchId)
    const picked = input.ingredientIds.length
      ? input.ingredientIds.map((id) => {
          this.ingredient(actor, id)
          return all.find((i) => i.id === id)!
        })
      : input.kind === 'daily'
        ? all.filter((i) => i.is_daily_count === 1)
        : all
    const id = uuidv7(at)
    this.db.transaction(() => {
      this.repo.insertCount({ id, branch_id: actor.branchId, count_no: this.docs.nextDocNo(actor.branchId, 'C', at), kind: input.kind, status: 'draft', note: input.note ?? null, created_by: actor.userId, created_at: at, updated_at: at })
      for (const i of picked) {
        this.repo.insertCountLine({ id: uuidv7(at), count_id: id, ingredient_id: i.id, system_qty_milli: i.on_hand_milli - i.shortage_milli, lot_qty_milli: i.on_hand_milli, counted_qty_milli: null, reason: null, counted_at: null })
      }
      this.audit.append({ action: 'stock.count_create', permission: 'inventory:create', userId: actor.userId, branchId: actor.branchId, entity: 'stock_counts', entityId: id, after: { kind: input.kind, lines: picked.length } })
    }).immediate()
    return this.getCount(actor, id)
  }

  saveCountLines(actor: Actor, input: ParsedInput<'counts.saveLines'>): StockCountDto {
    const at = this.now()
    this.db.transaction(() => {
      const c = this.mustCount(actor, input.id)
      if (c.status !== 'draft') throw new AppError('NOT_EDITABLE', { status: c.status })
      for (const l of input.lines) {
        if (!this.repo.updateCountLine(c.id, l.ingredientId, l.countedQtyMilli, l.reason?.trim() || null, at)) throw new AppError('NOT_FOUND', { ingredientId: l.ingredientId })
      }
      this.repo.updateCount(c.id, {}, at)
    }).immediate()
    return this.getCount(actor, input.id)
  }

  submitCount(actor: Actor, id: string): StockCountDto {
    const at = this.now()
    this.db.transaction(() => {
      const c = this.mustCount(actor, id)
      if (c.status !== 'draft') throw new AppError('NOT_EDITABLE', { status: c.status })
      const lines = this.repo.countLines(id)
      const missing = lines.filter((l) => l.counted_qty_milli === null || (l.counted_qty_milli !== l.system_qty_milli && !l.reason))
      if (missing.length) throw new AppError('REASON_REQUIRED', { ingredientIds: missing.map((l) => l.ingredient_id) })
      this.repo.updateCount(id, { status: 'pending', submitted_at: at }, at)
      this.audit.append({ action: 'stock.count_submit', permission: 'inventory:create', userId: actor.userId, branchId: actor.branchId, entity: 'stock_counts', entityId: id })
    }).immediate()
    return this.getCount(actor, id)
  }

  /**
   * Approve: lots are adjusted by (counted − lot quantity at snapshot) with 'count_adjust' ledger rows,
   * shortages that existed at snapshot time are written off. Audited as high risk.
   */
  approveCount(actor: Actor, id: string): StockCountDto {
    const at = this.now()
    this.db.transaction(() => {
      const c = this.mustCount(actor, id)
      if (c.status !== 'pending') throw new AppError('NOT_EDITABLE', { status: c.status })
      if (this.settings.get('stock.count_separate_approver') && c.created_by === actor.userId) throw new AppError('SAME_APPROVER')
      const ctx = this.ctx(actor, at)
      const changes: unknown[] = []
      for (const l of this.repo.countLines(id)) {
        const counted = l.counted_qty_milli ?? l.system_qty_milli
        for (const s of this.stock.repo.openShortages(l.ingredient_id)) {
          if (s.created_at <= c.created_at) this.stock.repo.updateShortage(s.id, { settled_milli: s.settled_milli, status: 'written_off' }, at)
        }
        const delta = counted - l.lot_qty_milli
        // stock may have been sold since the snapshot: record any gap as a shortage instead of failing
        this.adjustLots(ctx, l.ingredient_id, delta, 'count_adjust', 'stock_count_line', l.id, true)
        if (counted !== l.system_qty_milli) changes.push({ ingredientId: l.ingredient_id, systemQtyMilli: l.system_qty_milli, countedQtyMilli: counted, reason: l.reason })
      }
      this.repo.updateCount(id, { status: 'approved', decided_by: actor.userId, decided_at: at }, at)
      this.audit.append({
        action: 'stock.count_approve',
        permission: 'inventory:approve_count',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'stock_counts',
        entityId: id,
        before: { status: 'pending' },
        after: { status: 'approved', changes },
        risk: 'high',
      })
    }).immediate()
    return this.getCount(actor, id)
  }

  rejectCount(actor: Actor, id: string, reason: string): StockCountDto {
    const at = this.now()
    this.db.transaction(() => {
      const c = this.mustCount(actor, id)
      if (c.status !== 'pending') throw new AppError('NOT_EDITABLE', { status: c.status })
      this.repo.updateCount(id, { status: 'rejected', decided_by: actor.userId, decided_at: at, reject_reason: reason }, at)
      this.audit.append({ action: 'stock.count_reject', permission: 'inventory:approve_count', userId: actor.userId, branchId: actor.branchId, entity: 'stock_counts', entityId: id, reason, risk: 'medium' })
    }).immediate()
    return this.getCount(actor, id)
  }

  // ===========================================================================
  // waste (§6.8)
  // ===========================================================================

  recordWaste(actor: Actor, input: ParsedInput<'waste.record'>): WasteDto {
    const at = this.now()
    const id = uuidv7(at)
    this.db.transaction(() => {
      const ctx = this.ctx(actor, at)
      const shift = this.shifts.repo.openShiftForDevice(ctx.deviceId!) ?? null
      let row: Omit<WasteRow, 'voided_at' | 'voided_by' | 'void_reason' | 'value_satang' | 'waste_no'>
      let value: number
      if (input.kind === 'ingredient') {
        const ing = this.ingredient(actor, input.ingredientId)
        if (input.lotId && this.stock.repo.lot(input.lotId)?.ingredient_id !== ing.id) throw new AppError('NOT_FOUND', { entity: 'stock_lots' })
        value = this.stock.deduct(ctx, 'waste_record', id, [{ ingredientId: ing.id, qtyMilli: input.qtyMilli }], { reason: 'waste', allowShortage: false, lotId: input.lotId }).costSatang
        row = { id, branch_id: actor.branchId, kind: 'ingredient', ingredient_id: ing.id, lot_id: input.lotId, product_id: null, size_id: null, qty_milli: input.qtyMilli, reason: input.reason, note: input.note ?? null, shift_id: shift?.id ?? null, created_by: actor.userId, created_at: at }
      } else {
        const p = this.catalog.saleable(actor.branchId, input.productId)
        if (!p) throw new AppError('PRODUCT_UNAVAILABLE')
        const size = input.sizeId ? p.sizes.find((s) => s.id === input.sizeId) : (p.sizes.find((s) => s.isDefault) ?? p.sizes[0])
        if (!size) throw new AppError('PRODUCT_UNAVAILABLE')
        const mods = p.groups.flatMap((g) => g.options).filter((o) => input.optionIds.includes(o.id)).map((o) => o.items)
        const req = scaleRequirement(requirementPerUnit(p.recipe, { id: size.id, multiplierMilli: size.multiplierMilli }, mods), input.qty)
        value = this.stock.deduct(ctx, 'waste_record', id, req, { reason: 'waste', allowShortage: true }).costSatang
        row = { id, branch_id: actor.branchId, kind: 'drink', ingredient_id: null, lot_id: null, product_id: p.product.id, size_id: size.id, qty_milli: input.qty * 1000, reason: input.reason, note: input.note ?? null, shift_id: shift?.id ?? null, created_by: actor.userId, created_at: at }
      }
      this.repo.insertWaste({ ...row, waste_no: this.docs.nextDocNo(actor.branchId, 'W', at), value_satang: value })
      this.audit.append({ action: 'waste.record', permission: 'inventory:create', userId: actor.userId, branchId: actor.branchId, entity: 'waste_records', entityId: id, after: { ...input, valueSatang: value }, risk: 'medium' })
    }).immediate()
    return this.wasteDto(this.repo.waste(id)!)
  }

  voidWaste(actor: Actor, id: string, reason: string): WasteDto {
    const at = this.now()
    this.db.transaction(() => {
      const w = this.repo.waste(id)
      if (!w || w.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
      if (w.voided_at) throw new AppError('NOT_EDITABLE')
      this.stock.reverse(this.ctx(actor, at), 'waste_record', [id], 'waste_reversal')
      this.repo.voidWaste(id, actor.userId, reason, at)
      this.audit.append({ action: 'waste.void', permission: 'inventory:update', userId: actor.userId, branchId: actor.branchId, entity: 'waste_records', entityId: id, before: { valueSatang: w.value_satang }, reason, risk: 'high' })
    }).immediate()
    return this.wasteDto(this.repo.waste(id)!)
  }

  wasteList(actor: Actor, q: ParsedInput<'waste.list'>) {
    const { rows, total } = this.repo.wasteList(actor.branchId, q.reason, q.pageSize, (q.page - 1) * q.pageSize)
    return { items: rows.map((w) => this.wasteDto(w)), total }
  }

  private wasteDto(w: WasteRow): WasteDto {
    const ing = w.ingredient_id ? this.stock.repo.ingredient(w.ingredient_id) : undefined
    const product = w.product_id ? this.catalog.repo.product(w.product_id) ?? this.db.prepare('SELECT * FROM products WHERE id = ?').get(w.product_id) : undefined
    const size = w.size_id ? this.catalog.repo.size(w.size_id) : undefined
    const productName = (product as { name?: string } | undefined)?.name ?? ''
    return {
      id: w.id,
      wasteNo: w.waste_no,
      kind: w.kind,
      itemName: w.kind === 'ingredient' ? (ing?.name ?? '') : `${productName}${size && this.catalog.repo.sizes(w.product_id!).length > 1 ? ` (${size.label})` : ''}`,
      qtyMilli: w.qty_milli,
      unit: w.kind === 'ingredient' ? (ing?.base_unit ?? 'pcs') : 'cup',
      reason: w.reason,
      note: w.note,
      valueSatang: w.value_satang,
      createdByName: this.repo.userName(w.created_by) ?? '',
      createdAt: w.created_at,
      voided: w.voided_at !== null,
    }
  }

  expiring(actor: Actor, withinDays: number): ExpiringLotDto[] {
    return this.repo.expiringLots(actor.branchId, this.now() + withinDays * 86_400_000).map((l) => ({
      lotId: l.id,
      ingredientId: l.ingredient_id,
      ingredientName: l.ingredient_name,
      baseUnit: l.base_unit,
      lotNo: l.lot_no,
      qtyRemainingMilli: l.qty_remaining_milli,
      valueSatang: consumedCost({ qtyReceivedMilli: l.qty_received_milli, totalCostSatang: l.total_cost_satang }, 0) - consumedCost({ qtyReceivedMilli: l.qty_received_milli, totalCostSatang: l.total_cost_satang }, l.qty_remaining_milli),
      expiresAt: l.expires_at,
    }))
  }

  wasteSummary(actor: Actor, from: number, to: number): WasteSummaryDto {
    const byReason = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<WasteReason, number>
    for (const r of this.repo.wasteByReason(actor.branchId, from, to)) byReason[r.reason as WasteReason] = r.total
    const totalSatang = Object.values(byReason).reduce((a, b) => a + b, 0)
    const salesSatang = this.repo.salesTotal(actor.branchId, from, to)
    return { from, to, totalSatang, byReason, salesSatang, wasteRatioBp: salesSatang > 0 ? mulDivHalfUp(totalSatang, 10_000, salesSatang) : null }
  }

  // ===========================================================================
  // manual adjustment (inventory:adjust)
  // ===========================================================================

  adjust(actor: Actor, input: ParsedInput<'inventory.adjust'>) {
    if (!can(actor, 'inventory:adjust')) throw new AppError('FORBIDDEN')
    const ing = this.ingredient(actor, input.ingredientId)
    const at = this.now()
    this.db.transaction(() => {
      const before = this.onHand(ing.id)
      const refId = uuidv7(at)
      this.adjustLots(this.ctx(actor, at), ing.id, input.deltaMilli, 'adjust', 'manual_adjust', refId, false)
      this.audit.append({
        action: 'inventory.adjust',
        permission: 'inventory:adjust',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'ingredients',
        entityId: ing.id,
        before: { onHandMilli: before },
        after: { onHandMilli: this.onHand(ing.id), deltaMilli: input.deltaMilli },
        reason: input.reason,
        risk: 'high',
      })
    }).immediate()
    return { ingredientId: ing.id, onHandMilli: this.onHand(ing.id) }
  }

  private onHand(ingredientId: string): number {
    return this.stock.repo.lotsOf(ingredientId).reduce((s, l) => s + l.qty_remaining_milli, 0)
  }
}
