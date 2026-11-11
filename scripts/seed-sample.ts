/**
 * DEV ONLY — adds sample master data (users, categories, products, recipes, ingredients, customers,
 * promotions, coupons) to an ALREADY set-up data folder, through the real API (permissions + audit log).
 * Never wipes anything and refuses to run when the folder already has products.
 *
 *   pnpm tsx scripts/seed-sample.ts --admin-password <pw> [folder]
 *     folder defaults to %APPDATA%/KPOSS-dev (the `pnpm dev` default). Close the dev app first.
 *
 * Not packaged (electron-builder ships only out/**). Sample passwords are weak — never use on a real shop.
 */
import { join, resolve } from 'node:path'
import { createAppContext } from '../src/main/app-context'
import { loadOrCreateSecret } from '../src/main/auth/secret'
import { initDatabase, resolveDbPaths } from '../src/main/db'
import { loadOrCreateDevice } from '../src/main/local-device'
import type { Channel, Input, Output } from '../src/shared/api'
import type { Envelope } from '../src/shared/errors'
import { uuidv7 } from '../src/shared/id'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2).filter((a) => a !== '--')
const pwIdx = args.indexOf('--admin-password')
const adminPassword = pwIdx >= 0 ? args[pwIdx + 1] : undefined
const folder = args.find((a, i) => !a.startsWith('--') && i !== pwIdx + 1)
const userData = resolve(folder ?? join(process.env['APPDATA'] ?? '', 'KPOSS-dev'))
if (!adminPassword) {
  console.error('usage: pnpm tsx scripts/seed-sample.ts --admin-password <pw> [folder]')
  process.exit(1)
}

const paths = resolveDbPaths({ userData, isPackaged: false, resourcesPath: '', appPath: root })
const { db } = initDatabase(paths)
const DAY = 86_400_000
const now = Date.now()
const app = createAppContext({
  db,
  authSecret: loadOrCreateSecret(join(userData, 'secrets', 'auth.key')),
  device: loadOrCreateDevice(join(userData, 'device.json')),
  now: () => Date.now(),
  log: (m, e) => console.error(m, e),
})
const ADMIN = 1
async function call<C extends Channel>(channel: C, input?: Input<C>): Promise<Output<C>> {
  const res = (await app.dispatch(ADMIN, channel, input)) as Envelope<Output<C>>
  if (!res.ok) throw new Error(`${channel} failed: ${JSON.stringify(res.error)}`)
  return res.data
}

async function main() {
  await call('auth.login', { username: 'admin', password: adminPassword! })
  if ((db.prepare('SELECT count(*) FROM products').pluck().get() as number) > 0) throw new Error('this data folder already has products — not adding samples')

  // ---- users ------------------------------------------------------------------------------------
  const roleId = (key: string) => db.prepare('SELECT id FROM roles WHERE key = ?').pluck().get(key) as string
  const existingUsers = new Set((db.prepare('SELECT username FROM users').pluck().all() as string[]))
  for (const [username, displayName, role, password, pin] of [
    ['owner', 'เจ้าของร้าน (ทดสอบ)', 'owner', 'owner123', '2222'],
    ['manager', 'ผู้จัดการสาขา (ทดสอบ)', 'branch_manager', 'manager123', '3333'],
    ['cashier', 'แคชเชียร์ (ทดสอบ)', 'cashier', 'cashier123', '4444'],
  ] as const) {
    if (existingUsers.has(username)) continue
    await call('users.create', { username, displayName, roleId: roleId(role), password, pin, mustChangePassword: false })
  }

  // ---- suppliers & ingredients ------------------------------------------------------------------
  const supplier = async (name: string, phone: string | null) => (await call('purchasing.saveSupplier', { name, phone, taxId: null, note: null })).id
  const sup = { dairy: await supplier('บจก. นมสดฟาร์มสุข', '021234567'), market: await supplier('แม็คโคร สาขาใกล้ร้าน', null), pack: await supplier('ร้านบรรจุภัณฑ์ ก้อนใส', '0899999999') }
  type Unit = 'ml' | 'g' | 'pcs'
  const ing = async (name: string, baseUnit: Unit, minQty: number, hasExpiry = false) =>
    (await call('inventory.saveIngredient', { name, baseUnit, hasExpiry, minQtyMilli: minQty * 1000, isDailyCount: false })).id
  const I = {
    milk: await ing('นมสด', 'ml', 3000, true),
    cream: await ing('ครีมเทียมข้นหวาน', 'ml', 1000, true),
    coconut: await ing('กะทิ', 'ml', 1000, true),
    pearl: await ing('ไข่มุก', 'g', 1500, true),
    jelly: await ing('เจลลี่มะพร้าว', 'g', 800, true),
    blackTea: await ing('ใบชาดำ', 'g', 300),
    thaiTea: await ing('ชาไทย (ผง)', 'g', 300),
    greenTea: await ing('ชาเขียว (ผง)', 'g', 300),
    matcha: await ing('มัทฉะ', 'g', 200),
    cocoa: await ing('ผงโกโก้', 'g', 300),
    coffee: await ing('เมล็ดกาแฟคั่ว', 'g', 500),
    syrup: await ing('น้ำเชื่อม', 'ml', 1000),
    peach: await ing('น้ำพีชเข้มข้น', 'ml', 800),
    lemon: await ing('น้ำมะนาว', 'ml', 800, true),
    ice: await ing('น้ำแข็ง', 'g', 5000),
    cup16: await ing('แก้ว 16oz', 'pcs', 100),
    cup22: await ing('แก้ว 22oz', 'pcs', 100),
    lid: await ing('ฝาโดม', 'pcs', 150),
    straw: await ing('หลอด', 'pcs', 150),
  }
  const exp = (days: number) => now + days * DAY
  const L = (ingredientId: string, qty: number, totalCostSatang: number, days: number | null = null, lotNo: string | null = null) => ({ poLineId: null, ingredientId, qtyMilli: qty * 1000, totalCostSatang, expiresAt: days === null ? null : exp(days), lotNo })
  await call('purchasing.receive', { poId: null, supplierId: sup.dairy, note: 'สต็อกตั้งต้น (ข้อมูลทดสอบ)', lines: [L(I.milk, 30_000, 135_000, 7, 'MILK-01'), L(I.cream, 6_000, 45_000, 60, 'CRM-01'), L(I.coconut, 5_000, 40_000, 30, 'COC-01')] })
  await call('purchasing.receive', {
    poId: null,
    supplierId: sup.market,
    note: 'สต็อกตั้งต้น (ข้อมูลทดสอบ)',
    lines: [
      L(I.pearl, 6_000, 48_000, 3, 'PRL-01'), L(I.jelly, 3_000, 36_000, 20, 'JEL-01'), L(I.blackTea, 1_000, 45_000), L(I.thaiTea, 1_000, 52_000), L(I.greenTea, 1_000, 60_000),
      L(I.matcha, 500, 120_000), L(I.cocoa, 1_000, 55_000), L(I.coffee, 3_000, 210_000), L(I.syrup, 10_000, 30_000), L(I.peach, 4_000, 56_000), L(I.lemon, 3_000, 30_000, 10, 'LMN-01'), L(I.ice, 100_000, 25_000),
    ],
  })
  await call('purchasing.receive', { poId: null, supplierId: sup.pack, note: 'สต็อกตั้งต้น (ข้อมูลทดสอบ)', lines: [L(I.cup16, 1_000, 150_000), L(I.cup22, 1_000, 200_000), L(I.lid, 2_000, 100_000), L(I.straw, 2_000, 60_000)] })

  // ---- categories, modifiers, products + recipes ----------------------------------------------
  const cat = async (name: string, color: string, sortOrder: number) => (await call('catalog.saveCategory', { name, color, kdsStation: 'bar', sortOrder })).id
  const C = {
    milkTea: await cat('ชานม', '#F7C23A', 1),
    coffee: await cat('กาแฟ', '#B07A4A', 2),
    matcha: await cat('มัทฉะ & ชาเขียว', '#34C98A', 3),
    fruit: await cat('ชาผลไม้ & โซดา', '#FF8A5B', 4),
    choco: await cat('โกโก้ & นมสด', '#8B5E3C', 5),
  }
  const sweet = await call('catalog.saveGroup', {
    name: 'ระดับความหวาน', minSelect: 1, maxSelect: 1, sortOrder: 1,
    options: [
      { name: 'หวานปกติ', priceSatang: 0, isDefault: true, items: [{ ingredientId: I.syrup, qtyMilli: 20_000, sizeMode: 'scale' }] },
      { name: 'หวานน้อย', priceSatang: 0, items: [{ ingredientId: I.syrup, qtyMilli: 10_000, sizeMode: 'scale' }] },
      { name: 'ไม่หวาน', priceSatang: 0, items: [] },
    ],
  })
  const topping = await call('catalog.saveGroup', {
    name: 'ท็อปปิ้ง', minSelect: 0, maxSelect: 3, kdsHighlight: true, sortOrder: 2,
    options: [
      { name: 'ไข่มุกเพิ่ม', priceSatang: 1_000, items: [{ ingredientId: I.pearl, qtyMilli: 30_000, sizeMode: 'fixed' }] },
      { name: 'เจลลี่มะพร้าว', priceSatang: 1_000, items: [{ ingredientId: I.jelly, qtyMilli: 30_000, sizeMode: 'fixed' }] },
      { name: 'ครีมชีสฟองนม', priceSatang: 2_000, items: [{ ingredientId: I.cream, qtyMilli: 30_000, sizeMode: 'fixed' }] },
    ],
  })
  type R = Array<[string, number, 'scale' | 'fixed']>
  const product = async (name: string, categoryId: string, s16: number, recipe: R) => {
    const id16 = uuidv7(now)
    const id22 = uuidv7(now + 1)
    return call('catalog.saveProduct', {
      name, categoryId,
      sizes: [
        { id: id16, label: '16oz', priceSatang: s16, multiplierMilli: 1_000, isDefault: true },
        { id: id22, label: '22oz', priceSatang: s16 + 1_000, multiplierMilli: 1_375, isDefault: false },
      ],
      recipe: [
        ...recipe.map(([ingredientId, qty, sizeMode]) => ({ ingredientId, qtyMilli: Math.round(qty * 1000), sizeMode })),
        { ingredientId: I.ice, qtyMilli: 150_000, sizeMode: 'scale' as const },
        { ingredientId: I.cup16, qtyMilli: 1_000, sizeMode: 'custom' as const, perSize: { [id16]: 1_000, [id22]: 0 } },
        { ingredientId: I.cup22, qtyMilli: 1_000, sizeMode: 'custom' as const, perSize: { [id16]: 0, [id22]: 1_000 } },
        { ingredientId: I.lid, qtyMilli: 1_000, sizeMode: 'fixed' as const },
        { ingredientId: I.straw, qtyMilli: 1_000, sizeMode: 'fixed' as const },
      ],
      modifierGroupIds: [sweet.id, topping.id],
    })
  }
  await product('ชานมไข่มุก', C.milkTea, 4_500, [[I.thaiTea, 12, 'scale'], [I.milk, 120, 'scale'], [I.pearl, 50, 'scale']])
  await product('ชาไทยเย็น', C.milkTea, 4_000, [[I.thaiTea, 14, 'scale'], [I.cream, 40, 'scale'], [I.milk, 60, 'scale']])
  await product('ชาดำเย็น', C.milkTea, 3_500, [[I.blackTea, 10, 'scale']])
  await product('ชานมกะทิ', C.milkTea, 5_000, [[I.blackTea, 10, 'scale'], [I.coconut, 80, 'scale'], [I.milk, 60, 'scale']])
  await product('อเมริกาโน่เย็น', C.coffee, 5_000, [[I.coffee, 18, 'scale']])
  await product('ลาเต้เย็น', C.coffee, 6_000, [[I.coffee, 18, 'scale'], [I.milk, 150, 'scale']])
  await product('คาปูชิโน่เย็น', C.coffee, 6_000, [[I.coffee, 18, 'scale'], [I.milk, 120, 'scale'], [I.cream, 20, 'scale']])
  await product('มัทฉะลาเต้', C.matcha, 6_500, [[I.matcha, 6, 'scale'], [I.milk, 150, 'scale']])
  await product('ชาเขียวนม', C.matcha, 4_500, [[I.greenTea, 12, 'scale'], [I.milk, 100, 'scale']])
  await product('ชาพีชมะนาว', C.fruit, 5_000, [[I.blackTea, 8, 'scale'], [I.peach, 40, 'scale'], [I.lemon, 20, 'scale']])
  await product('มะนาวโซดา', C.fruit, 4_000, [[I.lemon, 40, 'scale']])
  await product('โกโก้เย็น', C.choco, 4_500, [[I.cocoa, 20, 'scale'], [I.milk, 100, 'scale']])
  await product('นมสดชมพู', C.choco, 4_000, [[I.milk, 150, 'scale'], [I.syrup, 20, 'scale']])

  // ---- promotions & coupons ---------------------------------------------------------------------
  const promo = (name: string, type: 'percent' | 'amount', value: number, rules: Record<string, unknown>, endsAt: number | null = null) =>
    call('promo.save', { name, type, value, rules, active: true, startsAt: null, endsAt } as Input<'promo.save'>)
  await promo('Happy Hour ลด 10% (14:00–16:00)', 'percent', 1_000, { startTime: '14:00', endTime: '16:00', combinable: false })
  await promo('ลด 5 บาท เมื่อซื้อครบ 100 บาท', 'amount', 500, { minSpendSatang: 10_000 })
  const welcome = await promo('คูปองต้อนรับ ลด 10 บาท', 'amount', 1_000, { couponOnly: true, minSpendSatang: 5_000 })
  const member = await promo('คูปองสมาชิก ลด 15%', 'percent', 1_500, { couponOnly: true, minSpendSatang: 8_000 }, exp(90))
  const flash = await promo('คูปองวันเปิดร้านใหม่ ลด 20 บาท', 'amount', 2_000, { couponOnly: true, minSpendSatang: 15_000 }, exp(30))
  for (const [code, promotionId, maxUses, days] of [['WELCOME10', welcome.id, 100, 60], ['MEMBER15', member.id, 200, 90], ['OPENING20', flash.id, 50, 30], ['TESTEXPIRED', welcome.id, 5, -1]] as const) {
    await call('coupons.save', { code, promotionId, maxUses, expiresAt: exp(days) })
  }

  // ---- customers (members) ----------------------------------------------------------------------
  const customers: Array<[string, string | null]> = [
    ['0891110001', 'คุณสมชาย ใจดี'], ['0891110002', 'คุณสมหญิง รักกาแฟ'], ['0891110003', 'คุณวิชัย ชานม'], ['0891110004', 'คุณมาลี สายหวาน'], ['0891110005', 'คุณปิยะ ออฟฟิศ'],
    ['0891110006', 'คุณนภา นักศึกษา'], ['0891110007', 'คุณธนา ลูกค้าประจำ'], ['0891110008', 'คุณอรทัย'], ['0891110009', null], ['0891110010', 'คุณกิตติ มัทฉะ'],
  ]
  for (const [phone, name] of customers) await call('members.register', { phone, name, consent: true })

  const n = (t: string) => (db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number)
  console.log(`seeded sample data into ${userData}`)
  console.log({ users: n('users'), categories: n('categories'), products: n('products'), ingredients: n('ingredients'), promotions: n('promotions'), coupons: n('coupons'), members: n('members') })
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
