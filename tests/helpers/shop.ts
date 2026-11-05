import type { createTestApp } from './app'
import { T0 } from './fixtures'

type App = ReturnType<typeof createTestApp>
const DAY = 86_400_000

/**
 * A small café through the real API (Implement.md §6.1 example):
 * ชานมไข่มุก 16oz (base) / 22oz (×1.375), cups per size (custom), lid fixed, topping ไข่มุกเพิ่ม (+30 g fixed, +10 ฿).
 * Milk has two lots: the OLDER expiry was received LATER, so FEFO must take it first.
 */
export async function seedShop(t: App) {
  const ing = async (name: string, baseUnit: 'ml' | 'g' | 'pcs', hasExpiry = false) =>
    (await t.call(1, 'inventory.saveIngredient', { name, baseUnit, hasExpiry })).id
  const milk = await ing('นมสด', 'ml', true)
  const pearl = await ing('ไข่มุก', 'g', true)
  const cup16 = await ing('แก้ว 16oz', 'pcs')
  const cup22 = await ing('แก้ว 22oz', 'pcs')
  const lid = await ing('ฝาโดม', 'pcs')

  const lot = (ingredientId: string, qtyMilli: number, totalCostSatang: number, expiresAt: number | null, receivedAt = T0) =>
    t.call(1, 'inventory.addLot', { ingredientId, qtyMilli, totalCostSatang, expiresAt, receivedAt })
  const milkLate = await lot(milk, 2_000_000, 9_000, T0 + 10 * DAY, T0 - 1 * DAY) // 2 L, received earlier, expires later
  const milkSoon = await lot(milk, 1_000_000, 4_600, T0 + 3 * DAY, T0) // 1 L, received later, expires sooner
  await lot(pearl, 1_000_000, 8_000, T0 + 5 * DAY)
  await lot(cup16, 100_000, 15_000, null)
  await lot(cup22, 100_000, 20_000, null)
  await lot(lid, 200_000, 10_000, null)

  const category = await t.call(1, 'catalog.saveCategory', { name: 'ชานม', kdsStation: 'bar' })
  const topping = await t.call(1, 'catalog.saveGroup', {
    name: 'Topping',
    minSelect: 0,
    maxSelect: 3,
    kdsHighlight: true,
    options: [{ name: 'ไข่มุกเพิ่ม', priceSatang: 1_000, items: [{ ingredientId: pearl, qtyMilli: 30_000, sizeMode: 'fixed' }] }],
  })
  const sweet = await t.call(1, 'catalog.saveGroup', {
    name: 'ความหวาน',
    minSelect: 1,
    maxSelect: 1,
    options: [{ name: 'หวานปกติ', isDefault: true }, { name: 'หวาน 0%' }],
  })
  const s16 = '01a1a000-0000-7000-8000-000000000016'
  const s22 = '01a1a000-0000-7000-8000-000000000022'
  const tea = await t.call(1, 'catalog.saveProduct', {
    name: 'ชานมไข่มุก',
    categoryId: category.id,
    sizes: [
      { id: s16, label: '16oz', priceSatang: 4_500, multiplierMilli: 1_000, isDefault: true },
      { id: s22, label: '22oz', priceSatang: 5_500, multiplierMilli: 1_375 },
    ],
    recipe: [
      { ingredientId: milk, qtyMilli: 120_000, sizeMode: 'scale' },
      { ingredientId: pearl, qtyMilli: 50_000, sizeMode: 'scale' },
      { ingredientId: cup16, qtyMilli: 1_000, sizeMode: 'custom', perSize: { [s16]: 1_000, [s22]: 0 } },
      { ingredientId: cup22, qtyMilli: 1_000, sizeMode: 'custom', perSize: { [s16]: 0, [s22]: 1_000 } },
      { ingredientId: lid, qtyMilli: 1_000, sizeMode: 'fixed' },
    ],
    modifierGroupIds: [sweet.id, topping.id],
  })

  const normalSweet = sweet.options.find((o) => o.name === 'หวานปกติ')!.id
  const extraPearl = topping.options[0]!.id
  return { ing: { milk, pearl, cup16, cup22, lid }, lots: { milkLate: milkLate.lotId, milkSoon: milkSoon.lotId }, tea, sizes: { s16, s22 }, normalSweet, extraPearl, category }
}

export const remaining = (t: App, lotId: string) =>
  t.db.prepare('SELECT qty_remaining_milli FROM stock_lots WHERE id = ?').pluck().get(lotId) as number

export const onHand = (t: App, ingredientId: string) =>
  t.db.prepare('SELECT ifnull(sum(qty_remaining_milli), 0) FROM stock_lots WHERE ingredient_id = ?').pluck().get(ingredientId) as number

/** Every lot's remaining quantity must equal the sum of its ledger rows (append-only ledger is the truth). */
export function assertLedgerMatchesLots(t: App) {
  const bad = t.db
    .prepare(
      `SELECT l.id, l.qty_remaining_milli, ifnull(sum(g.delta_qty_milli), 0) AS ledger
       FROM stock_lots l LEFT JOIN stock_ledger g ON g.lot_id = l.id GROUP BY l.id HAVING l.qty_remaining_milli <> ledger`,
    )
    .all()
  if (bad.length) throw new Error(`lots out of sync with ledger: ${JSON.stringify(bad)}`)
}

let n = 0
/** UUIDv7-shaped request id for checkout idempotency. */
export const requestId = () => `01a1b000-0000-7000-8000-${String(++n).padStart(12, '0')}`
