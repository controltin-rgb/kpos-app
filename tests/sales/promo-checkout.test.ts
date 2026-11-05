import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'
import { requestId, seedShop } from '../helpers/shop'

async function ready() {
  const t = createTestApp()
  await t.setup()
  const shop = await seedShop(t)
  await t.call(1, 'shift.open', { openingFloatSatang: 100_000 })
  const item = (qty = 1) => ({ productId: shop.tea.id, sizeId: shop.sizes.s16, qty, optionIds: [shop.normalSweet] })
  const sell = (sender: number, extra: object = {}, qty = 1) =>
    t.call(sender, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [item(qty)], payment: { method: 'cash', tenderedSatang: 1_000_000 }, ...extra })
  return { t, shop, item, sell }
}

describe('automatic promotions at checkout (D21)', () => {
  it('applies the best promotion, records it and taxes the discounted total; quote matches checkout', async () => {
    const { t, shop, item, sell } = await ready()
    await t.call(1, 'promo.save', { name: 'ชานมลด 10%', type: 'percent', value: 1_000, rules: { categoryIds: [shop.category.id] } })
    await t.call(1, 'promo.save', { name: 'ลด 5 บาท', type: 'amount', value: 500 })
    const quote = await t.call(1, 'pos.quote', { items: [item(2)] })
    expect(quote).toMatchObject({ subtotalSatang: 9_000, discountSatang: 900, totalSatang: 8_100, vatSatang: 530 }) // 8100×7/107 = 529.9
    expect(quote.promotions.map((p) => p.name)).toEqual(['ชานมลด 10%'])

    const { bill } = await sell(1, {}, 2)
    expect(bill).toMatchObject({ subtotalSatang: 9_000, discountSatang: 900, totalSatang: 8_100, vatSatang: 530 })
    expect(bill.discounts).toEqual([{ kind: 'promotion', description: 'ชานมลด 10%', amountSatang: 900 }])
    expect(bill.items.reduce((s, i) => s + i.lineTotalSatang, 0)).toBe(8_100)
    expect((await t.call(1, 'promo.list')).find((p) => p.name === 'ชานมลด 10%')!.usedCount).toBe(1)
  })

  it('lets staff exclude a promotion', async () => {
    const { t, item, sell } = await ready()
    const p = await t.call(1, 'promo.save', { name: 'ลด 5 บาท', type: 'amount', value: 500 })
    expect((await t.call(1, 'pos.quote', { items: [item()], excludedPromotionIds: [p.id] })).discountSatang).toBe(0)
    const { bill } = await sell(1, { excludedPromotionIds: [p.id] })
    expect(bill.discountSatang).toBe(0)
  })
})

describe('coupons', () => {
  it('unlocks a coupon-only promotion, counts usage, stops at the limit and is released by void', async () => {
    const { t, item, sell } = await ready()
    const p = await t.call(1, 'promo.save', { name: 'คูปองลด 20', type: 'amount', value: 2_000, rules: { couponOnly: true } })
    await t.call(1, 'coupons.save', { code: 'hello20', promotionId: p.id, maxUses: 1 })
    expect((await t.call(1, 'pos.quote', { items: [item()] })).discountSatang).toBe(0)
    expect((await t.call(1, 'pos.quote', { items: [item()], couponCode: 'HELLO20' })).discountSatang).toBe(2_000)
    expect((await t.call(1, 'pos.quote', { items: [item()], couponCode: 'NOPE' })).couponError).toBe('not_found')

    const { bill } = await sell(1, { couponCode: 'hello20' })
    expect(bill.discounts).toEqual([{ kind: 'coupon', description: 'คูปองลด 20', amountSatang: 2_000 }])
    await t.fails('COUPON_INVALID', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [item()], payment: { method: 'cash', tenderedSatang: 10_000 }, couponCode: 'HELLO20' })

    await t.call(1, 'orders.void', { id: bill.id, reason: 'ลูกค้ายกเลิก' })
    expect((await t.call(1, 'coupons.list'))[0]!.usedCount).toBe(0)
  })
})

describe('members and points', () => {
  it('requires consent, earns on the paid total by tier, redeems in steps and reverses on void', async () => {
    const { t, item, sell } = await ready()
    await t.fails('INVALID_INPUT', 1, 'members.register', { phone: '0812345678', consent: false } as never)
    const m = await t.call(1, 'members.register', { phone: '0812345678', name: 'คุณเอ', consent: true })
    expect(m).toMatchObject({ phoneMasked: '081xxx5678', pointsBalance: 0, tierName: 'เงิน' })
    expect(await t.call(1, 'members.search', { phone: '0812' })).toHaveLength(1)

    // 45 × 11 = 495 baht → 19 points (every 25 baht)
    const a = await sell(1, { memberId: m.id }, 11)
    expect(a.bill.member).toMatchObject({ pointsEarned: 19, pointsRedeemed: 0 })
    await t.call(1, 'members.adjustPoints', { id: m.id, delta: 21, reason: 'ชดเชยลูกค้า' })
    expect((await t.call(1, 'members.search', { phone: '0812345678' }))[0]!.pointsBalance).toBe(40)

    await t.fails('INVALID_INPUT', 1, 'pos.quote', { items: [item()], memberId: m.id, redeemPoints: 30 }) // not a multiple of 20
    await t.fails('POINTS_INSUFFICIENT', 1, 'pos.quote', { items: [item()], memberId: m.id, redeemPoints: 60 })
    const b = await sell(1, { memberId: m.id, redeemPoints: 40 }, 2) // 90 − 20 = 70 → 2 points
    expect(b.bill.discounts).toContainEqual({ kind: 'points', description: 'แลก 40 แต้ม', amountSatang: 2_000 })
    expect(b.bill).toMatchObject({ totalSatang: 7_000, member: { pointsEarned: 2, pointsRedeemed: 40 } })
    expect((await t.call(1, 'members.search', { phone: '0812345678' }))[0]!.pointsBalance).toBe(2)

    await t.call(1, 'orders.void', { id: b.bill.id, reason: 'ลูกค้ายกเลิก' })
    expect((await t.call(1, 'members.search', { phone: '0812345678' }))[0]).toMatchObject({ pointsBalance: 40, lifetimePoints: 19 })
  })

  it('erases personal data on request (PDPA) and keeps the bills', async () => {
    const { t, sell } = await ready()
    const m = await t.call(1, 'members.register', { phone: '0899999999', name: 'คุณบี', consent: true })
    const { bill } = await sell(1, { memberId: m.id })
    await t.call(1, 'members.erase', { id: m.id, reason: 'ลูกค้าขอลบข้อมูล' })
    expect(await t.call(1, 'members.search', { phone: '0899' })).toEqual([])
    expect((await t.call(1, 'orders.get', { id: bill.id })).member).toMatchObject({ name: null, phoneMasked: '—' })
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'members.erase'`).pluck().get()).toBe('high')
  })
})

describe('manual discount (pos:discount, role limit, rule 4 audit)', () => {
  it('cashier needs a manager PIN; the manager can give it directly; audited', async () => {
    const { t, item, sell } = await ready()
    const cashier = await t.userOn(2, 'cashier1', 'cashier')
    const manager = await t.userOn(3, 'manager1', 'branch_manager')
    await t.call(1, 'users.setPin', { id: manager.id, pin: '2468' })
    void cashier
    const md = { kind: 'percent' as const, value: 2_000, reason: 'ลูกค้าประจำ' }
    await t.fails('APPROVAL_REQUIRED', 2, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [item()], payment: { method: 'cash', tenderedSatang: 10_000 }, manualDiscount: md })
    const { bill } = await sell(2, { manualDiscount: { ...md, approver: { username: 'manager1', pin: '2468' } } })
    expect(bill).toMatchObject({ discountSatang: 900, totalSatang: 3_600 })
    expect(bill.discounts[0]).toMatchObject({ kind: 'manual', amountSatang: 900 })
    const a = await sell(3, { manualDiscount: { kind: 'amount', value: 500, reason: 'ของแถมเสีย' } })
    expect(a.bill.discountSatang).toBe(500)
    const rows = t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'bill.discount' ORDER BY seq`).pluck().all()
    expect(rows).toEqual(['high', 'medium'])
  })

  it('enforces the role discount limit', async () => {
    const { t, item } = await ready()
    const role = await t.call(1, 'roles.create', { name: 'แคชเชียร์อาวุโส', permissions: ['pos:create', 'pos:discount'], maxDiscountBp: 1_000 })
    await t.call(1, 'users.create', { username: 'senior1', displayName: 'senior1', roleId: role.id, password: 'senior-pass-1', mustChangePassword: false })
    await t.call(4, 'auth.login', { username: 'senior1', password: 'senior-pass-1' })
    await t.call(4, 'pos.quote', { items: [item()], manualDiscount: { kind: 'percent', value: 1_000, reason: 'ลูกค้าประจำ' } })
    await t.fails('DISCOUNT_LIMIT', 4, 'pos.quote', { items: [item()], manualDiscount: { kind: 'percent', value: 1_100, reason: 'มากไป' } })
  })
})
