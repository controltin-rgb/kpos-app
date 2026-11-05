import type { Db } from '@main/db/connection'
import { StockRepo, type LotRow } from '@main/db/repos/stock.repo'
import type { Requirement } from '@shared/bom'
import { uuidv7 } from '@shared/id'
import { AppError } from '@shared/errors'
import { allocateFromLots } from './allocate'

export interface DeductOptions {
  /** ledger reason (default 'sale') */
  reason?: 'sale' | 'waste' | 'count_adjust' | 'adjust'
  /** false → throw STOCK_INSUFFICIENT instead of recording a shortage */
  allowShortage?: boolean
  /** take only from this lot (e.g. writing off a near-expiry lot) */
  lotId?: string | null
}

export type DeductResult = ShortageNotice[] & { costSatang: number }

export interface StockContext {
  branchId: string
  userId: string | null
  deviceId: string | null
  at: number
}

export interface ShortageNotice {
  ingredientId: string
  ingredientName: string
  baseUnit: string
  qtyMilli: number
}

const toAlloc = (l: LotRow) => ({
  id: l.id,
  qtyReceivedMilli: l.qty_received_milli,
  qtyRemainingMilli: l.qty_remaining_milli,
  totalCostSatang: l.total_cost_satang,
  receivedAt: l.received_at,
  expiresAt: l.expires_at,
})

/**
 * Stock movements. Every method is synchronous and must run inside the caller's
 * BEGIN IMMEDIATE transaction (CLAUDE.md rule 2) — it never opens one itself.
 * stock_ledger is append-only (rule 3): corrections are new rows that reference `reverses_id`.
 */
export class StockService {
  readonly repo: StockRepo

  constructor(private readonly db: Db) {
    this.repo = new StockRepo(db)
  }

  private assertTx() {
    if (!this.db.inTransaction) throw new Error('stock movements must run inside a transaction')
  }

  /**
   * Deducts `requirements` for one document line (e.g. a bill item), FEFO/FIFO per ingredient.
   * What the lots cannot cover is recorded as a shortage (D16) and returned so the UI can warn.
   */
  deduct(ctx: StockContext, refType: string, refId: string, requirements: readonly Requirement[], opts: DeductOptions = {}): DeductResult {
    this.assertTx()
    const reason = opts.reason ?? 'sale'
    const notices: ShortageNotice[] = []
    let costSatang = 0
    for (const req of requirements) {
      const ing = this.repo.ingredient(req.ingredientId)
      if (!ing) throw new Error(`ingredient ${req.ingredientId} not found`)
      let lots = this.repo.availableLots(ing.id)
      if (opts.lotId) lots = lots.filter((l) => l.id === opts.lotId)
      const { takes, shortageMilli } = allocateFromLots(lots.map(toAlloc), req.qtyMilli, ing.has_expiry === 1)
      if (shortageMilli > 0 && opts.allowShortage === false) throw new AppError('STOCK_INSUFFICIENT', { ingredientId: ing.id, shortMilli: shortageMilli })
      for (const t of takes) {
        this.repo.moveLot(t.lotId, -t.qtyMilli, ctx.at)
        this.repo.insertLedger({
          id: uuidv7(ctx.at),
          branch_id: ctx.branchId,
          ingredient_id: ing.id,
          lot_id: t.lotId,
          delta_qty_milli: -t.qtyMilli,
          cost_satang: -t.costSatang,
          reason,
          ref_type: refType,
          ref_id: refId,
          reverses_id: null,
          user_id: ctx.userId,
          device_id: ctx.deviceId,
          created_at: ctx.at,
        })
        costSatang += t.costSatang
      }
      if (shortageMilli > 0) {
        this.repo.insertShortage({
          id: uuidv7(ctx.at),
          branch_id: ctx.branchId,
          ingredient_id: ing.id,
          qty_milli: shortageMilli,
          ref_type: refType,
          ref_id: refId,
          created_by: ctx.userId,
          created_at: ctx.at,
          updated_at: ctx.at,
        })
        notices.push({ ingredientId: ing.id, ingredientName: ing.name, baseUnit: ing.base_unit, qtyMilli: shortageMilli })
      }
    }
    return Object.assign(notices, { costSatang })
  }

  /**
   * Puts back everything taken for the given document lines — into the SAME lots, at the same cost
   * (bom snapshot at sale time, not the current recipe) — including stock that later settled a
   * shortage of those lines. Open shortages of those lines are cancelled.
   */
  reverse(ctx: StockContext, refType: string, refIds: readonly string[], reason: 'void_reversal' | 'refund_reversal' | 'waste_reversal'): void {
    this.assertTx()
    const shortages = this.repo.shortagesFor(refType, refIds)
    const original = reason === 'waste_reversal' ? 'waste' : 'sale'
    const rows = [
      ...this.repo.unreversedSales(refType, refIds, original),
      ...this.repo.unreversedSales('stock_shortage', shortages.map((s) => s.id)),
    ]
    for (const row of rows) {
      this.repo.moveLot(row.lot_id, -row.delta_qty_milli, ctx.at)
      this.repo.insertLedger({
        id: uuidv7(ctx.at),
        branch_id: row.branch_id,
        ingredient_id: row.ingredient_id,
        lot_id: row.lot_id,
        delta_qty_milli: -row.delta_qty_milli,
        cost_satang: -row.cost_satang,
        reason,
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        reverses_id: row.id,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        created_at: ctx.at,
      })
    }
    for (const s of shortages) {
      if (s.status === 'open' || s.status === 'settled') this.repo.updateShortage(s.id, { settled_milli: s.settled_milli, status: 'cancelled' }, ctx.at)
    }
  }

  /** Adds a lot (receiving without PO / opening stock) and settles open shortages from stock (D16). */
  receive(
    ctx: StockContext,
    input: {
      ingredientId: string
      qtyMilli: number
      totalCostSatang: number
      expiresAt: number | null
      lotNo: string | null
      receivedAt: number
      source?: 'receive' | 'opening' | 'count_adjust'
      /** ledger reason; defaults to 'receive' ('opening' for source opening) */
      reason?: 'receive' | 'opening' | 'count_adjust' | 'adjust'
      receiptId?: string | null
      poLineId?: string | null
      refType?: string
      refId?: string
    },
  ): { lotId: string; settledMilli: number } {
    this.assertTx()
    const lotId = uuidv7(ctx.at)
    this.repo.insertLot({
      id: lotId,
      branch_id: ctx.branchId,
      ingredient_id: input.ingredientId,
      lot_no: input.lotNo,
      receipt_id: input.receiptId ?? null,
      po_line_id: input.poLineId ?? null,
      source: input.source ?? 'receive',
      qty_received_milli: input.qtyMilli,
      qty_remaining_milli: input.qtyMilli,
      total_cost_satang: input.totalCostSatang,
      received_at: input.receivedAt,
      expires_at: input.expiresAt,
      created_at: ctx.at,
      updated_at: ctx.at,
    })
    this.repo.insertLedger({
      id: uuidv7(ctx.at),
      branch_id: ctx.branchId,
      ingredient_id: input.ingredientId,
      lot_id: lotId,
      delta_qty_milli: input.qtyMilli,
      cost_satang: input.totalCostSatang,
      reason: input.reason ?? (input.source === 'opening' ? 'opening' : 'receive'),
      ref_type: input.refType ?? 'stock_lot',
      ref_id: input.refId ?? lotId,
      reverses_id: null,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      created_at: ctx.at,
    })
    return { lotId, settledMilli: this.settleShortages(ctx, input.ingredientId) }
  }

  /** Deducts outstanding shortages (oldest first) from available lots. Returns the quantity settled. */
  settleShortages(ctx: StockContext, ingredientId: string): number {
    this.assertTx()
    const ing = this.repo.ingredient(ingredientId)
    if (!ing) return 0
    let settled = 0
    for (const s of this.repo.openShortages(ingredientId)) {
      const outstanding = s.qty_milli - s.settled_milli
      const { takes } = allocateFromLots(this.repo.availableLots(ingredientId).map(toAlloc), outstanding, ing.has_expiry === 1)
      if (!takes.length) break
      let got = 0
      for (const t of takes) {
        this.repo.moveLot(t.lotId, -t.qtyMilli, ctx.at)
        this.repo.insertLedger({
          id: uuidv7(ctx.at),
          branch_id: s.branch_id,
          ingredient_id: ingredientId,
          lot_id: t.lotId,
          delta_qty_milli: -t.qtyMilli,
          cost_satang: -t.costSatang,
          reason: 'sale',
          ref_type: 'stock_shortage',
          ref_id: s.id,
          reverses_id: null,
          user_id: ctx.userId,
          device_id: ctx.deviceId,
          created_at: ctx.at,
        })
        got += t.qtyMilli
      }
      const total = s.settled_milli + got
      this.repo.updateShortage(s.id, { settled_milli: total, status: total === s.qty_milli ? 'settled' : 'open' }, ctx.at)
      settled += got
      if (total < s.qty_milli) break // lots exhausted
    }
    return settled
  }
}
