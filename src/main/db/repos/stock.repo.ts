import type { Db } from '../connection'

export interface IngredientRow {
  id: string
  branch_id: string
  name: string
  base_unit: 'ml' | 'g' | 'pcs'
  pack_size_milli: number
  min_qty_milli: number
  has_expiry: 0 | 1
  default_size_mode: 'scale' | 'fixed' | 'custom'
  is_daily_count: 0 | 1
  created_at: number
  updated_at: number
  deleted_at: number | null
  rev: number
}

export interface LotRow {
  id: string
  branch_id: string
  ingredient_id: string
  lot_no: string | null
  receipt_id: string | null
  source: 'receive' | 'count_adjust' | 'opening'
  qty_received_milli: number
  qty_remaining_milli: number
  total_cost_satang: number
  received_at: number
  expires_at: number | null
  created_at: number
  updated_at: number
}

export interface LedgerRow {
  id: string
  branch_id: string
  ingredient_id: string
  lot_id: string
  delta_qty_milli: number
  cost_satang: number
  reason: string
  ref_type: string | null
  ref_id: string | null
  reverses_id: string | null
  user_id: string | null
  device_id: string | null
  created_at: number
}

export interface ShortageRow {
  id: string
  branch_id: string
  ingredient_id: string
  qty_milli: number
  settled_milli: number
  status: 'open' | 'settled' | 'cancelled' | 'written_off'
  ref_type: string
  ref_id: string
  created_by: string | null
  created_at: number
  updated_at: number
}

export interface IngredientStock extends IngredientRow {
  on_hand_milli: number
  shortage_milli: number
  next_expiry: number | null
  lot_count: number
}

/** Ingredients, lots, stock ledger (append-only) and shortages. */
export class StockRepo {
  constructor(private readonly db: Db) {}

  // ---- ingredients --------------------------------------------------------

  ingredient(id: string): IngredientRow | undefined {
    return this.db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id) as IngredientRow | undefined
  }

  ingredientsWithStock(branchId: string): IngredientStock[] {
    return this.db
      .prepare(
        `SELECT i.*,
           ifnull((SELECT sum(qty_remaining_milli) FROM stock_lots l WHERE l.ingredient_id = i.id), 0) AS on_hand_milli,
           ifnull((SELECT sum(qty_milli - settled_milli) FROM stock_shortages s WHERE s.ingredient_id = i.id AND s.status = 'open'), 0) AS shortage_milli,
           (SELECT min(expires_at) FROM stock_lots l WHERE l.ingredient_id = i.id AND l.qty_remaining_milli > 0) AS next_expiry,
           (SELECT count(*) FROM stock_lots l WHERE l.ingredient_id = i.id AND l.qty_remaining_milli > 0) AS lot_count
         FROM ingredients i WHERE i.branch_id = ? AND i.deleted_at IS NULL ORDER BY i.name`,
      )
      .all(branchId) as IngredientStock[]
  }

  insertIngredient(row: Omit<IngredientRow, 'deleted_at' | 'rev'>): void {
    this.db
      .prepare(
        `INSERT INTO ingredients (id, branch_id, name, base_unit, pack_size_milli, min_qty_milli, has_expiry,
           default_size_mode, is_daily_count, created_at, updated_at)
         VALUES (@id, @branch_id, @name, @base_unit, @pack_size_milli, @min_qty_milli, @has_expiry,
           @default_size_mode, @is_daily_count, @created_at, @updated_at)`,
      )
      .run(row)
  }

  updateIngredient(id: string, patch: Partial<Omit<IngredientRow, 'id' | 'branch_id' | 'created_at' | 'rev'>>, now: number): void {
    const keys = Object.keys(patch)
    if (!keys.length) return
    this.db
      .prepare(`UPDATE ingredients SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now, rev = rev + 1 WHERE id = @__id`)
      .run({ ...patch, __now: now, __id: id })
  }

  // ---- lots ---------------------------------------------------------------

  lot(id: string): LotRow | undefined {
    return this.db.prepare('SELECT * FROM stock_lots WHERE id = ?').get(id) as LotRow | undefined
  }

  availableLots(ingredientId: string): LotRow[] {
    return this.db
      .prepare('SELECT * FROM stock_lots WHERE ingredient_id = ? AND qty_remaining_milli > 0')
      .all(ingredientId) as LotRow[]
  }

  lotsOf(ingredientId: string): LotRow[] {
    return this.db
      .prepare('SELECT * FROM stock_lots WHERE ingredient_id = ? ORDER BY qty_remaining_milli = 0, expires_at IS NULL, expires_at, received_at')
      .all(ingredientId) as LotRow[]
  }

  insertLot(row: Omit<LotRow, 'receipt_id'> & { receipt_id?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO stock_lots (id, branch_id, ingredient_id, lot_no, receipt_id, source, qty_received_milli,
           qty_remaining_milli, total_cost_satang, received_at, expires_at, created_at, updated_at)
         VALUES (@id, @branch_id, @ingredient_id, @lot_no, @receipt_id, @source, @qty_received_milli,
           @qty_remaining_milli, @total_cost_satang, @received_at, @expires_at, @created_at, @updated_at)`,
      )
      .run({ receipt_id: null, ...row })
  }

  /** Adds (positive) or removes (negative) quantity; the CHECK constraint rejects going below zero. */
  moveLot(lotId: string, deltaMilli: number, now: number): void {
    this.db
      .prepare('UPDATE stock_lots SET qty_remaining_milli = qty_remaining_milli + ?, updated_at = ? WHERE id = ?')
      .run(deltaMilli, now, lotId)
  }

  // ---- ledger (append-only) ----------------------------------------------

  insertLedger(row: LedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO stock_ledger (id, branch_id, ingredient_id, lot_id, delta_qty_milli, cost_satang, reason,
           ref_type, ref_id, reverses_id, user_id, device_id, created_at)
         VALUES (@id, @branch_id, @ingredient_id, @lot_id, @delta_qty_milli, @cost_satang, @reason,
           @ref_type, @ref_id, @reverses_id, @user_id, @device_id, @created_at)`,
      )
      .run(row)
  }

  /** 'sale' rows for the given refs that have not been reversed yet. */
  unreversedSales(refType: string, refIds: readonly string[]): LedgerRow[] {
    if (!refIds.length) return []
    return this.db
      .prepare(
        `SELECT l.* FROM stock_ledger l
         WHERE l.reason = 'sale' AND l.ref_type = ? AND l.ref_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_id = l.id)
         ORDER BY l.created_at, l.id`,
      )
      .all(refType, JSON.stringify(refIds)) as LedgerRow[]
  }

  ledgerFor(refType: string, refIds: readonly string[]): LedgerRow[] {
    if (!refIds.length) return []
    return this.db
      .prepare(`SELECT * FROM stock_ledger WHERE ref_type = ? AND ref_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`)
      .all(refType, JSON.stringify(refIds)) as LedgerRow[]
  }

  // ---- shortages ----------------------------------------------------------

  insertShortage(row: Omit<ShortageRow, 'settled_milli' | 'status'>): void {
    this.db
      .prepare(
        `INSERT INTO stock_shortages (id, branch_id, ingredient_id, qty_milli, ref_type, ref_id, created_by, created_at, updated_at)
         VALUES (@id, @branch_id, @ingredient_id, @qty_milli, @ref_type, @ref_id, @created_by, @created_at, @updated_at)`,
      )
      .run(row)
  }

  openShortages(ingredientId: string): ShortageRow[] {
    return this.db
      .prepare(`SELECT * FROM stock_shortages WHERE ingredient_id = ? AND status = 'open' ORDER BY created_at, id`)
      .all(ingredientId) as ShortageRow[]
  }

  shortagesFor(refType: string, refIds: readonly string[]): ShortageRow[] {
    if (!refIds.length) return []
    return this.db
      .prepare(`SELECT * FROM stock_shortages WHERE ref_type = ? AND ref_id IN (SELECT value FROM json_each(?))`)
      .all(refType, JSON.stringify(refIds)) as ShortageRow[]
  }

  updateShortage(id: string, patch: Pick<ShortageRow, 'settled_milli' | 'status'>, now: number): void {
    this.db
      .prepare('UPDATE stock_shortages SET settled_milli = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(patch.settled_milli, patch.status, now, id)
  }
}
