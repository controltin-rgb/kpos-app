import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'
import { assertLedgerMatchesLots, onHand, remaining, requestId, seedShop } from '../helpers/shop'

const DAY = 86_400_000

async function ready() {
  const t = createTestApp()
  await t.setup()
  const shop = await seedShop(t)
  return { t, shop }
}

describe('purchase orders and receiving (§6.7)', () => {
  it('creates a PO, receives it in two deliveries with expiry per line, and closes it', async () => {
    const { t, shop } = await ready()
    const sup = await t.call(1, 'purchasing.saveSupplier', { name: 'ฟาร์มนม' })
    const po = await t.call(1, 'purchasing.saveOrder', {
      supplierId: sup.id,
      lines: [
        { ingredientId: shop.ing.milk, qtyOrderedMilli: 4_000_000, lineTotalSatang: 18_000 },
        { ingredientId: shop.ing.lid, qtyOrderedMilli: 100_000, lineTotalSatang: 5_000 },
      ],
    })
    expect(po).toMatchObject({ status: 'draft', poNo: 'A-PO000001', totalSatang: 23_000 })
    await t.call(1, 'purchasing.setStatus', { id: po.id, status: 'ordered' })

    const milkBefore = onHand(t, shop.ing.milk)
    const r1 = await t.call(1, 'purchasing.receive', {
      poId: po.id,
      lines: [{ poLineId: po.lines[0]!.id, ingredientId: shop.ing.milk, qtyMilli: 2_000_000, totalCostSatang: 9_000, expiresAt: T0 + 7 * DAY }],
    })
    expect(r1.lotIds).toHaveLength(1)
    let orders = await t.call(1, 'purchasing.orders', { status: 'all' })
    expect(orders.find((o) => o.id === po.id)).toMatchObject({ status: 'partial' })

    await t.call(1, 'purchasing.receive', {
      poId: po.id,
      lines: [
        { poLineId: po.lines[0]!.id, ingredientId: shop.ing.milk, qtyMilli: 2_000_000, totalCostSatang: 9_000, expiresAt: T0 + 8 * DAY },
        { poLineId: po.lines[1]!.id, ingredientId: shop.ing.lid, qtyMilli: 100_000, totalCostSatang: 5_000, expiresAt: null },
      ],
    })
    orders = await t.call(1, 'purchasing.orders', { status: 'all' })
    const done = orders.find((o) => o.id === po.id)!
    expect(done.status).toBe('received')
    expect(done.lines.map((l) => l.qtyReceivedMilli)).toEqual([4_000_000, 100_000])
    expect(onHand(t, shop.ing.milk) - milkBefore).toBe(4_000_000)
    // receive lots are linked to the receipt and PO line
    const lot = t.db.prepare('SELECT receipt_id, po_line_id FROM stock_lots WHERE id = ?').get(r1.lotIds[0]) as Record<string, string>
    expect(lot).toEqual({ receipt_id: r1.receiptId, po_line_id: po.lines[0]!.id })
    assertLedgerMatchesLots(t)
    expect(await t.call(1, 'purchasing.orders', { status: 'open' })).toEqual([])
  })

  it('requires an expiry date for ingredients that have one, in one transaction', async () => {
    const { t, shop } = await ready()
    const before = onHand(t, shop.ing.lid)
    await t.fails('INVALID_INPUT', 1, 'purchasing.receive', {
      lines: [
        { ingredientId: shop.ing.lid, qtyMilli: 1_000, totalCostSatang: 100, expiresAt: null },
        { ingredientId: shop.ing.milk, qtyMilli: 1_000, totalCostSatang: 100, expiresAt: null },
      ],
    })
    expect(onHand(t, shop.ing.lid)).toBe(before) // first line rolled back too
  })

  it('cannot receive against a cancelled PO or edit a PO after ordering', async () => {
    const { t, shop } = await ready()
    const po = await t.call(1, 'purchasing.saveOrder', { lines: [{ ingredientId: shop.ing.lid, qtyOrderedMilli: 1_000, lineTotalSatang: 100 }] })
    await t.call(1, 'purchasing.setStatus', { id: po.id, status: 'ordered' })
    await t.fails('NOT_EDITABLE', 1, 'purchasing.saveOrder', { id: po.id, lines: [{ ingredientId: shop.ing.lid, qtyOrderedMilli: 2_000, lineTotalSatang: 100 }] })
    await t.call(1, 'purchasing.setStatus', { id: po.id, status: 'cancelled' })
    await t.fails('NOT_EDITABLE', 1, 'purchasing.receive', { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, ingredientId: shop.ing.lid, qtyMilli: 1_000, totalCostSatang: 100, expiresAt: null }] })
  })
})

describe('stock counts with approval (§6.7, D22)', () => {
  async function countWith(t: Awaited<ReturnType<typeof ready>>['t'], lines: { ingredientId: string; countedQtyMilli: number; reason?: string }[]) {
    const c = await t.call(1, 'counts.create', { kind: 'daily', ingredientIds: lines.map((l) => l.ingredientId) })
    return t.call(1, 'counts.saveLines', { id: c.id, lines: lines.map((l) => ({ ingredientId: l.ingredientId, countedQtyMilli: l.countedQtyMilli, reason: l.reason ?? null })) })
  }

  it('snapshots system quantities, requires reasons for differences, and needs a different approver', async () => {
    const { t, shop } = await ready()
    const milk = onHand(t, shop.ing.milk) // 3,000,000
    const c = await countWith(t, [
      { ingredientId: shop.ing.milk, countedQtyMilli: milk - 200_000 },
      { ingredientId: shop.ing.lid, countedQtyMilli: onHand(t, shop.ing.lid) },
    ])
    expect(c.status).toBe('draft')
    expect(c.lines.find((l) => l.ingredientId === shop.ing.milk)).toMatchObject({ systemQtyMilli: milk, diffMilli: -200_000 })
    await t.fails('REASON_REQUIRED', 1, 'counts.submit', { id: c.id })
    await t.call(1, 'counts.saveLines', { id: c.id, lines: [{ ingredientId: shop.ing.milk, countedQtyMilli: milk - 200_000, reason: 'หกระหว่างชง' }] })
    expect((await t.call(1, 'counts.submit', { id: c.id })).status).toBe('pending')
    await t.fails('NOT_EDITABLE', 1, 'counts.saveLines', { id: c.id, lines: [] })

    // D22: the counter cannot approve their own count
    await t.fails('SAME_APPROVER', 1, 'counts.approve', { id: c.id })
    await t.userOn(2, 'manager1', 'branch_manager')
    const lotSoon = remaining(t, shop.lots.milkSoon)
    const approved = await t.call(2, 'counts.approve', { id: c.id })
    expect(approved.status).toBe('approved')
    // the negative difference is taken FEFO (soonest expiry first)
    expect(remaining(t, shop.lots.milkSoon)).toBe(lotSoon - 200_000)
    expect(onHand(t, shop.ing.milk)).toBe(milk - 200_000)
    expect(t.db.prepare(`SELECT count(*) FROM stock_ledger WHERE reason = 'count_adjust'`).pluck().get()).toBe(1)
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'stock.count_approve'`).pluck().get()).toBe('high')
    assertLedgerMatchesLots(t)
  })

  it('adds a count_adjust lot for surplus and allows self-approval when the setting is off', async () => {
    const { t, shop } = await ready()
    await t.call(1, 'settings.update', { 'stock.count_separate_approver': false })
    const lid = onHand(t, shop.ing.lid)
    const c = await countWith(t, [{ ingredientId: shop.ing.lid, countedQtyMilli: lid + 5_000, reason: 'รับเข้าไม่ครบรอบก่อน' }])
    await t.call(1, 'counts.submit', { id: c.id })
    await t.call(1, 'counts.approve', { id: c.id })
    expect(onHand(t, shop.ing.lid)).toBe(lid + 5_000)
    const lot = t.db.prepare(`SELECT source, total_cost_satang FROM stock_lots WHERE source = 'count_adjust'`).get() as Record<string, unknown>
    expect(lot.source).toBe('count_adjust')
    expect(lot.total_cost_satang).toBe(250) // 5 lids at the latest lot cost (100.00 / 200)
    assertLedgerMatchesLots(t)
  })

  it('writes off shortages that the count accounts for', async () => {
    const { t, shop } = await ready()
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    // oversell pearls → shortage of 481.25 g
    await t.call(1, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'takeaway',
      items: [{ productId: shop.tea.id, sizeId: shop.sizes.s22, qty: 15, optionIds: [shop.normalSweet, shop.extraPearl] }],
      payment: { method: 'cash', tenderedSatang: 1_000_000 },
    })
    await t.call(1, 'settings.update', { 'stock.count_separate_approver': false })
    const c = await countWith(t, [{ ingredientId: shop.ing.pearl, countedQtyMilli: 0 }])
    expect(c.lines[0]).toMatchObject({ systemQtyMilli: -481_250, diffMilli: 481_250 })
    await t.call(1, 'counts.saveLines', { id: c.id, lines: [{ ingredientId: shop.ing.pearl, countedQtyMilli: 0, reason: 'นับจริงหมดแล้ว' }] })
    await t.call(1, 'counts.submit', { id: c.id })
    await t.call(1, 'counts.approve', { id: c.id })
    expect(t.db.prepare('SELECT status FROM stock_shortages').pluck().get()).toBe('written_off')
    expect(onHand(t, shop.ing.pearl)).toBe(0)
    // a later delivery is NOT eaten by the written-off shortage
    await t.call(1, 'inventory.addLot', { ingredientId: shop.ing.pearl, qtyMilli: 500_000, totalCostSatang: 4_000, expiresAt: T0 + 9 * DAY })
    expect(onHand(t, shop.ing.pearl)).toBe(500_000)
    assertLedgerMatchesLots(t)
  })

  it('rejects with a reason and leaves stock untouched; head barista cannot approve', async () => {
    const { t, shop } = await ready()
    const c = await countWith(t, [{ ingredientId: shop.ing.lid, countedQtyMilli: 0, reason: 'ทดสอบ' }])
    await t.call(1, 'counts.submit', { id: c.id })
    await t.userOn(2, 'barista1', 'head_barista')
    await t.fails('FORBIDDEN', 2, 'counts.approve', { id: c.id })
    await t.userOn(3, 'manager1', 'branch_manager')
    const before = onHand(t, shop.ing.lid)
    const r = await t.call(3, 'counts.reject', { id: c.id, reason: 'นับใหม่อีกรอบ' })
    expect(r).toMatchObject({ status: 'rejected', rejectReason: 'นับใหม่อีกรอบ', decidedByName: 'manager1' })
    expect(onHand(t, shop.ing.lid)).toBe(before)
  })
})

describe('waste (§6.8)', () => {
  it('writes off an ingredient from a chosen near-expiry lot, valued at lot cost, audited', async () => {
    const { t, shop } = await ready()
    const exp = await t.call(1, 'waste.expiring', { withinDays: 3 })
    expect(exp.map((e) => e.lotId)).toContain(shop.lots.milkSoon) // expires in 3 days
    expect(exp.map((e) => e.lotId)).not.toContain(shop.lots.milkLate)

    const w = await t.call(1, 'waste.record', { kind: 'ingredient', ingredientId: shop.ing.milk, lotId: shop.lots.milkSoon, qtyMilli: 1_000_000, reason: 'expired' })
    expect(w).toMatchObject({ wasteNo: 'A-W000001', kind: 'ingredient', reason: 'expired', valueSatang: 4_600 })
    expect(remaining(t, shop.lots.milkSoon)).toBe(0)
    expect(remaining(t, shop.lots.milkLate)).toBe(2_000_000)
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'waste.record'`).pluck().get()).toBe('medium')
    await t.fails('STOCK_INSUFFICIENT', 1, 'waste.record', { kind: 'ingredient', ingredientId: shop.ing.milk, lotId: shop.lots.milkSoon, qtyMilli: 1, reason: 'expired' })
    assertLedgerMatchesLots(t)
  })

  it('wastes a made drink by its BOM and can be voided back', async () => {
    const { t, shop } = await ready()
    const snap = () => t.db.prepare('SELECT id, qty_remaining_milli FROM stock_lots ORDER BY id').all()
    const before = snap()
    const w = await t.call(1, 'waste.record', { kind: 'drink', productId: shop.tea.id, sizeId: shop.sizes.s22, qty: 2, optionIds: [shop.normalSweet], reason: 'wrong_made' })
    expect(w.itemName).toBe('ชานมไข่มุก (22oz)')
    expect(onHand(t, shop.ing.cup22)).toBe(100_000 - 2_000)
    expect(w.valueSatang).toBeGreaterThan(0)
    const v = await t.call(1, 'waste.void', { id: w.id, reason: 'บันทึกผิด' })
    expect(v.voided).toBe(true)
    expect(snap()).toEqual(before)
    await t.fails('NOT_EDITABLE', 1, 'waste.void', { id: w.id, reason: 'ซ้ำ' })
    assertLedgerMatchesLots(t)
  })

  it('reports waste vs sales (target ≤ 2%)', async () => {
    const { t, shop } = await ready()
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    await t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 10, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 45_000 } })
    await t.call(1, 'waste.record', { kind: 'ingredient', ingredientId: shop.ing.lid, qtyMilli: 9_000, reason: 'dropped' }) // 9 lids × 0.50 = 4.50
    const s = await t.call(1, 'waste.summary', { from: T0 - DAY, to: T0 + DAY })
    expect(s).toMatchObject({ totalSatang: 450, salesSatang: 45_000, wasteRatioBp: 100 })
    expect(s.byReason.dropped).toBe(450)
  })
})

describe('manual adjustment', () => {
  it('needs inventory:adjust and is audited as high risk', async () => {
    const { t, shop } = await ready()
    await t.userOn(2, 'barista1', 'head_barista')
    await t.fails('FORBIDDEN', 2, 'inventory.adjust', { ingredientId: shop.ing.lid, deltaMilli: -1_000, reason: 'ฝาแตก' })
    const r = await t.call(1, 'inventory.adjust', { ingredientId: shop.ing.lid, deltaMilli: -1_000, reason: 'ฝาแตก' })
    expect(r.onHandMilli).toBe(199_000)
    await t.call(1, 'inventory.adjust', { ingredientId: shop.ing.lid, deltaMilli: 3_000, reason: 'เจอเพิ่ม' })
    expect(onHand(t, shop.ing.lid)).toBe(202_000)
    expect(t.db.prepare(`SELECT count(*) FROM audit_log WHERE action = 'inventory.adjust' AND risk = 'high'`).pluck().get()).toBe(2)
    await t.fails('STOCK_INSUFFICIENT', 1, 'inventory.adjust', { ingredientId: shop.ing.lid, deltaMilli: -999_999_000, reason: 'มากเกิน' })
    assertLedgerMatchesLots(t)
  })
})
