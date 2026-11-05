import { join } from 'node:path'
import { openDatabase, type Db } from '@main/db/connection'
import { migrate } from '@main/db/migrate'
import { uuidv7 } from '@shared/id'

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations')
export const T0 = Date.UTC(2026, 10, 5, 3, 0, 0) // 2026-11-05 10:00 ICT

/** Fresh in-memory DB with the real migrations applied. */
export function migratedDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db, { dbPath: ':memory:', migrationsDir: MIGRATIONS_DIR, backupDir: '/nonexistent' })
  return db
}

type Row = Record<string, string | number | null>

export function insert(db: Db, table: string, row: Row): string {
  const id = (row.id as string | undefined) ?? uuidv7()
  const full = { id, ...row }
  const cols = Object.keys(full)
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(full)
  return id
}

const master = { created_at: T0, updated_at: T0 }

/** Minimal graph: company → branch → role → user → device → open shift. */
export function seedBasics(db: Db) {
  const companyId = insert(db, 'companies', { name: 'KPOSS Cafe', ...master })
  const branchId = insert(db, 'branches', { company_id: companyId, code: 'HQ', name: 'สาขาหลัก', ...master })
  const roleId = insert(db, 'roles', { key: 'cashier', name: 'Cashier', is_system: 1, ...master })
  const userId = insert(db, 'users', {
    branch_id: branchId,
    role_id: roleId,
    username: 'cashier1',
    display_name: 'แคชเชียร์ 1',
    ...master,
  })
  const deviceId = insert(db, 'devices', {
    branch_id: branchId,
    name: 'POS-1',
    role: 'standalone',
    hardware_id: 'hw-1',
    created_at: T0,
  })
  const shiftId = insert(db, 'shifts', {
    branch_id: branchId,
    device_id: deviceId,
    shift_no: 'S-0001',
    opened_by: userId,
    opened_at: T0,
    opening_float_satang: 100_000,
  })
  return { companyId, branchId, roleId, userId, deviceId, shiftId }
}

export function seedIngredientLot(db: Db, branchId: string) {
  const ingredientId = insert(db, 'ingredients', {
    branch_id: branchId,
    name: 'นมสด',
    base_unit: 'ml',
    has_expiry: 1,
    ...master,
  })
  const lotId = insert(db, 'stock_lots', {
    branch_id: branchId,
    ingredient_id: ingredientId,
    qty_received_milli: 2_000_000,
    qty_remaining_milli: 2_000_000,
    total_cost_satang: 9_000,
    received_at: T0,
    expires_at: T0 + 3 * 86_400_000,
    ...master,
  })
  return { ingredientId, lotId }
}

export function seedBill(db: Db, b: ReturnType<typeof seedBasics>, billNo = 'A-10001') {
  return insert(db, 'bills', {
    branch_id: b.branchId,
    bill_no: billNo,
    device_id: b.deviceId,
    shift_id: b.shiftId,
    order_type: 'takeaway',
    vat_mode: 'inclusive',
    created_by: b.userId,
    created_at: T0,
    updated_at: T0,
  })
}
