import { describe, expect, it } from 'vitest'
import { createAppContext } from '@main/app-context'
import { formatTaxId, isValidThaiTaxId } from '@shared/tax-id'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'
import { requestId, seedShop } from '../helpers/shop'

const DAY = 86_400_000
const SELLER = { 'tax.seller_name': 'บริษัท คอร์น คาเฟ่ จำกัด', 'tax.seller_tax_id': '0105556012341', 'tax.seller_branch': '00000', 'tax.seller_address': '1 ถนนสุขุมวิท กรุงเทพฯ 10110' }
const BUYER = { name: 'บริษัท ลูกค้า จำกัด', taxId: '0105556012341', branch: '00000', address: '99 ถนนพระราม 9 กรุงเทพฯ 10310' }

async function ready() {
  const t = createTestApp()
  await t.setup()
  const shop = await seedShop(t)
  await t.call(1, 'shift.open', { openingFloatSatang: 0 })
  const sell = (items: { sizeId: string; qty: number; topping?: boolean }[], extra: object = {}) =>
    t.call(1, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'takeaway',
      items: items.map((i) => ({ productId: shop.tea.id, sizeId: i.sizeId, qty: i.qty, optionIds: i.topping ? [shop.normalSweet, shop.extraPearl] : [shop.normalSweet] })),
      payment: { method: 'cash', tenderedSatang: 1_000_000 },
      ...extra,
    })
  return { t, shop, sell }
}

describe('Thai tax id', () => {
  it('validates the mod-11 checksum and formats', () => {
    expect(isValidThaiTaxId('0105556012341')).toBe(true)
    expect(isValidThaiTaxId('0-1055-56012-34-1')).toBe(true)
    expect(isValidThaiTaxId('0105556012345')).toBe(false)
    expect(isValidThaiTaxId('12345')).toBe(false)
    expect(formatTaxId('0105556012341')).toBe('0-1055-56012-34-1')
  })
})

describe('tax invoices (D19, D20) — formats must be reviewed by an accountant before use', () => {
  it('needs the seller details and a VAT bill', async () => {
    const { t, shop, sell } = await ready()
    const { bill } = await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    await t.fails('TAX_NOT_CONFIGURED', 1, 'tax.issue', { type: 'abbreviated', billId: bill.id })
    await t.fails('INVALID_INPUT', 1, 'settings.update', { 'tax.seller_tax_id': '0105556012345' })
    await t.call(1, 'settings.update', SELLER)
    await t.call(1, 'settings.update', { 'vat.rate_bp': 0 })
    const noVat = await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    await t.fails('TAX_NOT_CONFIGURED', 1, 'tax.issue', { type: 'abbreviated', billId: noVat.bill.id })
  })

  it('numbers each document type separately with a yearly reset; one active invoice per bill and type', async () => {
    const { t, shop, sell } = await ready()
    await t.call(1, 'settings.update', SELLER)
    const a = await sell([{ sizeId: shop.sizes.s22, qty: 2 }])
    const abb = await t.call(1, 'tax.issue', { type: 'abbreviated', billId: a.bill.id })
    expect(abb).toMatchObject({ type: 'abbreviated', invoiceNo: 'A-TA-69-000001', billNo: a.bill.billNo, totalSatang: 11_000, vatSatang: 720 })
    await t.fails('TAX_INVOICE_EXISTS', 1, 'tax.issue', { type: 'abbreviated', billId: a.bill.id })

    await t.fails('INVALID_INPUT', 1, 'tax.issue', { type: 'full', billId: a.bill.id, customer: { ...BUYER, taxId: '1234567890123' } })
    const full = await t.call(1, 'tax.issue', { type: 'full', billId: a.bill.id, customer: BUYER })
    expect(full).toMatchObject({ invoiceNo: 'A-TX-69-000001', customerName: BUYER.name, customerTaxId: BUYER.taxId })

    // wrong buyer address → cancel and issue a replacement that points to the original
    await t.call(1, 'tax.cancel', { id: full.id, reason: 'ที่อยู่ผู้ซื้อผิด' })
    const fixed = await t.call(1, 'tax.issue', { type: 'full', billId: a.bill.id, replacesId: full.id, customer: { ...BUYER, address: '100 ถนนพระราม 9 กรุงเทพฯ 10310' } })
    expect(fixed).toMatchObject({ invoiceNo: 'A-TX-69-000002', replacesNo: 'A-TX-69-000001' })
    expect(t.db.prepare(`SELECT risk FROM audit_log WHERE action = 'tax.cancel'`).pluck().get()).toBe('high')
    expect((await t.call(1, 'orders.get', { id: a.bill.id })).events.map((e) => e.event)).toContain('tax_invoice')

    // next Buddhist year starts again at 000001
    t.advance(365 * DAY)
    const b = await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    expect((await t.call(1, 'tax.issue', { type: 'full', billId: b.bill.id, customer: BUYER })).invoiceNo).toBe('A-TX-70-000001')
    await t.call(1, 'tax.print', { id: fixed.id })
  })

  it('cannot issue for a voided bill; cashier cannot issue', async () => {
    const { t, shop, sell } = await ready()
    await t.call(1, 'settings.update', SELLER)
    const { bill } = await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'tax.issue', { type: 'abbreviated', billId: bill.id })
    await t.call(1, 'orders.void', { id: bill.id, reason: 'ยกเลิก' })
    await t.fails('NOT_EDITABLE', 1, 'tax.issue', { type: 'abbreviated', billId: bill.id })
  })
})

describe('reports', () => {
  it('sales: totals, buckets, channels with commission, methods and top products', async () => {
    const { t, shop, sell } = await ready()
    await sell([{ sizeId: shop.sizes.s22, qty: 2 }]) // 110
    await sell([{ sizeId: shop.sizes.s16, qty: 1, topping: true }]) // 55
    await t.call(1, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'delivery',
      channel: 'grab',
      extOrderId: 'GF-1',
      commissionBp: 3_000,
      items: [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 2, optionIds: [shop.normalSweet] }], // 90, commission 27
      payment: { method: 'delivery' },
    })
    const v = await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    await t.call(1, 'orders.void', { id: v.bill.id, reason: 'ผิด' })

    const r = await t.call(1, 'reports.sales', { from: T0 - DAY, to: T0 + DAY, bucket: 'hour' })
    expect(r).toMatchObject({ billCount: 3, totalSatang: 25_500, voidCount: 1, avgBillSatang: 8_500 })
    expect(r.channels.find((c) => c.channel === 'grab')).toMatchObject({ totalSatang: 9_000, commissionSatang: 2_700, netSatang: 6_300 })
    expect(r.channels.find((c) => c.channel === 'takeaway')).toMatchObject({ totalSatang: 16_500, billCount: 2 })
    expect(r.methods).toEqual(expect.arrayContaining([{ method: 'cash', totalSatang: 16_500 }, { method: 'delivery', totalSatang: 9_000 }]))
    expect(r.topProducts[0]).toMatchObject({ name: 'ชานมไข่มุก', qty: 5, totalSatang: 25_500 })
    expect(r.buckets.reduce((s, b) => s + b.totalSatang, 0)).toBe(25_500)
  })

  it('profit uses the lot costs recorded in the stock ledger', async () => {
    const { t, shop, sell } = await ready()
    await sell([{ sizeId: shop.sizes.s16, qty: 1 }])
    const cogs = -(t.db.prepare(`SELECT sum(cost_satang) FROM stock_ledger WHERE reason = 'sale'`).pluck().get() as number)
    const p = await t.call(1, 'reports.profit', { from: T0 - DAY, to: T0 + DAY })
    expect(p.cogsSatang).toBe(cogs)
    expect(p.netSalesSatang).toBe(4_500 - 294) // VAT 2.94
    expect(p.grossProfitSatang).toBe(p.netSalesSatang - cogs)
    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'reports.profit', { from: T0 - DAY, to: T0 + DAY })
  })

  it('lists closed shifts for the Z-Report', async () => {
    const { t } = await ready()
    const s = (await t.call(1, 'shift.current'))!
    await t.call(1, 'shift.close', { shiftId: s.id, counts: [] })
    const z = await t.call(1, 'reports.zList', { from: T0 - DAY, to: T0 + DAY })
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ shiftNo: s.shiftNo, countedCashSatang: 0 })
  })
})

describe('export', () => {
  it('writes UTF-8 CSV with a BOM through the save dialog', async () => {
    const t = createTestApp()
    const saved: { name: string; content: string }[] = []
    const app = createAppContext({ db: t.db, authSecret: 'x'.repeat(48), now: () => T0, saveFile: async (name, content) => (saved.push({ name, content: String(content) }), `/tmp/${name}`) })
    await t.setup()
    const shop = await seedShop(t)
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    await t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 4_500 } })
    // same DB, second context with a capturing saveFile; log in on it
    await app.dispatch(7, 'auth.login', { username: 'admin', password: 'admin-pass-1234' })
    const res = await app.dispatch(7, 'reports.export', { report: 'sales', from: T0 - DAY, to: T0 + DAY })
    expect(res).toMatchObject({ ok: true })
    expect(saved[0]!.name).toMatch(/\.csv$/)
    expect(saved[0]!.content.startsWith('﻿')).toBe(true)
    expect(saved[0]!.content).toContain('A-000001')
  })
})
