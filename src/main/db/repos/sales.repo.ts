import type { Db } from '../connection'

export interface BillRow {
  id: string
  branch_id: string
  bill_no: string
  device_id: string | null
  shift_id: string
  order_type: 'dine_in' | 'takeaway' | 'delivery'
  channel: 'grab' | 'lineman' | 'shopeefood' | 'foodpanda' | 'other' | null
  ext_order_id: string | null
  status: 'open' | 'paid' | 'void' | 'refunded'
  vat_mode: 'inclusive' | 'none'
  subtotal_satang: number
  discount_satang: number
  vat_satang: number
  total_satang: number
  commission_bp: number | null
  commission_satang: number | null
  member_id: string | null
  note: string | null
  created_by: string
  created_at: number
  paid_at: number | null
  voided_at: number | null
  voided_by: string | null
  void_approved_by: string | null
  void_reason: string | null
  updated_at: number
}

export interface BillItemRow {
  id: string
  bill_id: string
  line_no: number
  product_id: string
  size_id: string | null
  product_name: string
  size_label: string | null
  qty: number
  unit_price_satang: number
  discount_satang: number
  line_total_satang: number
  vat_type: string
  bom_snapshot_json: string
  note: string | null
}

export interface ShiftRow {
  id: string
  branch_id: string
  device_id: string | null
  shift_no: string
  status: 'open' | 'closed'
  opened_by: string
  opened_at: number
  opening_float_satang: number
  closed_by: string | null
  closed_at: number | null
  expected_cash_satang: number | null
  counted_cash_satang: number | null
  over_short_satang: number | null
  note: string | null
}

const ins = (db: Db, table: string, row: object) => {
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row)
}

/** Bills, items, payments, bill events (append-only), shifts and the cash ledger (append-only). */
export class SalesRepo {
  constructor(private readonly db: Db) {}

  // ---- bills --------------------------------------------------------------
  bill(id: string): BillRow | undefined {
    return this.db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as BillRow | undefined
  }
  insertBill(
    row: Omit<BillRow, 'member_id' | 'note' | 'voided_at' | 'voided_by' | 'void_approved_by' | 'void_reason'> &
      Partial<{ member_id: string | null; promotion_id: string | null; coupon_id: string | null; points_earned: number; points_redeemed: number }>,
  ) {
    ins(this.db, 'bills', row)
  }
  updateBill(id: string, patch: Partial<Pick<BillRow, 'status' | 'voided_at' | 'voided_by' | 'void_approved_by' | 'void_reason'>>, now: number) {
    const keys = Object.keys(patch)
    this.db
      .prepare(`UPDATE bills SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now, rev = rev + 1 WHERE id = @__id`)
      .run({ ...patch, __now: now, __id: id })
  }
  items(billId: string): BillItemRow[] {
    return this.db.prepare('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY line_no').all(billId) as BillItemRow[]
  }
  insertItem(row: BillItemRow) {
    ins(this.db, 'bill_items', row)
  }
  modifiers(itemIds: readonly string[]): { bill_item_id: string; group_name: string; option_name: string; price_satang: number; kds_highlight: number }[] {
    return this.db
      .prepare('SELECT * FROM bill_item_modifiers WHERE bill_item_id IN (SELECT value FROM json_each(?)) ORDER BY rowid')
      .all(JSON.stringify(itemIds)) as { bill_item_id: string; group_name: string; option_name: string; price_satang: number; kds_highlight: number }[]
  }
  insertModifier(row: { id: string; bill_item_id: string; option_id: string; group_name: string; option_name: string; price_satang: number; kds_highlight: number }) {
    ins(this.db, 'bill_item_modifiers', row)
  }
  payments(billId: string) {
    return this.db
      .prepare(
        `SELECT p.*, u.display_name AS confirmed_by_name FROM payments p LEFT JOIN users u ON u.id = p.confirmed_by
         WHERE p.bill_id = ? ORDER BY p.created_at`,
      )
      .all(billId) as {
      method: string
      amount_satang: number
      tendered_satang: number | null
      change_satang: number | null
      reference: string | null
      confirmed_by_name: string | null
    }[]
  }
  insertPayment(row: Record<string, unknown>) {
    ins(this.db, 'payments', row)
  }
  insertEvent(row: { id: string; bill_id: string; event: string; user_id: string; approved_by: string | null; reason: string | null; data_json: string; device_id: string | null; created_at: number }) {
    ins(this.db, 'bill_events', row)
  }
  events(billId: string) {
    return this.db
      .prepare(
        `SELECT e.event, e.created_at, e.reason, u.display_name AS user_name, a.display_name AS approver_name
         FROM bill_events e JOIN users u ON u.id = e.user_id LEFT JOIN users a ON a.id = e.approved_by
         WHERE e.bill_id = ? ORDER BY e.created_at, e.rowid`,
      )
      .all(billId) as { event: string; created_at: number; reason: string | null; user_name: string; approver_name: string | null }[]
  }

  list(f: { branchId: string; search?: string | undefined; status: string; from?: number | undefined; to?: number | undefined; limit: number; offset: number }) {
    const where = ['b.branch_id = @branchId']
    if (f.search) where.push(`b.bill_no LIKE @q ESCAPE '\\'`)
    if (f.status !== 'all') where.push('b.status = @status')
    if (f.from !== undefined) where.push('b.created_at >= @from')
    if (f.to !== undefined) where.push('b.created_at < @to')
    const params = {
      branchId: f.branchId,
      q: f.search ? `%${f.search.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null,
      status: f.status,
      from: f.from ?? null,
      to: f.to ?? null,
      limit: f.limit,
      offset: f.offset,
    }
    const w = where.join(' AND ')
    const rows = this.db
      .prepare(
        `SELECT b.*, u.display_name AS created_by_name,
           (SELECT sum(qty) FROM bill_items i WHERE i.bill_id = b.id) AS item_count,
           (SELECT method FROM payments p WHERE p.bill_id = b.id ORDER BY created_at LIMIT 1) AS payment_method
         FROM bills b JOIN users u ON u.id = b.created_by WHERE ${w}
         ORDER BY b.created_at DESC, b.bill_no DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params) as (BillRow & { created_by_name: string; item_count: number; payment_method: string | null })[]
    const total = this.db.prepare(`SELECT count(*) FROM bills b WHERE ${w}`).pluck().get(params) as number
    return { rows, total }
  }

  billWithMeta(id: string) {
    return this.db
      .prepare(
        `SELECT b.*, u.display_name AS created_by_name,
           (SELECT sum(qty) FROM bill_items i WHERE i.bill_id = b.id) AS item_count,
           (SELECT method FROM payments p WHERE p.bill_id = b.id ORDER BY created_at LIMIT 1) AS payment_method,
           (SELECT status FROM shifts s WHERE s.id = b.shift_id) AS shift_status
         FROM bills b JOIN users u ON u.id = b.created_by WHERE b.id = ?`,
      )
      .get(id) as (BillRow & { created_by_name: string; item_count: number; payment_method: string | null; shift_status: string }) | undefined
  }

  // ---- shifts -------------------------------------------------------------
  shift(id: string): ShiftRow | undefined {
    return this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as ShiftRow | undefined
  }
  openShiftForDevice(deviceId: string): ShiftRow | undefined {
    return this.db.prepare(`SELECT * FROM shifts WHERE device_id = ? AND status = 'open'`).get(deviceId) as ShiftRow | undefined
  }
  insertShift(row: Pick<ShiftRow, 'id' | 'branch_id' | 'device_id' | 'shift_no' | 'opened_by' | 'opened_at' | 'opening_float_satang'>) {
    ins(this.db, 'shifts', row)
  }
  closeShift(id: string, p: { closed_by: string; closed_at: number; expected: number; counted: number; note: string | null }) {
    this.db
      .prepare(
        `UPDATE shifts SET status = 'closed', closed_by = ?, closed_at = ?, expected_cash_satang = ?, counted_cash_satang = ?,
           over_short_satang = ?, note = ? WHERE id = ? AND status = 'open'`,
      )
      .run(p.closed_by, p.closed_at, p.expected, p.counted, p.counted - p.expected, p.note, id)
  }
  insertCashCount(shiftId: string, denomination: number, count: number) {
    this.db.prepare('INSERT INTO shift_cash_counts (shift_id, denomination_satang, count) VALUES (?, ?, ?)').run(shiftId, denomination, count)
  }
  insertCash(row: { id: string; branch_id: string; shift_id: string; kind: string; amount_satang: number; ref_type: string | null; ref_id: string | null; reverses_id: string | null; note: string | null; user_id: string; device_id: string | null; created_at: number }) {
    ins(this.db, 'cash_ledger', row)
  }
  cashFor(refType: string, refId: string) {
    return this.db
      .prepare(`SELECT * FROM cash_ledger l WHERE ref_type = ? AND ref_id = ? AND NOT EXISTS (SELECT 1 FROM cash_ledger r WHERE r.reverses_id = l.id) AND l.reverses_id IS NULL`)
      .all(refType, refId) as { id: string; shift_id: string; kind: string; amount_satang: number }[]
  }
  cashByKind(shiftId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT kind, sum(amount_satang) AS total FROM cash_ledger WHERE shift_id = ? GROUP BY kind')
      .all(shiftId) as { kind: string; total: number }[]
    return Object.fromEntries(rows.map((r) => [r.kind, r.total]))
  }
  salesByMethod(shiftId: string): { method: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT p.method, sum(p.amount_satang) AS total FROM payments p JOIN bills b ON b.id = p.bill_id
         WHERE b.shift_id = ? AND b.status = 'paid' AND p.status = 'confirmed' GROUP BY p.method`,
      )
      .all(shiftId) as { method: string; total: number }[]
  }
  billCounts(shiftId: string): { paid: number; void: number; refunded: number } {
    const r = this.db
      .prepare(
        `SELECT sum(status = 'paid') AS paid, sum(status = 'void') AS void, sum(status = 'refunded') AS refunded
         FROM bills WHERE shift_id = ?`,
      )
      .get(shiftId) as { paid: number | null; void: number | null; refunded: number | null }
    return { paid: r.paid ?? 0, void: r.void ?? 0, refunded: r.refunded ?? 0 }
  }
  userName(id: string | null): string | null {
    if (!id) return null
    return (this.db.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(id) as string | undefined) ?? null
  }
}
