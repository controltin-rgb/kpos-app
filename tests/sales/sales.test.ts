import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'
import { assertLedgerMatchesLots, onHand, remaining, requestId, seedShop } from '../helpers/shop'

async function ready() {
  const t = createTestApp()
  await t.setup()
  const shop = await seedShop(t)
  await t.call(1, 'shift.open', { openingFloatSatang: 150_000 })
  const sell = (items: { sizeId?: string; qty?: number; optionIds?: string[] }[], payment: unknown = { method: 'cash', tenderedSatang: 100_000 }, extra: object = {}) =>
    t.call(1, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'takeaway',
      items: items.map((i) => ({ productId: shop.tea.id, sizeId: i.sizeId ?? null, qty: i.qty ?? 1, optionIds: i.optionIds ?? [shop.normalSweet] })),
      payment: payment as never,
      ...extra,
    })
  return { t, shop, sell }
}

describe('checkout → BOM stock deduction (§6.1, phase 2 criteria)', () => {
  it('deducts per size and multiplier mode, FEFO on the lot that expires first', async () => {
    const { t, shop, sell } = await ready()
    const before = { cup16: onHand(t, shop.ing.cup16), cup22: onHand(t, shop.ing.cup22), lid: onHand(t, shop.ing.lid), pearl: onHand(t, shop.ing.pearl) }

    const { bill, shortages } = await sell([{ sizeId: shop.sizes.s22, qty: 2, optionIds: [shop.normalSweet, shop.extraPearl] }])
    expect(shortages).toEqual([])
    expect(bill.billNo).toBe('A-000001')
    // 2 × (55 + 10 topping) = 130.00 baht, VAT inclusive 7% → 850.47 → 8.50
    expect(bill).toMatchObject({ status: 'paid', subtotalSatang: 13_000, totalSatang: 13_000, vatSatang: 850, vatMode: 'inclusive' })

    // milk: 120 ml × 1.375 × 2 = 330 ml, all from the lot expiring first (received later)
    expect(remaining(t, shop.lots.milkSoon)).toBe(1_000_000 - 330_000)
    expect(remaining(t, shop.lots.milkLate)).toBe(2_000_000)
    // pearls: (50 g × 1.375 + 30 g topping fixed) × 2 = 197.5 g
    expect(before.pearl - onHand(t, shop.ing.pearl)).toBe(197_500)
    // custom: only 22oz cups; fixed: one lid per cup
    expect(before.cup22 - onHand(t, shop.ing.cup22)).toBe(2_000)
    expect(before.cup16 - onHand(t, shop.ing.cup16)).toBe(0)
    expect(before.lid - onHand(t, shop.ing.lid)).toBe(2_000)
    assertLedgerMatchesLots(t)

    // snapshot of the per-unit BOM is stored on the line
    const snap = JSON.parse(t.db.prepare('SELECT bom_snapshot_json FROM bill_items WHERE bill_id = ?').pluck().get(bill.id) as string)
    expect(snap).toContainEqual({ ingredientId: shop.ing.milk, qtyMilli: 165_000 })
  })

  it('spills to the next lot when the first runs out', async () => {
    const { t, shop, sell } = await ready()
    // 7 × 22oz = 7 × 165 ml = 1155 ml: 1000 from milkSoon, 155 from milkLate
    await sell([{ sizeId: shop.sizes.s22, qty: 7 }], { method: 'cash', tenderedSatang: 1_000_000 })
    expect(remaining(t, shop.lots.milkSoon)).toBe(0)
    expect(remaining(t, shop.lots.milkLate)).toBe(2_000_000 - 155_000)
    assertLedgerMatchesLots(t)
  })

  it('takes prices from the database, never from the client', async () => {
    const { shop, sell } = await ready()
    const { bill } = await sell([{ sizeId: shop.sizes.s16 }])
    expect(bill.totalSatang).toBe(4_500)
  })

  it('numbers bills sequentially and supports the daily reset (D14)', async () => {
    const { t, shop, sell } = await ready()
    expect((await sell([{}])).bill.billNo).toBe('A-000001')
    expect((await sell([{}])).bill.billNo).toBe('A-000002')
    await t.call(1, 'settings.update', { 'bill.reset_policy': 'daily' })
    expect((await sell([{}])).bill.billNo).toBe('A-691105-0001')
    t.advance(86_400_000)
    expect((await sell([{}])).bill.billNo).toBe('A-691106-0001')
    void shop
  })

  it('is idempotent on requestId (a retried checkout never sells twice)', async () => {
    const { t, shop } = await ready()
    const input = { requestId: requestId(), orderType: 'takeaway' as const, items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash' as const, tenderedSatang: 4_500 } }
    const a = await t.call(1, 'pos.checkout', input)
    const b = await t.call(1, 'pos.checkout', input)
    expect(b.bill.id).toBe(a.bill.id)
    expect(t.db.prepare('SELECT count(*) FROM bills').pluck().get()).toBe(1)
  })

  it('validates modifiers, payments and shift', async () => {
    const { t, shop, sell } = await ready()
    await t.fails('INVALID_MODIFIERS', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 1, optionIds: [] }], payment: { method: 'cash', tenderedSatang: 10_000 } })
    await t.fails('PAYMENT_INSUFFICIENT', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 4_499 } })
    await t.fails('PROMPTPAY_NOT_CONFIGURED', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'promptpay', confirmed: true } })
    // a failed checkout leaves no trace (single transaction)
    expect(t.db.prepare('SELECT count(*) FROM bills').pluck().get()).toBe(0)
    expect(t.db.prepare(`SELECT count(*) FROM stock_ledger WHERE reason = 'sale'`).pluck().get()).toBe(0)
    void sell
  })

  it('refuses to sell without an open shift', async () => {
    const t = createTestApp()
    await t.setup()
    const shop = await seedShop(t)
    await t.fails('SHIFT_NOT_OPEN', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 4_500 } })
    expect(t.db.prepare('SELECT count(*) FROM doc_sequences').pluck().get()).toBe(0) // no bill number consumed
  })

  it('records delivery orders with channel, order id and commission', async () => {
    const { shop, sell } = await ready()
    const { bill } = await sell([{ sizeId: shop.sizes.s16 }], { method: 'delivery' }, { orderType: 'delivery', channel: 'grab', extOrderId: 'GF-123', commissionBp: 3_000 })
    expect(bill).toMatchObject({ orderType: 'delivery', channel: 'grab', extOrderId: 'GF-123', commissionBp: 3_000, commissionSatang: 1_350 })
  })

  it('by default a paid bill is done at once: nothing waits on the bar screen (D40)', async () => {
    const { t, shop, sell } = await ready()
    const { bill } = await sell([{ sizeId: shop.sizes.s22 }])
    expect(await t.call(1, 'kds.tickets', { station: 'bar' })).toEqual([])
    // still recorded, completed at payment time
    const row = t.db.prepare('SELECT status, started_at, ready_at, completed_at, created_at FROM kds_tickets WHERE bill_id = ?').get(bill.id) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'completed', completed_at: row['created_at'], ready_at: row['created_at'], started_at: row['created_at'] })
  })

  it('creates KDS tickets and advances them (bar workflow switched on)', async () => {
    const { t, shop, sell } = await ready()
    await t.call(1, 'settings.update', { 'kds.complete_on_pay': false })
    const { bill } = await sell([{ sizeId: shop.sizes.s22, optionIds: [shop.normalSweet, shop.extraPearl] }])
    const [ticket] = await t.call(1, 'kds.tickets', { station: 'bar' })
    expect(ticket).toMatchObject({ billNo: bill.billNo, status: 'new' })
    expect(ticket!.items[0]!.mods).toContainEqual({ text: 'ไข่มุกเพิ่ม', highlight: true })
    await t.call(1, 'kds.advance', { billId: bill.id, station: 'bar' })
    await t.call(1, 'kds.advance', { billId: bill.id, station: 'bar' })
    expect((await t.call(1, 'kds.tickets', { station: 'bar' }))[0]!.status).toBe('ready')
    await t.call(1, 'kds.advance', { billId: bill.id, station: 'bar' })
    expect(await t.call(1, 'kds.tickets', { station: 'bar' })).toEqual([])
  })
})

describe('stock shortage (D16)', () => {
  it('sells anyway, records the shortage and settles it from the next lot', async () => {
    const { t, shop, sell } = await ready()
    // pearls on hand: 1000 g. 15 × 22oz with extra pearl = 15 × 98.75 g = 1481.25 g → short 481.25 g
    const { shortages } = await sell([{ sizeId: shop.sizes.s22, qty: 15, optionIds: [shop.normalSweet, shop.extraPearl] }], { method: 'cash', tenderedSatang: 1_000_000 })
    expect(shortages).toEqual([{ ingredientName: 'ไข่มุก', baseUnit: 'g', qtyMilli: 481_250 }])
    expect(onHand(t, shop.ing.pearl)).toBe(0)
    const ing = (await t.call(1, 'inventory.ingredients')).find((i) => i.id === shop.ing.pearl)!
    expect(ing).toMatchObject({ onHandMilli: 0, shortageMilli: 481_250, status: 'out' })

    const r = await t.call(1, 'inventory.addLot', { ingredientId: shop.ing.pearl, qtyMilli: 1_000_000, totalCostSatang: 8_000, expiresAt: T0 + 9 * 86_400_000 })
    expect(r.settledMilli).toBe(481_250)
    expect(onHand(t, shop.ing.pearl)).toBe(518_750)
    expect(t.db.prepare(`SELECT status FROM stock_shortages`).pluck().get()).toBe('settled')
    assertLedgerMatchesLots(t)
  })

  it('void returns settled shortage stock to the lot that settled it', async () => {
    const { t, shop, sell } = await ready()
    const { bill } = await sell([{ sizeId: shop.sizes.s22, qty: 15, optionIds: [shop.normalSweet, shop.extraPearl] }], { method: 'cash', tenderedSatang: 1_000_000 })
    const r = await t.call(1, 'inventory.addLot', { ingredientId: shop.ing.pearl, qtyMilli: 1_000_000, totalCostSatang: 8_000, expiresAt: T0 + 9 * 86_400_000 })
    await t.call(1, 'orders.void', { id: bill.id, reason: 'ลูกค้ายกเลิก' })
    expect(onHand(t, shop.ing.pearl)).toBe(2_000_000) // both lots full again
    expect(remaining(t, r.lotId)).toBe(1_000_000)
    expect(t.db.prepare(`SELECT status FROM stock_shortages`).pluck().get()).toBe('cancelled')
    assertLedgerMatchesLots(t)
  })
})

describe('void / refund (phase 2 criteria: void returns stock completely)', () => {
  it('void puts every gram back into the same lots, reverses cash and is audited', async () => {
    const { t, shop, sell } = await ready()
    const snapshot = () => t.db.prepare('SELECT id, qty_remaining_milli FROM stock_lots ORDER BY id').all()
    const before = snapshot()
    const { bill } = await sell([{ sizeId: shop.sizes.s22, qty: 7, optionIds: [shop.normalSweet, shop.extraPearl] }], { method: 'cash', tenderedSatang: 1_000_000 })
    expect(snapshot()).not.toEqual(before)

    // recipe changes after the sale must not affect what is returned
    await t.call(1, 'catalog.saveProduct', { ...shop.tea, sku: null, barcode: null, recipe: [{ ingredientId: shop.ing.milk, qtyMilli: 999_000, sizeMode: 'fixed', perSize: {} }] })

    const voided = await t.call(1, 'orders.void', { id: bill.id, reason: 'ทำผิดเมนู' })
    expect(voided.status).toBe('void')
    expect(snapshot()).toEqual(before)
    assertLedgerMatchesLots(t)

    const shift = (await t.call(1, 'shift.current'))!
    expect(shift.cashSalesSatang).toBe(0)
    expect(shift.expectedCashSatang).toBe(150_000)
    expect(shift.voidCount).toBe(1)
    expect(await t.call(1, 'kds.tickets', { station: 'bar' })).toEqual([])

    const audit = t.db.prepare(`SELECT risk, reason FROM audit_log WHERE action = 'bill.void'`).get()
    expect(audit).toEqual({ risk: 'high', reason: 'ทำผิดเมนู' })
    await t.fails('BILL_NOT_VOIDABLE', 1, 'orders.void', { id: bill.id, reason: 'ซ้ำ' })
  })

  it('cashier needs a manager PIN to void (Design-Spec §2)', async () => {
    const { t, shop } = await ready()
    const cashier = await t.userOn(2, 'cashier1', 'cashier')
    const manager = await t.userOn(3, 'manager1', 'branch_manager')
    await t.call(1, 'users.setPin', { id: manager.id, pin: '9876' })
    await t.call(1, 'users.setPin', { id: cashier.id, pin: '1111' })
    const { bill } = await t.call(2, 'pos.checkout', { requestId: requestId(), orderType: 'dine_in', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 5_000 } })

    await t.fails('APPROVAL_REQUIRED', 2, 'orders.void', { id: bill.id, reason: 'ลูกค้าเปลี่ยนใจ' })
    await t.fails('INVALID_CREDENTIALS', 2, 'orders.void', { id: bill.id, reason: 'ลูกค้าเปลี่ยนใจ', approver: { username: 'manager1', pin: '0000' } })
    await t.fails('FORBIDDEN', 2, 'orders.void', { id: bill.id, reason: 'ลูกค้าเปลี่ยนใจ', approver: { username: 'cashier1', pin: '1111' } })
    const v = await t.call(2, 'orders.void', { id: bill.id, reason: 'ลูกค้าเปลี่ยนใจ', approver: { username: 'manager1', pin: '9876' } })
    expect(v.events.find((e) => e.event === 'void')).toMatchObject({ userName: 'cashier1', approverName: 'manager1' })
  })

  it('refund after the shift closed takes cash from the current shift and returns stock', async () => {
    const { t, shop, sell } = await ready()
    const pearlBefore = onHand(t, shop.ing.pearl)
    const { bill } = await sell([{ sizeId: shop.sizes.s16 }], { method: 'cash', tenderedSatang: 4_500 })
    const s1 = (await t.call(1, 'shift.current'))!
    await t.call(1, 'shift.close', { shiftId: s1.id, counts: [{ denominationSatang: 100_000, count: 1 }, { denominationSatang: 50_000, count: 1 }, { denominationSatang: 2_000, count: 2 }, { denominationSatang: 500, count: 1 }] })
    await t.fails('BILL_NOT_VOIDABLE', 1, 'orders.void', { id: bill.id, reason: 'shift closed' })

    await t.call(1, 'shift.open', { openingFloatSatang: 100_000 })
    const refunded = await t.call(1, 'orders.refund', { id: bill.id, reason: 'สินค้ามีปัญหา' })
    expect(refunded.status).toBe('refunded')
    expect(onHand(t, shop.ing.pearl)).toBe(pearlBefore)
    const s2 = (await t.call(1, 'shift.current'))!
    expect(s2).toMatchObject({ cashRefundsSatang: 4_500, expectedCashSatang: 95_500 })
    await t.fails('BILL_NOT_REFUNDABLE', 1, 'orders.refund', { id: bill.id, reason: 'ซ้ำ' })
    assertLedgerMatchesLots(t)
  })
})

describe('shift close (phase 2 criteria: Over/Short)', () => {
  it('computes expected cash from float, cash sales, voids, cash in/out; Over/Short = counted − expected', async () => {
    const { t, shop, sell } = await ready() // float 1,500.00
    await sell([{ sizeId: shop.sizes.s22 }], { method: 'cash', tenderedSatang: 10_000 }) // +55.00 (change 45.00)
    await sell([{ sizeId: shop.sizes.s16 }], { method: 'cash', tenderedSatang: 4_500 }) // +45.00
    const { bill } = await sell([{ sizeId: shop.sizes.s16 }], { method: 'cash', tenderedSatang: 5_000 }) // +45.00 then void
    await t.call(1, 'settings.update', { 'promptpay.id': '0812345678' })
    await sell([{ sizeId: shop.sizes.s22 }], { method: 'promptpay', confirmed: true }) // not cash
    await t.call(1, 'orders.void', { id: bill.id, reason: 'ทดสอบ void' })
    await t.call(1, 'shift.cashMove', { kind: 'cash_out', amountSatang: 18_000, reason: 'ซื้อน้ำแข็ง' })
    await t.call(1, 'shift.cashMove', { kind: 'cash_in', amountSatang: 2_000, reason: 'แลกเหรียญ' })

    const s = (await t.call(1, 'shift.current'))!
    // 150000 + 5500 + 4500 − 18000 + 2000 = 144000
    expect(s).toMatchObject({ openingFloatSatang: 150_000, cashSalesSatang: 10_000, cashOutSatang: 18_000, cashInSatang: 2_000, expectedCashSatang: 144_000, billCount: 3, voidCount: 1 })
    expect(s.byMethod).toMatchObject({ cash: 10_000, promptpay: 5_500 })

    // counted 1,439.75 → short 0.25
    const closed = await t.call(1, 'shift.close', {
      shiftId: s.id,
      counts: [
        { denominationSatang: 100_000, count: 1 },
        { denominationSatang: 10_000, count: 4 },
        { denominationSatang: 1_000, count: 2 },
        { denominationSatang: 500, count: 1 },
        { denominationSatang: 200, count: 4 },
        { denominationSatang: 100, count: 6 },
        { denominationSatang: 25, count: 3 },
      ],
      note: 'เหรียญหาย',
    })
    expect(closed).toMatchObject({ status: 'closed', expectedCashSatang: 144_000, countedCashSatang: 143_975, overShortSatang: -25 })
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'shift.close'`).pluck().get()).toBe('high')
    expect(await t.call(1, 'shift.current')).toBeNull()
    await t.fails('SHIFT_NOT_OPEN', 1, 'shift.close', { shiftId: s.id, counts: [] })
  })

  it('one open shift per device; closing another user\'s shift needs shift:view_all', async () => {
    const { t } = await ready()
    await t.fails('SHIFT_ALREADY_OPEN', 1, 'shift.open', { openingFloatSatang: 0 })
    await t.userOn(2, 'cashier1', 'cashier')
    const s = (await t.call(2, 'shift.current'))!
    await t.fails('NOT_SHIFT_OWNER', 2, 'shift.close', { shiftId: s.id, counts: [] })
  })

  it('cannot take more cash out than the drawer holds', async () => {
    const { t } = await ready()
    await t.fails('PAYMENT_INVALID', 1, 'shift.cashMove', { kind: 'cash_out', amountSatang: 150_001, reason: 'มากเกินไป' })
  })
})

describe('receipt and settings', () => {
  it('prints a receipt; the second print is marked as a copy', async () => {
    const t = createTestApp()
    await t.setup()
    const shop = await seedShop(t)
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    const { bill } = await t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'dine_in', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet, shop.extraPearl] }], payment: { method: 'cash', tenderedSatang: 10_000 } })
    await t.call(1, 'orders.print', { id: bill.id })
    await t.call(1, 'orders.print', { id: bill.id })
    const detail = await t.call(1, 'orders.get', { id: bill.id })
    expect(detail.events.filter((e) => e.event === 'reprint')).toHaveLength(2)
  })

  it('validates and audits settings changes', async () => {
    const t = createTestApp()
    await t.setup()
    const s = await t.call(1, 'settings.get')
    expect(s).toMatchObject({ 'vat.rate_bp': 700, 'bill.reset_policy': 'none', branchCode: 'A', billNoExample: 'A-000001' })
    await t.fails('INVALID_INPUT', 1, 'settings.update', { 'promptpay.id': '12345' })
    const u = await t.call(1, 'settings.update', { 'vat.rate_bp': 0, 'bill.reset_policy': 'monthly' })
    expect(u.billNoExample).toBe('A-6911-0001')
    const rows = t.db.prepare(`SELECT entity_id, risk FROM audit_log WHERE action = 'settings.update' ORDER BY seq`).all()
    expect(rows).toEqual([
      { entity_id: 'vat.rate_bp', risk: 'high' },
      { entity_id: 'bill.reset_policy', risk: 'medium' },
    ])
  })

  it('applies VAT rate 0 as "no VAT" (D15)', async () => {
    const { t, shop, sell } = await ready()
    await t.call(1, 'settings.update', { 'vat.rate_bp': 0 })
    const { bill } = await sell([{ sizeId: shop.sizes.s16 }])
    expect(bill).toMatchObject({ vatMode: 'none', vatSatang: 0, totalSatang: 4_500 })
  })

  it('builds a PromptPay payload for the configured id', async () => {
    const t = createTestApp()
    await t.setup()
    await t.fails('PROMPTPAY_NOT_CONFIGURED', 1, 'pos.promptPayPayload', { amountSatang: 4_500 })
    await t.call(1, 'settings.update', { 'promptpay.id': '081-234-5678' })
    expect(await t.call(1, 'pos.promptPayPayload', { amountSatang: 4_500 })).toContain('0066812345678')
  })
})

describe('RBAC on phase 2 endpoints', () => {
  it('cashier sells but cannot edit products, prices or settings', async () => {
    const { t, shop } = await ready()
    await t.userOn(2, 'cashier1', 'cashier')
    await t.call(2, 'pos.catalog')
    await t.fails('FORBIDDEN', 2, 'catalog.saveProduct', { ...shop.tea, sku: null, barcode: null })
    await t.fails('FORBIDDEN', 2, 'settings.update', { 'vat.rate_bp': 0 })
    await t.fails('FORBIDDEN', 2, 'inventory.addLot', { ingredientId: shop.ing.milk, qtyMilli: 1, totalCostSatang: 0, expiresAt: null })
  })
})
