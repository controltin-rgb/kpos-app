import type { Db } from '../connection'

const ins = (db: Db, table: string, row: object) => {
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row)
}

export interface PoRow {
  id: string
  branch_id: string
  po_no: string
  supplier_id: string | null
  status: 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled'
  ordered_at: number | null
  expected_at: number | null
  total_satang: number
  note: string | null
  created_by: string
  created_at: number
  updated_at: number
}

export interface PoLineRow {
  id: string
  po_id: string
  ingredient_id: string
  qty_ordered_milli: number
  qty_received_milli: number
  line_total_satang: number
  sort_order: number
}

export interface CountRow {
  id: string
  branch_id: string
  count_no: string
  kind: 'daily' | 'full'
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  note: string | null
  created_by: string
  submitted_at: number | null
  decided_by: string | null
  decided_at: number | null
  reject_reason: string | null
  created_at: number
  updated_at: number
}

export interface CountLineRow {
  id: string
  count_id: string
  ingredient_id: string
  system_qty_milli: number
  lot_qty_milli: number
  counted_qty_milli: number | null
  reason: string | null
  counted_at: number | null
}

export interface WasteRow {
  id: string
  branch_id: string
  waste_no: string
  kind: 'ingredient' | 'drink'
  ingredient_id: string | null
  lot_id: string | null
  product_id: string | null
  size_id: string | null
  qty_milli: number
  reason: 'expired' | 'wrong_made' | 'dropped' | 'customer_return' | 'other'
  note: string | null
  value_satang: number
  shift_id: string | null
  created_by: string
  created_at: number
  voided_at: number | null
  voided_by: string | null
  void_reason: string | null
}

/** Stock documents: suppliers, purchase orders, receipts, stock counts, waste records. */
export class StockDocsRepo {
  constructor(private readonly db: Db) {}

  private update(table: string, id: string, patch: Record<string, unknown>, now: number | null, rev = true) {
    const keys = Object.keys(patch)
    if (!keys.length) return
    const extra = [now !== null ? 'updated_at = @__now' : null, rev ? 'rev = rev + 1' : null].filter(Boolean).join(', ')
    this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')}${extra ? ', ' + extra : ''} WHERE id = @__id`).run({ ...patch, __now: now, __id: id })
  }

  // ---- suppliers ------------------------------------------------------------
  suppliers(branchId: string) {
    return this.db.prepare('SELECT * FROM suppliers WHERE branch_id = ? AND deleted_at IS NULL ORDER BY name').all(branchId) as {
      id: string
      branch_id: string
      name: string
      phone: string | null
      tax_id: string | null
      note: string | null
    }[]
  }
  supplier(id: string) {
    return this.db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; branch_id: string; name: string } | undefined
  }
  insertSupplier(row: { id: string; branch_id: string; name: string; phone: string | null; tax_id: string | null; note: string | null; created_at: number; updated_at: number }) {
    ins(this.db, 'suppliers', row)
  }
  updateSupplier(id: string, patch: Record<string, unknown>, now: number) {
    this.update('suppliers', id, patch, now)
  }

  // ---- purchase orders --------------------------------------------------------
  po(id: string): PoRow | undefined {
    return this.db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as PoRow | undefined
  }
  pos(branchId: string, openOnly: boolean): PoRow[] {
    return this.db
      .prepare(`SELECT * FROM purchase_orders WHERE branch_id = ? ${openOnly ? `AND status IN ('draft', 'ordered', 'partial')` : ''} ORDER BY created_at DESC`)
      .all(branchId) as PoRow[]
  }
  insertPo(row: Omit<PoRow, 'ordered_at'> & { ordered_at?: number | null }) {
    ins(this.db, 'purchase_orders', { ordered_at: null, ...row })
  }
  updatePo(id: string, patch: Partial<PoRow>, now: number) {
    this.update('purchase_orders', id, patch, now)
  }
  poLines(poId: string): PoLineRow[] {
    return this.db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY sort_order').all(poId) as PoLineRow[]
  }
  poLine(id: string): PoLineRow | undefined {
    return this.db.prepare('SELECT * FROM purchase_order_lines WHERE id = ?').get(id) as PoLineRow | undefined
  }
  replacePoLines(poId: string, rows: PoLineRow[]) {
    this.db.prepare('DELETE FROM purchase_order_lines WHERE po_id = ?').run(poId)
    for (const r of rows) ins(this.db, 'purchase_order_lines', r)
  }
  addReceived(lineId: string, qty: number) {
    this.db.prepare('UPDATE purchase_order_lines SET qty_received_milli = qty_received_milli + ? WHERE id = ?').run(qty, lineId)
  }
  insertReceipt(row: { id: string; branch_id: string; receipt_no: string; po_id: string | null; supplier_id: string | null; received_by: string; received_at: number; note: string | null; created_at: number }) {
    ins(this.db, 'stock_receipts', row)
  }

  // ---- counts -------------------------------------------------------------------
  count(id: string): CountRow | undefined {
    return this.db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id) as CountRow | undefined
  }
  counts(branchId: string, openOnly: boolean): CountRow[] {
    return this.db
      .prepare(`SELECT * FROM stock_counts WHERE branch_id = ? ${openOnly ? `AND status IN ('draft', 'pending')` : ''} ORDER BY created_at DESC`)
      .all(branchId) as CountRow[]
  }
  insertCount(row: Omit<CountRow, 'submitted_at' | 'decided_by' | 'decided_at' | 'reject_reason'>) {
    ins(this.db, 'stock_counts', row)
  }
  updateCount(id: string, patch: Partial<CountRow>, now: number) {
    this.update('stock_counts', id, patch, now, false)
  }
  countLines(countId: string): CountLineRow[] {
    return this.db.prepare('SELECT * FROM stock_count_lines WHERE count_id = ? ORDER BY rowid').all(countId) as CountLineRow[]
  }
  insertCountLine(row: CountLineRow) {
    ins(this.db, 'stock_count_lines', row)
  }
  updateCountLine(countId: string, ingredientId: string, counted: number | null, reason: string | null, at: number): number {
    return this.db
      .prepare('UPDATE stock_count_lines SET counted_qty_milli = ?, reason = ?, counted_at = ? WHERE count_id = ? AND ingredient_id = ?')
      .run(counted, reason, counted === null ? null : at, countId, ingredientId).changes
  }

  // ---- waste ----------------------------------------------------------------------
  waste(id: string): WasteRow | undefined {
    return this.db.prepare('SELECT * FROM waste_records WHERE id = ?').get(id) as WasteRow | undefined
  }
  wasteList(branchId: string, reason: string, limit: number, offset: number): { rows: WasteRow[]; total: number } {
    const where = `branch_id = @b ${reason !== 'all' ? 'AND reason = @r' : ''}`
    const p = { b: branchId, r: reason, limit, offset }
    return {
      rows: this.db.prepare(`SELECT * FROM waste_records WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(p) as WasteRow[],
      total: this.db.prepare(`SELECT count(*) FROM waste_records WHERE ${where}`).pluck().get(p) as number,
    }
  }
  insertWaste(row: Omit<WasteRow, 'voided_at' | 'voided_by' | 'void_reason'>) {
    ins(this.db, 'waste_records', row)
  }
  voidWaste(id: string, by: string, reason: string, at: number) {
    this.db.prepare('UPDATE waste_records SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL').run(at, by, reason, id)
  }
  wasteByReason(branchId: string, from: number, to: number): { reason: string; total: number }[] {
    return this.db
      .prepare(`SELECT reason, sum(value_satang) AS total FROM waste_records WHERE branch_id = ? AND voided_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY reason`)
      .all(branchId, from, to) as { reason: string; total: number }[]
  }
  salesTotal(branchId: string, from: number, to: number): number {
    return this.db
      .prepare(`SELECT ifnull(sum(total_satang), 0) FROM bills WHERE branch_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ?`)
      .pluck()
      .get(branchId, from, to) as number
  }
  expiringLots(branchId: string, until: number) {
    return this.db
      .prepare(
        `SELECT l.*, i.name AS ingredient_name, i.base_unit FROM stock_lots l JOIN ingredients i ON i.id = l.ingredient_id
         WHERE l.branch_id = ? AND l.qty_remaining_milli > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ? AND i.deleted_at IS NULL
         ORDER BY l.expires_at`,
      )
      .all(branchId, until) as {
      id: string
      ingredient_id: string
      ingredient_name: string
      base_unit: 'ml' | 'g' | 'pcs'
      lot_no: string | null
      qty_received_milli: number
      qty_remaining_milli: number
      total_cost_satang: number
      expires_at: number
    }[]
  }
  userName(id: string | null): string | null {
    if (!id) return null
    return (this.db.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(id) as string | undefined) ?? null
  }
}
