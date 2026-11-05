import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'

async function ready() {
  const t = createTestApp()
  await t.setup()
  const cats = await t.call(1, 'expenses.categories')
  const cat = (name: string) => cats.find((c) => c.name === name)!.id
  return { t, cats, cat }
}

describe('expenses (§6.6) and the cash drawer (§6.5)', () => {
  it('seeds the default categories from the prototype', async () => {
    const { cats } = await ready()
    expect(cats.map((c) => c.name)).toEqual(['วัตถุดิบ', 'ค่าสาธารณูปโภค', 'ค่าเช่า', 'เงินเดือน', 'ซ่อมบำรุง', 'อื่นๆ'])
  })

  it('a drawer expense lowers the expected cash of the open shift; void puts it back', async () => {
    const { t, cat } = await ready()
    await t.fails('SHIFT_NOT_OPEN', 1, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 18_000, source: 'drawer', description: 'น้ำแข็ง' })
    await t.call(1, 'shift.open', { openingFloatSatang: 150_000 })
    const e = await t.call(1, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 18_000, source: 'drawer', description: 'น้ำแข็ง' })
    expect(e).toMatchObject({ expenseNo: 'A-E000001', source: 'drawer', amountSatang: 18_000, voided: false })
    let s = (await t.call(1, 'shift.current'))!
    expect(s).toMatchObject({ expensesSatang: 18_000, expectedCashSatang: 132_000 })

    const v = await t.call(1, 'expenses.void', { id: e.id, reason: 'บันทึกซ้ำ' })
    expect(v).toMatchObject({ voided: true, voidReason: 'บันทึกซ้ำ' })
    s = (await t.call(1, 'shift.current'))!
    expect(s).toMatchObject({ expensesSatang: 0, expectedCashSatang: 150_000 })
    await t.fails('NOT_EDITABLE', 1, 'expenses.void', { id: e.id, reason: 'ซ้ำอีก' })
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'expenses.void'`).pluck().get()).toBe('high')
  })

  it('cannot pay more from the drawer than it holds', async () => {
    const { t, cat } = await ready()
    await t.call(1, 'shift.open', { openingFloatSatang: 10_000 })
    await t.fails('PAYMENT_INVALID', 1, 'expenses.create', { categoryId: cat('อื่นๆ'), amountSatang: 10_001, source: 'drawer', description: 'เกิน' })
  })

  it('petty cash and bank expenses do not touch the drawer', async () => {
    const { t, cat } = await ready()
    await t.call(1, 'shift.open', { openingFloatSatang: 50_000 })
    await t.call(1, 'expenses.create', { categoryId: cat('ค่าเช่า'), amountSatang: 1_500_000, source: 'bank', description: 'ค่าเช่าเดือน พ.ย.' })
    await t.call(1, 'expenses.create', { categoryId: cat('ซ่อมบำรุง'), amountSatang: 30_000, source: 'petty_cash', description: 'ซ่อมก๊อก' })
    expect((await t.call(1, 'shift.current'))!.expectedCashSatang).toBe(50_000)
  })

  it('validates input VAT and summarises by category, source and input VAT', async () => {
    const { t, cat } = await ready()
    await t.fails('INVALID_INPUT', 1, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 1_000, vatSatang: 1_001, source: 'bank', description: 'x' })
    await t.call(1, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 10_700, vatSatang: 700, hasTaxInvoice: true, source: 'bank', description: 'นม' })
    await t.call(1, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 5_000, source: 'petty_cash', description: 'ไข่มุก' })
    await t.call(1, 'expenses.create', { categoryId: cat('ค่าสาธารณูปโภค'), amountSatang: 200_000, source: 'bank', description: 'ค่าไฟ' })
    const s = await t.call(1, 'expenses.summary', { from: T0 - 1, to: T0 + 1 })
    expect(s.totalSatang).toBe(215_700)
    expect(s.inputVatSatang).toBe(700)
    expect(s.bySource).toEqual({ drawer: 0, petty_cash: 5_000, bank: 210_700 })
    expect(s.byCategory[0]).toMatchObject({ name: 'ค่าสาธารณูปโภค', totalSatang: 200_000 })
    const list = await t.call(1, 'expenses.list', { categoryId: cat('วัตถุดิบ') })
    expect(list.total).toBe(2)
  })

  it('cashier records drawer expenses but cannot void them', async () => {
    const { t, cat } = await ready()
    await t.call(1, 'shift.open', { openingFloatSatang: 50_000 })
    await t.userOn(2, 'cashier1', 'cashier')
    const e = await t.call(2, 'expenses.create', { categoryId: cat('วัตถุดิบ'), amountSatang: 2_000, source: 'drawer', description: 'น้ำแข็ง' })
    await t.fails('FORBIDDEN', 2, 'expenses.void', { id: e.id, reason: 'ผิด' })
  })

  it('rejects receipt file names that could escape the receipts folder', async () => {
    const { t, cat } = await ready()
    await t.fails('INVALID_INPUT', 1, 'expenses.create', { categoryId: cat('อื่นๆ'), amountSatang: 100, source: 'bank', description: 'x', receiptFile: '../../secrets/auth.key' })
  })
})
