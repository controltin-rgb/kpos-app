import { describe, expect, it } from 'vitest'
import type { Db } from '@main/db/connection'
import { loadMigrations } from '@main/db/migrate'
import { insert, migratedDb, MIGRATIONS_DIR, seedBasics, seedBill, seedIngredientLot, T0 } from '../helpers/fixtures'

const ZERO_HASH = '0'.repeat(64)
const hash = (c: string) => c.repeat(64)

interface Col {
  name: string
  type: string
}
function userTables(db: Db): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string
    }[]
  ).map((r) => r.name)
}
const columns = (db: Db, t: string) => db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t) as Col[]

/** One valid row per append-only table, built on the shared fixtures. */
function seedAppendOnly(db: Db) {
  const b = seedBasics(db)
  const { ingredientId, lotId } = seedIngredientLot(db, b.branchId)
  const billId = seedBill(db, b)
  const memberId = insert(db, 'members', { branch_id: b.branchId, phone: '0812345678', created_at: T0, updated_at: T0 })
  return {
    stock_ledger: insert(db, 'stock_ledger', {
      branch_id: b.branchId,
      ingredient_id: ingredientId,
      lot_id: lotId,
      delta_qty_milli: 2_000_000,
      cost_satang: 9_000,
      reason: 'receive',
      created_at: T0,
    }),
    cash_ledger: insert(db, 'cash_ledger', {
      branch_id: b.branchId,
      shift_id: b.shiftId,
      kind: 'opening_float',
      amount_satang: 100_000,
      user_id: b.userId,
      created_at: T0,
    }),
    bill_events: insert(db, 'bill_events', { bill_id: billId, event: 'created', user_id: b.userId, created_at: T0 }),
    audit_log: insert(db, 'audit_log', {
      seq: 1,
      action: 'test',
      created_at: T0,
      prev_hash: ZERO_HASH,
      hash: hash('a'),
    }),
    point_ledger: insert(db, 'point_ledger', { member_id: memberId, delta: 10, reason: 'earn', created_at: T0 }),
  }
}

describe('0001_init schema', () => {
  it('migrates cleanly with integrity and foreign keys intact', () => {
    const db = migratedDb()
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('user_version', { simple: true })).toBe(loadMigrations(MIGRATIONS_DIR).length)
  })

  it('creates every table from Implement.md §5.2', () => {
    const t = userTables(migratedDb())
    for (const name of [
      'companies', 'branches', 'devices', 'users', 'roles', 'role_permissions', 'settings', 'licenses',
      'categories', 'products', 'product_sizes', 'modifier_groups', 'modifier_options', 'recipe_items',
      'ingredients', 'stock_lots', 'stock_ledger', 'purchase_orders', 'purchase_order_lines',
      'stock_counts', 'stock_count_lines', 'waste_records',
      'bills', 'bill_items', 'payments', 'bill_events', 'bill_number_blocks', 'tax_invoices',
      'shifts', 'cash_ledger', 'expenses', 'promotions', 'coupons', 'members', 'audit_log', 'backup_runs',
    ]) {
      expect(t, name).toContain(name)
    }
  })

  it('declares every table STRICT', () => {
    const db = migratedDb()
    const rows = db.prepare(`SELECT name, strict FROM pragma_table_list WHERE schema='main' AND type='table'`).all() as {
      name: string
      strict: number
    }[]
    const nonStrict = rows.filter((r) => r.strict !== 1 && !r.name.startsWith('sqlite_')).map((r) => r.name)
    expect(nonStrict).toEqual([])
  })

  it('types money, quantity, time and id columns per conventions', () => {
    const db = migratedDb()
    const bad: string[] = []
    for (const t of userTables(db)) {
      for (const c of columns(db, t)) {
        const isInt = c.type === 'INTEGER'
        if (/_(satang|milli|bp|at)$/.test(c.name) && !isInt) bad.push(`${t}.${c.name} ${c.type}`)
        if ((c.name === 'id' || c.name.endsWith('_id')) && c.type !== 'TEXT') bad.push(`${t}.${c.name} ${c.type}`)
        if (c.type === 'REAL') bad.push(`${t}.${c.name} REAL (forbidden)`)
      }
    }
    expect(bad).toEqual([])
  })

  it('rejects fractional satang (STRICT)', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    expect(() =>
      insert(db, 'shifts', {
        branch_id: b.branchId,
        shift_no: 'S-0002',
        opened_by: b.userId,
        opened_at: T0,
        opening_float_satang: 100.5,
      }),
    ).toThrow(/REAL value in INTEGER column/)
  })

  describe.each(['stock_ledger', 'cash_ledger', 'bill_events', 'audit_log', 'point_ledger'] as const)(
    'append-only %s',
    (table) => {
      it('rejects UPDATE', () => {
        const db = migratedDb()
        const ids = seedAppendOnly(db)
        expect(() => db.prepare(`UPDATE ${table} SET created_at = created_at + 1 WHERE id = ?`).run(ids[table])).toThrow(
          `append-only: ${table}`,
        )
      })
      it('rejects DELETE', () => {
        const db = migratedDb()
        const ids = seedAppendOnly(db)
        expect(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(ids[table])).toThrow(`append-only: ${table}`)
      })
    },
  )

  it('enforces a contiguous audit hash chain', () => {
    const db = migratedDb()
    const row = (seq: number, prev: string, h: string) => ({ seq, action: 'x', created_at: T0, prev_hash: prev, hash: h })
    expect(() => insert(db, 'audit_log', row(1, hash('f'), hash('a')))).toThrow('audit_log chain broken')
    insert(db, 'audit_log', row(1, ZERO_HASH, hash('a')))
    expect(() => insert(db, 'audit_log', row(3, hash('a'), hash('b')))).toThrow('audit_log chain broken')
    expect(() => insert(db, 'audit_log', row(2, hash('c'), hash('b')))).toThrow('audit_log chain broken')
    insert(db, 'audit_log', row(2, hash('a'), hash('b')))
    expect(db.prepare('SELECT count(*) FROM audit_log').pluck().get()).toBe(2)
  })

  it('never lets a lot go negative', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    const { lotId } = seedIngredientLot(db, b.branchId)
    expect(() => db.prepare('UPDATE stock_lots SET qty_remaining_milli = -1 WHERE id = ?').run(lotId)).toThrow(
      /CHECK constraint failed/,
    )
  })

  it('rejects stock ledger rows whose ingredient does not match the lot', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    const { lotId } = seedIngredientLot(db, b.branchId)
    const other = insert(db, 'ingredients', { branch_id: b.branchId, name: 'ไข่มุก', base_unit: 'g', created_at: T0, updated_at: T0 })
    expect(() =>
      insert(db, 'stock_ledger', {
        branch_id: b.branchId,
        ingredient_id: other,
        lot_id: lotId,
        delta_qty_milli: -1000,
        cost_satang: -5,
        reason: 'sale',
        created_at: T0,
      }),
    ).toThrow('does not match lot')
  })

  it('enforces foreign keys', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    expect(() => seedBill(db, { ...b, shiftId: 'missing-shift' })).toThrow(/FOREIGN KEY/)
  })

  it('keeps bill numbers unique per branch only', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    seedBill(db, b, 'A-10001')
    expect(() => seedBill(db, b, 'A-10001')).toThrow(/UNIQUE/)

    const branch2 = insert(db, 'branches', { company_id: b.companyId, code: 'B2', name: 'สาขา 2', created_at: T0, updated_at: T0 })
    const shift2 = insert(db, 'shifts', {
      branch_id: branch2,
      shift_no: 'S-0001',
      opened_by: b.userId,
      opened_at: T0,
      opening_float_satang: 0,
    })
    expect(() => seedBill(db, { ...b, branchId: branch2, shiftId: shift2, deviceId: b.deviceId }, 'A-10001')).not.toThrow()
  })

  it('validates enums and bill state rules', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    const billId = seedBill(db, b)
    expect(() => db.prepare(`UPDATE bills SET status = 'weird' WHERE id = ?`).run(billId)).toThrow(/CHECK/)
    // void needs who/when/why
    expect(() => db.prepare(`UPDATE bills SET status = 'void' WHERE id = ?`).run(billId)).toThrow(/CHECK/)
    // delivery needs a channel
    expect(() => db.prepare(`UPDATE bills SET order_type = 'delivery' WHERE id = ?`).run(billId)).toThrow(/CHECK/)
    db.prepare(`UPDATE bills SET order_type = 'delivery', channel = 'grab', ext_order_id = 'GF-123' WHERE id = ?`).run(billId)
  })

  it('requires closed shifts to have a consistent over/short', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    const close = db.prepare(
      `UPDATE shifts SET status='closed', closed_by=@u, closed_at=@t, expected_cash_satang=@e,
       counted_cash_satang=@c, over_short_satang=@o WHERE id=@id`,
    )
    expect(() => close.run({ u: b.userId, t: T0, e: 150_000, c: 149_500, o: 500, id: b.shiftId })).toThrow(/CHECK/)
    close.run({ u: b.userId, t: T0, e: 150_000, c: 149_500, o: -500, id: b.shiftId })
  })

  it('allows only one open shift per device', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    expect(() =>
      insert(db, 'shifts', {
        branch_id: b.branchId,
        device_id: b.deviceId,
        shift_no: 'S-0002',
        opened_by: b.userId,
        opened_at: T0,
        opening_float_satang: 0,
      }),
    ).toThrow(/UNIQUE/)
  })

  it('requires buyer details on full tax invoices', () => {
    const db = migratedDb()
    const b = seedBasics(db)
    const billId = seedBill(db, b)
    const base = { branch_id: b.branchId, bill_id: billId, issued_by: b.userId, issued_at: T0 }
    expect(() => insert(db, 'tax_invoices', { ...base, type: 'full', invoice_no: 'T-1' })).toThrow(/CHECK/)
    insert(db, 'tax_invoices', { ...base, type: 'abbreviated', invoice_no: 'T-1' })
  })
})
