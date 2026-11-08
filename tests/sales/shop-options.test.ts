import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'
import { requestId, seedShop } from '../helpers/shop'

async function ready() {
  const t = createTestApp()
  await t.setup()
  const shop = await seedShop(t)
  await t.call(1, 'shift.open', { openingFloatSatang: 100_000 })
  const item = { productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] }
  return { t, shop, item }
}

const product = (categoryId: string | null, sku: string | null = null) => ({
  name: `เมนู ${Math.random()}`,
  sku,
  categoryId,
  sizes: [{ label: 'ปกติ', priceSatang: 5_000, multiplierMilli: 1_000, isDefault: true }],
})

describe('automatic SKU (D47)', () => {
  it('numbers products per category prefix, keeps typed codes and never reuses a number', async () => {
    const { t, shop } = await ready()
    expect(shop.tea.sku).toBe('P-0001') // category without a prefix → P
    const coffee = await t.call(1, 'catalog.saveCategory', { name: 'กาแฟ', kdsStation: 'bar', skuPrefix: 'cof' })
    expect(coffee.skuPrefix).toBe('COF')
    await t.fails('INVALID_INPUT', 1, 'catalog.saveCategory', { name: 'ผิด', skuPrefix: 'กาแฟ' })

    expect(await t.call(1, 'catalog.nextSku', { categoryId: coffee.id })).toBe('COF-0001')
    const a = await t.call(1, 'catalog.saveProduct', product(coffee.id))
    const b = await t.call(1, 'catalog.saveProduct', product(coffee.id))
    expect([a.sku, b.sku]).toEqual(['COF-0001', 'COF-0002'])

    // a typed code is kept; a typed code in the series moves the counter past it
    expect((await t.call(1, 'catalog.saveProduct', product(coffee.id, 'COF-0010'))).sku).toBe('COF-0010')
    expect((await t.call(1, 'catalog.saveProduct', product(coffee.id, 'LATTE-1'))).sku).toBe('LATTE-1')
    expect((await t.call(1, 'catalog.saveProduct', product(coffee.id))).sku).toBe('COF-0011')

    // deleting the newest does not hand its number out again
    const c = await t.call(1, 'catalog.saveProduct', product(coffee.id))
    await t.call(1, 'catalog.deleteProduct', { id: c.id })
    expect((await t.call(1, 'catalog.saveProduct', product(coffee.id))).sku).toBe('COF-0013')

    // no category → P series continues
    expect((await t.call(1, 'catalog.saveProduct', product(null))).sku).toBe('P-0002')
    // clearing the SKU of an existing product gives it a new automatic code
    const edited = await t.call(1, 'catalog.saveProduct', { ...product(coffee.id), id: a.id, name: 'อเมริกาโน่', sku: null })
    expect(edited.sku).toBe('COF-0014')
  })
})

describe('delivery on/off (D45)', () => {
  it('is on by default; when off the POS, system info and checkout refuse delivery', async () => {
    const { t, item } = await ready()
    expect((await t.call(1, 'pos.catalog')).deliveryEnabled).toBe(true)
    const delivery = () =>
      t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'delivery', channel: 'grab', items: [item], payment: { method: 'delivery' } })
    await delivery()

    await t.call(1, 'settings.update', { 'sales.delivery_enabled': false })
    expect((await t.call(1, 'settings.get'))['sales.delivery_enabled']).toBe(false)
    expect((await t.call(1, 'pos.catalog')).deliveryEnabled).toBe(false)
    expect((await t.call(1, 'system.info')).deliveryEnabled).toBe(false)
    await t.fails('DELIVERY_DISABLED', 1, 'pos.checkout', { requestId: requestId(), orderType: 'delivery', channel: 'grab', items: [item], payment: { method: 'delivery' } })
    // dine-in still sells
    await t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'dine_in', items: [item], payment: { method: 'cash', tenderedSatang: 10_000 } })
    const audit = t.db.prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'settings.update' AND entity_id = 'sales.delivery_enabled'").get() as { before_json: string; after_json: string }
    expect(JSON.parse(audit.after_json)).toEqual({ 'sales.delivery_enabled': false })
  })
})

describe('member profiles (D46)', () => {
  it('creates and edits full profiles, shows purchase history and audits full-phone reveals', async () => {
    const { t, item } = await ready()
    await t.fails('INVALID_INPUT', 1, 'members.save', { phone: '0812345678' }) // no consent
    const m = await t.call(1, 'members.save', {
      phone: '0812345678',
      name: 'คุณบี',
      birthDate: '1995-04-12',
      email: 'b@example.com',
      lineId: 'b.line',
      phone2: '021234567',
      note: 'แพ้นม',
      consent: true,
    })
    expect(m).toMatchObject({ phoneMasked: '081xxx5678', phone2Masked: '021xxx4567', birthDate: '1995-04-12', email: 'b@example.com', lineId: 'b.line', note: 'แพ้นม', visitCount: 0, totalSpentSatang: 0 })
    await t.fails('INVALID_INPUT', 1, 'members.save', { phone: '0812345678', consent: true }) // duplicate phone
    await t.fails('INVALID_INPUT', 1, 'members.save', { id: m.id, email: 'not-an-email' })

    // edit = whole profile; omitted phone keeps it, '' or omitted optional fields are cleared
    const e = await t.call(1, 'members.save', { id: m.id, name: 'คุณบี (VIP)', note: '', email: '', birthDate: '1995-04-12', phone2: '021234567' })
    expect(e).toMatchObject({ name: 'คุณบี (VIP)', phoneMasked: '081xxx5678', note: null, email: null, lineId: null })

    // purchase history and totals (void excluded from totals, still listed)
    const sell = () => t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [item], payment: { method: 'cash', tenderedSatang: 10_000 }, memberId: m.id })
    await sell()
    const second = await sell()
    await t.call(1, 'orders.void', { id: second.bill.id, reason: 'ลูกค้ายกเลิก' })
    const d = await t.call(1, 'members.detail', { id: m.id })
    expect(d.member).toMatchObject({ visitCount: 1, totalSpentSatang: 4_500 })
    expect(d.member.lastVisitAt).not.toBeNull()
    expect(d.bills.total).toBe(2)
    expect(d.bills.items.map((b) => b.status)).toEqual(['void', 'paid'])
    expect((await t.call(1, 'members.list', { search: 'VIP' })).items[0]).toMatchObject({ id: m.id, totalSpentSatang: 4_500 })
    expect((await t.call(1, 'members.list', { search: '021' })).total).toBe(1) // second phone is searchable

    // full numbers only for promo:update, every reveal audited
    expect(await t.call(1, 'members.revealContact', { id: m.id })).toEqual({ phone: '0812345678', phone2: '021234567' })
    expect(t.db.prepare("SELECT count(*) FROM audit_log WHERE action = 'members.reveal_contact' AND entity_id = ?").pluck().get(m.id)).toBe(1)
    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'members.revealContact', { id: m.id })
    await t.fails('FORBIDDEN', 2, 'members.save', { id: m.id, name: 'x' })
    // the audit trail never holds the full number
    const trail = (t.db.prepare("SELECT group_concat(coalesce(before_json, '') || coalesce(after_json, '')) FROM audit_log WHERE entity = 'members'").pluck().get() as string) ?? ''
    expect(trail).not.toContain('0812345678')

    // PDPA erase clears every personal field
    await t.call(1, 'members.erase', { id: m.id, reason: 'ลูกค้าขอลบข้อมูล' })
    const row = t.db.prepare('SELECT name, birth_date, email, line_id, phone2, note FROM members WHERE id = ?').get(m.id)
    expect(row).toEqual({ name: null, birth_date: null, email: null, line_id: null, phone2: null, note: null })
  })
})
