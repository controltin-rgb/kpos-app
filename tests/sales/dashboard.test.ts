import { describe, expect, it } from 'vitest'
import { periodRange } from '@main/services/dashboard.service'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'
import { requestId, seedShop } from '../helpers/shop'

const DAY = 86_400_000

describe('dashboard periods (Bangkok time)', () => {
  it('computes today / yesterday / week (Mon) / month boundaries', () => {
    const today = Date.UTC(2026, 10, 4, 17) // 05/11/2026 00:00 Bangkok
    expect(periodRange('today', T0)).toEqual({ from: today, to: today + DAY, prevFrom: today - DAY, prevTo: today })
    expect(periodRange('week', T0).from).toBe(today - 3 * DAY) // Monday 02/11
    expect(periodRange('month', T0)).toMatchObject({ from: Date.UTC(2026, 9, 31, 17), prevFrom: Date.UTC(2026, 8, 30, 17) })
  })
})

describe('dashboard summary and notifications', () => {
  it('summarises sales, channels, top products, stock alerts and the open shift', async () => {
    const t = createTestApp()
    await t.setup()
    const shop = await seedShop(t)
    await t.call(1, 'shift.open', { openingFloatSatang: 150_000 })
    const sell = (qty: number, extra: object = {}) =>
      t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 100_000 }, ...extra })
    await sell(2)
    await sell(1)
    t.advance(-DAY) // a sale "yesterday" to compare with
    await sell(1)
    t.advance(DAY)

    const d = await t.call(1, 'dashboard.summary', { period: 'today' })
    expect(d).toMatchObject({ salesSatang: 13_500, bills: 2, avgBillSatang: 6_750, itemsPerBillX10: 15, deltaPct: 200 })
    expect(d.top[0]).toEqual({ name: 'ชานมไข่มุก', qty: 3, unit: 'cup' })
    expect(d.chart.values.reduce((a, b) => a + b, 0)).toBe(13_500)
    expect(d.channels.find((c) => c.channel === 'takeaway')!.bills).toBe(2)
    expect(d.shift).toMatchObject({ openingFloatSatang: 150_000, expectedCashSatang: 150_000 + 13_500 + 4_500 })
    expect(d.stock.exp3Count).toBe(1) // milk lot expiring in 3 days
    expect(d.grossProfitSatang).not.toBeNull()

    const n = await t.call(1, 'notifications.list')
    expect(n.items.some((i) => i.kind === 'near_expiry')).toBe(true)
    expect(n.unread).toBeGreaterThan(0)
    await t.call(1, 'notifications.read', { id: null })
    expect((await t.call(1, 'notifications.list')).unread).toBe(0)

    // cashier sees the dashboard without cost figures
    await t.userOn(2, 'cashier1', 'cashier')
    expect((await t.call(2, 'dashboard.summary', { period: 'today' })).grossProfitSatang).toBeNull()
  })
})
