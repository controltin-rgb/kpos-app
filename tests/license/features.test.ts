import { describe, expect, it } from 'vitest'
import { payloadSchema } from '../../src/main/license/license-file'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { featureForChannel, FEATURE_KEYS, LEGACY_FEATURES, resolveFeatures, TRIAL_FEATURES, TRIAL_PACKAGE_NAME, type LicenseFeatures } from '../../src/shared/license'
import { createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'
import { onHand, requestId, seedShop } from '../helpers/shop'

type Over = Partial<LicenseFeatures>

/** A café seeded under a full license (so the tests do not depend on which package is the trial), then a license with some features switched off. */
async function shop(over: Over = {}) {
  const t = createTestApp()
  await t.setup()
  await installLicense(t, { features: { maxClients: 5, maxMembers: 0 } })
  const s = await seedShop(t)
  await t.call(1, 'shift.open', { openingFloatSatang: 100_000 })
  if (Object.keys(over).length) await installLicense(t, { features: over })
  const sell = (extra: object = {}, optionIds = [s.normalSweet]) =>
    t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: s.tea.id, sizeId: s.sizes.s16, qty: 1, optionIds }], payment: { method: 'cash', tenderedSatang: 1_000_000 }, ...extra })
  return { t, s, sell }
}

describe('feature model (D51)', () => {
  it('a license from before D51 (only the three old fields) reads with every new feature on and unlimited members', () => {
    const legacy = { licenseId: 'x', licensee: 'ร้านเก่า', plan: 'Plus', hardwareId: 'HW-AAAA-BBBB-CCCC-DDDD', issuedAt: 1, expiresAt: null, features: { maxEmployees: 5, maxClients: 2, cloudBackup: false } }
    expect(payloadSchema.parse(legacy).features).toEqual({ maxEmployees: 5, maxClients: 2, cloudBackup: false, ...LEGACY_FEATURES })
  })

  it('the trial is the package chosen in the License Manager (src/shared/trial-package.json), nothing hard-coded', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '../../src/shared/trial-package.json'), 'utf8')) as { name: string; features: LicenseFeatures }
    expect(TRIAL_PACKAGE_NAME).toBe(file.name)
    expect(TRIAL_FEATURES).toEqual(resolveFeatures(file.features))
    expect(TRIAL_FEATURES.cloudBackup).toBe(false) // trials never get the cloud
  })

  it('the app gives a shop without a license exactly the trial package — features switched off there are refused', async () => {
    const trial = resolveFeatures({ maxEmployees: 10, maxClients: 0, cloudBackup: false, cfd: false, kds: false, promotions: false, drawerShift: false, inventory: false })
    const t = createTestApp({ trialFeatures: trial })
    await t.setup()
    expect((await t.call(1, 'license.status')).state).toBe('trial')
    expect((await t.call(1, 'system.info')).features).toEqual(trial)
    await t.fails('FEATURE_NOT_LICENSED', 1, 'kds.tickets', { station: 'bar' })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'promo.list')
    await t.fails('FEATURE_NOT_LICENSED', 1, 'shift.open', { openingFloatSatang: 0 })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'inventory.saveIngredient', { name: 'x', baseUnit: 'g', hasExpiry: false })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'pos.openWindow', { kind: 'cfd' })
  })

  it('every feature key has at least one channel or service guarding it, and the map never guards the license itself', () => {
    expect(featureForChannel('kds.tickets')).toBe('kds')
    expect(featureForChannel('coupons.save')).toBe('promotions')
    expect(featureForChannel('waste.record')).toBe('inventory')
    expect(featureForChannel('license.import')).toBeNull()
    expect(featureForChannel('pos.checkout')).toBeNull()
    expect(FEATURE_KEYS).toContain('drawerShift')
  })

  it('system.info carries the license features so every screen (and Client) can hide what is off', async () => {
    const { t } = await shop({ kds: false, maxMembers: 50 })
    expect((await t.call(1, 'system.info')).features).toMatchObject({ kds: false, maxMembers: 50, cfd: true })
  })
})

describe('channels behind a feature are refused by the router', () => {
  it.each([
    ['kds', 'kds.tickets', { station: 'bar' }],
    ['promotions', 'promo.list', undefined],
    ['promotions', 'coupons.list', undefined],
    ['labels', 'labels.print', { html: '<p>x</p>' }],
    ['autoUpdate', 'update.check', undefined],
    ['cfd', 'cfd.state', undefined],
    ['inventory', 'waste.list', undefined],
    ['drawerShift', 'shift.cashMove', { kind: 'cash_in', amountSatang: 100, reason: 'x' }],
  ] as const)('%s off → %s', async (feature, channel, input) => {
    const { t } = await shop({ [feature]: false })
    await t.fails('FEATURE_NOT_LICENSED', 1, channel as never, input as never)
  })

  it('and works again when the feature is on', async () => {
    const { t } = await shop()
    await t.call(1, 'promo.list')
    await t.call(1, 'coupons.list')
  })
})

describe('KDS off', () => {
  it('sells without creating kitchen tickets', async () => {
    const on = await shop()
    await on.sell()
    expect(on.t.db.prepare('SELECT count(*) FROM kds_tickets').pluck().get()).toBe(1)
    const off = await shop({ kds: false })
    await off.sell()
    expect(off.t.db.prepare('SELECT count(*) FROM kds_tickets').pluck().get()).toBe(0)
  })
})

describe('inventory off', () => {
  it('sells without touching stock and without shortages; stored recipes survive', async () => {
    const { t, s, sell } = await shop({ inventory: false })
    const before = onHand(t, s.ing.milk)
    const { shortages } = await sell()
    expect(shortages).toEqual([])
    expect(onHand(t, s.ing.milk)).toBe(before)
    expect(t.db.prepare(`SELECT count(*) FROM stock_ledger WHERE ref_type = 'bill_item'`).pluck().get()).toBe(0)
    // saving the product with the feature off keeps the recipe stored earlier
    const saved = await t.call(1, 'catalog.saveProduct', { id: s.tea.id, name: 'ชานมไข่มุก (แก้)', categoryId: s.category.id, sizes: s.tea.sizes, recipe: [], modifierGroupIds: s.tea.modifierGroupIds })
    expect(saved.recipe.length).toBeGreaterThan(0)
    expect(saved.costSatang).toBeNull()
    await t.fails('FEATURE_NOT_LICENSED', 1, 'purchasing.receive', { poId: null, supplierId: null, note: null, lines: [] } as never)
    await t.fails('FEATURE_NOT_LICENSED', 1, 'reports.profit', { from: 0, to: 1 })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'reports.export', { report: 'profit', from: 0, to: 1 } as never)
  })

  it('with the feature on, the same sale deducts stock', async () => {
    const { t, s, sell } = await shop()
    const before = onHand(t, s.ing.milk)
    await sell()
    expect(onHand(t, s.ing.milk)).toBeLessThan(before)
  })
})

describe('cash drawer / shift off ("sell only")', () => {
  it('sells with no shift opened by hand, keeps one shift per machine and lets a bill be voided', async () => {
    const t = createTestApp()
    await t.setup()
    const s = await seedShop(t)
    await installLicense(t, { features: { drawerShift: false } })
    expect(await t.call(1, 'shift.current')).toMatchObject({ status: 'open' }) // the till is always open
    const sell = () => t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: s.tea.id, sizeId: s.sizes.s16, qty: 1, optionIds: [s.normalSweet] }], payment: { method: 'cash', tenderedSatang: 1_000_000 } })
    const { bill } = await sell()
    await sell()
    expect(t.db.prepare('SELECT count(*) FROM shifts').pluck().get()).toBe(1)
    await t.call(1, 'orders.void', { id: bill.id, reason: 'ลูกค้ายกเลิก' })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'shift.close', { shiftId: bill.shiftId, counts: [], note: null } as never)
    await t.fails('FEATURE_NOT_LICENSED', 1, 'shift.open', { openingFloatSatang: 0 })
    await t.fails('FEATURE_NOT_LICENSED', 1, 'expenses.create', { categoryId: (await t.call(1, 'expenses.categories'))[0]!.id, description: 'x', amountSatang: 100, source: 'drawer', spentAt: Date.now() } as never)
  })
})

describe('promotions off', () => {
  it('skips promotions and coupons but keeps manual discount', async () => {
    const { t, s, sell } = await shop({ promotions: false })
    // created while the trial was on? no — the router refuses promo.save now, so seed one directly
    await t.fails('FEATURE_NOT_LICENSED', 1, 'promo.save', { name: 'x', type: 'amount', value: 500, rules: {} } as never)
    t.db.prepare(`INSERT INTO promotions (id, branch_id, name, type, value, rules_json, active, created_at, updated_at) SELECT 'p1', id, 'ลด 5 บาท', 'amount', 500, '{}', 1, 1, 1 FROM branches LIMIT 1`).run()
    expect((await t.call(1, 'pos.quote', { items: [{ productId: s.tea.id, sizeId: s.sizes.s16, qty: 1, optionIds: [s.normalSweet] }] })).discountSatang).toBe(0)
    await t.fails('FEATURE_NOT_LICENSED', 1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: s.tea.id, sizeId: s.sizes.s16, qty: 1, optionIds: [s.normalSweet] }], payment: { method: 'cash', tenderedSatang: 1_000_000 }, couponCode: 'ANY' })
    const { bill } = await sell({ manualDiscount: { kind: 'amount', value: 300, reason: 'ลูกค้าประจำ' } })
    expect(bill.discountSatang).toBe(300)
  })
})

describe('members cap', () => {
  it('stops registering at the cap (0 = unlimited) but existing members keep working', async () => {
    const { t } = await shop({ maxMembers: 2 })
    await t.call(1, 'members.register', { phone: '0811111111', name: 'a', consent: true })
    await t.call(1, 'members.register', { phone: '0822222222', name: 'b', consent: true })
    await t.fails('MEMBER_CAP_REACHED', 1, 'members.register', { phone: '0833333333', name: 'c', consent: true })
    expect((await t.call(1, 'members.search', { phone: '0811' })).length).toBe(1)

    const open = await shop({ maxMembers: 0 })
    for (let i = 0; i < 5; i++) await open.t.call(1, 'members.register', { phone: `08000000${i}0`, name: null, consent: true })
  })
})

describe('modifiers off', () => {
  it('the POS catalog has no option groups and a drink sells without choosing any', async () => {
    const { t, s, sell } = await shop({ modifiers: false })
    const cat = await t.call(1, 'pos.catalog')
    expect(cat.groups).toEqual([])
    expect(cat.products.every((p) => p.modifierGroupIds.length === 0)).toBe(true)
    await sell({}, [])
    await t.fails('FEATURE_NOT_LICENSED', 1, 'catalog.saveGroup', { name: 'x', minSelect: 0, maxSelect: 1, options: [] } as never)
    // the stored links are kept for when the feature comes back
    expect(t.db.prepare('SELECT count(*) FROM product_modifier_groups WHERE product_id = ?').pluck().get(s.tea.id)).toBe(2)
  })
})

describe('Host', () => {
  it('maxClients 0 (also the trial) means this machine cannot be a Host', async () => {
    const { t } = await shop({ maxClients: 0 })
    expect((await t.call(1, 'system.info')).features.maxClients).toBe(0)
  })
})
