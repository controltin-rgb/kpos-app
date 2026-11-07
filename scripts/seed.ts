/**
 * Dev helper: fill a fresh data folder with sample data, driven through the real API
 * (same services, permissions, audit log and stock ledger as the app — nothing is inserted by hand).
 *
 *   pnpm seed                    → .data/userdata  (use: KPOSS_USER_DATA=.data/userdata pnpm dev)
 *   pnpm seed -- <folder>        → another userData folder
 *   pnpm seed -- --reset         → delete the target folder first, then seed
 *
 * Refuses to touch a folder that already finished first-run setup unless --reset is given.
 * Dev only: weak sample passwords are printed at the end.
 */
import { existsSync, rmSync } from 'node:fs'
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
const reset = args.includes('--reset')
const userData = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, '.data/userdata'))

if (reset && existsSync(userData)) {
  // only ever wipe a folder that looks like a KPOSS data folder
  if (!existsSync(join(userData, 'data', 'kposs.sqlite')) && !existsSync(join(userData, 'device.json'))) {
    console.error(`refusing to delete ${userData}: not a KPOSS data folder`)
    process.exit(1)
  }
  rmSync(userData, { recursive: true, force: true })
}

const paths = resolveDbPaths({ userData, isPackaged: false, resourcesPath: '', appPath: root })
const { db } = initDatabase(paths)

// ---- deterministic "clock" so history spans the past week ---------------------------------------
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const realNow = Date.now()
let clock = realNow - 7 * DAY
const ICT = 7 * HOUR

const app = createAppContext({
  db,
  authSecret: loadOrCreateSecret(join(userData, 'secrets', 'auth.key')),
  device: loadOrCreateDevice(join(userData, 'device.json')),
  now: () => clock,
  log: (m, e) => console.error(m, e),
})

// one logged-in "window" per sample user
const ADMIN = 1
const MANAGER = 2
const CASHIER = 3
async function call<C extends Channel>(sender: number, channel: C, input?: Input<C>): Promise<Output<C>> {
  const res = (await app.dispatch(sender, channel, input)) as Envelope<Output<C>>
  if (!res.ok) throw new Error(`${channel} failed: ${JSON.stringify(res.error)}`)
  return res.data
}

// small deterministic PRNG so every seed run produces the same shop
let seedState = 20261107
const rnd = () => {
  seedState = (seedState * 1_664_525 + 1_013_904_223) >>> 0
  return seedState / 0x1_0000_0000
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
/** ICT clock time (hh:mm) on the day that contains `dayStart`, as epoch ms. */
const at = (dayStart: number, h: number, m = 0) => dayStart + h * HOUR + m * MIN

async function main() {
  if (!(await call(ADMIN, 'setup.status')).setupRequired) {
    throw new Error(`${userData} is already set up. Re-run with --reset to start over.`)
  }

  // ---- shop, owner account ----------------------------------------------------------------------
  const PASSWORD = {
    admin: 'admin-pass-1234',
    manager: 'manager-pass-1234',
    cashier: 'cashier-pass-1234',
  }
  await call(ADMIN, 'setup.complete', { shopName: 'KPOSS Cafe (ตัวอย่าง)', branchName: 'สาขาหลัก', username: 'admin', password: PASSWORD.admin, displayName: 'เจ้าของร้าน' })

  const roleId = (key: string) => db.prepare('SELECT id FROM roles WHERE key = ?').pluck().get(key) as string
  for (const [sender, username, displayName, role, password, pin] of [
    [MANAGER, 'manager', 'ผู้จัดการสาขา', 'branch_manager', PASSWORD.manager, '2222'],
    [CASHIER, 'cashier', 'แคชเชียร์ น้องใหม่', 'cashier', PASSWORD.cashier, '1111'],
  ] as const) {
    await call(ADMIN, 'users.create', { username, displayName, roleId: roleId(role), password, pin, mustChangePassword: false })
    await call(sender, 'auth.login', { username, password })
  }
  await call(ADMIN, 'settings.update', { 'promptpay.id': '0812345678' } as Input<'settings.update'>).catch(() => undefined)

  // ---- suppliers & ingredients ------------------------------------------------------------------
  const sup = {
    dairy: (await call(ADMIN, 'purchasing.saveSupplier', { name: 'บจก. นมสดฟาร์มสุข', phone: '021234567', taxId: null, note: null })).id,
    market: (await call(ADMIN, 'purchasing.saveSupplier', { name: 'แม็คโคร สาขาใกล้ร้าน', phone: null, taxId: null, note: null })).id,
    pack: (await call(ADMIN, 'purchasing.saveSupplier', { name: 'ร้านบรรจุภัณฑ์ ก้อนใส', phone: '0899999999', taxId: null, note: null })).id,
  }
  type Unit = 'ml' | 'g' | 'pcs'
  const ing = async (name: string, baseUnit: Unit, o: { hasExpiry?: boolean; minQty?: number; daily?: boolean } = {}) =>
    (
      await call(ADMIN, 'inventory.saveIngredient', {
        name,
        baseUnit,
        hasExpiry: o.hasExpiry ?? false,
        minQtyMilli: Math.round((o.minQty ?? 0) * 1000),
        isDailyCount: o.daily ?? false,
      })
    ).id
  const I = {
    milk: await ing('นมสด', 'ml', { hasExpiry: true, minQty: 3000, daily: true }),
    cream: await ing('ครีมเทียมข้นหวาน', 'ml', { hasExpiry: true, minQty: 1000 }),
    pearl: await ing('ไข่มุก', 'g', { hasExpiry: true, minQty: 1500, daily: true }),
    blackTea: await ing('ใบชาดำ', 'g', { minQty: 300 }),
    thaiTea: await ing('ชาไทย (ผง)', 'g', { minQty: 300 }),
    matcha: await ing('มัทฉะ', 'g', { minQty: 200 }),
    coffee: await ing('เมล็ดกาแฟคั่ว', 'g', { minQty: 500 }),
    sugar: await ing('น้ำเชื่อม', 'ml', { minQty: 1000 }),
    ice: await ing('น้ำแข็ง', 'g', { minQty: 5000 }),
    cup16: await ing('แก้ว 16oz', 'pcs', { minQty: 100 }),
    cup22: await ing('แก้ว 22oz', 'pcs', { minQty: 100 }),
    lid: await ing('ฝาโดม', 'pcs', { minQty: 150 }),
    straw: await ing('หลอด', 'pcs', { minQty: 150 }),
  }

  // ---- receive stock a week ago (PO → receipt), two milk lots so FEFO is visible ---------------
  const D = (d: number) => realNow + d * DAY
  const dairyPo = await call(ADMIN, 'purchasing.saveOrder', {
    supplierId: sup.dairy,
    expectedAt: clock,
    note: 'สั่งประจำสัปดาห์',
    lines: [
      { ingredientId: I.milk, qtyOrderedMilli: 20_000_000, lineTotalSatang: 90_000 },
      { ingredientId: I.cream, qtyOrderedMilli: 5_000_000, lineTotalSatang: 38_000 },
    ],
  })
  await call(ADMIN, 'purchasing.setStatus', { id: dairyPo.id, status: 'ordered' })
  await call(ADMIN, 'purchasing.receive', {
    poId: dairyPo.id,
    supplierId: sup.dairy,
    note: null,
    lines: [
      { poLineId: dairyPo.lines[0]!.id, ingredientId: I.milk, qtyMilli: 20_000_000, totalCostSatang: 90_000, expiresAt: D(2), lotNo: 'MILK-A' },
      { poLineId: dairyPo.lines[1]!.id, ingredientId: I.cream, qtyMilli: 5_000_000, totalCostSatang: 38_000, expiresAt: D(30), lotNo: 'CRM-01' },
    ],
  })
  await call(ADMIN, 'purchasing.receive', {
    poId: null,
    supplierId: sup.market,
    note: null,
    lines: [
      { poLineId: null, ingredientId: I.pearl, qtyMilli: 6_000_000, totalCostSatang: 48_000, expiresAt: D(2), lotNo: 'PRL-A' },
      { poLineId: null, ingredientId: I.blackTea, qtyMilli: 1_000_000, totalCostSatang: 45_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.thaiTea, qtyMilli: 1_000_000, totalCostSatang: 52_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.matcha, qtyMilli: 500_000, totalCostSatang: 120_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.coffee, qtyMilli: 2_000_000, totalCostSatang: 140_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.sugar, qtyMilli: 10_000_000, totalCostSatang: 30_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.ice, qtyMilli: 100_000_000, totalCostSatang: 25_000, expiresAt: null, lotNo: null },
    ],
  })
  await call(ADMIN, 'purchasing.receive', {
    poId: null,
    supplierId: sup.pack,
    note: null,
    lines: [
      { poLineId: null, ingredientId: I.cup16, qtyMilli: 1_000_000, totalCostSatang: 150_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.cup22, qtyMilli: 1_000_000, totalCostSatang: 200_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.lid, qtyMilli: 2_000_000, totalCostSatang: 100_000, expiresAt: null, lotNo: null },
      { poLineId: null, ingredientId: I.straw, qtyMilli: 2_000_000, totalCostSatang: 60_000, expiresAt: null, lotNo: null },
    ],
  })
  // a second, fresher milk lot received later: FEFO must still take MILK-A (expires sooner) first
  clock += 3 * DAY
  await call(ADMIN, 'inventory.addLot', { ingredientId: I.milk, qtyMilli: 40_000_000, totalCostSatang: 180_000, expiresAt: D(9), lotNo: 'MILK-B' })
  clock -= 3 * DAY

  // ---- menu -------------------------------------------------------------------------------------
  const cat = async (name: string, color: string, sortOrder: number) =>
    (await call(ADMIN, 'catalog.saveCategory', { name, color, kdsStation: 'bar', sortOrder })).id
  const C = { milkTea: await cat('ชานม', '#F7C23A', 1), coffee: await cat('กาแฟ', '#B07A4A', 2), matcha: await cat('มัทฉะ', '#34C98A', 3) }

  const sweet = await call(ADMIN, 'catalog.saveGroup', {
    name: 'ระดับความหวาน',
    minSelect: 1,
    maxSelect: 1,
    sortOrder: 1,
    options: [
      { name: 'หวานปกติ', priceSatang: 0, isDefault: true, items: [{ ingredientId: I.sugar, qtyMilli: 20_000, sizeMode: 'scale' }] },
      { name: 'หวานน้อย', priceSatang: 0, items: [{ ingredientId: I.sugar, qtyMilli: 10_000, sizeMode: 'scale' }] },
      { name: 'ไม่หวาน', priceSatang: 0, items: [] },
    ],
  })
  const topping = await call(ADMIN, 'catalog.saveGroup', {
    name: 'ท็อปปิ้ง',
    minSelect: 0,
    maxSelect: 3,
    kdsHighlight: true,
    sortOrder: 2,
    options: [
      { name: 'ไข่มุกเพิ่ม', priceSatang: 1_000, items: [{ ingredientId: I.pearl, qtyMilli: 30_000, sizeMode: 'fixed' }] },
      { name: 'ครีมชีสฟองนม', priceSatang: 2_000, items: [{ ingredientId: I.cream, qtyMilli: 30_000, sizeMode: 'fixed' }] },
    ],
  })

  const product = async (
    name: string,
    categoryId: string,
    s16: number,
    recipe: Array<[ingredient: string, qty: number, mode: 'scale' | 'fixed']>,
  ) => {
    const id16 = uuidv7(clock)
    const id22 = uuidv7(clock + 1)
    return call(ADMIN, 'catalog.saveProduct', {
      name,
      categoryId,
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
  const P = [
    await product('ชานมไข่มุก', C.milkTea, 4_500, [[I.thaiTea, 12, 'scale'], [I.milk, 120, 'scale'], [I.pearl, 50, 'scale']]),
    await product('ชาไทยเย็น', C.milkTea, 4_000, [[I.thaiTea, 14, 'scale'], [I.cream, 40, 'scale'], [I.milk, 60, 'scale']]),
    await product('ชาดำเย็น', C.milkTea, 3_500, [[I.blackTea, 10, 'scale']]),
    await product('อเมริกาโน่เย็น', C.coffee, 5_000, [[I.coffee, 18, 'scale']]),
    await product('ลาเต้เย็น', C.coffee, 6_000, [[I.coffee, 18, 'scale'], [I.milk, 150, 'scale']]),
    await product('มัทฉะลาเต้', C.matcha, 6_500, [[I.matcha, 6, 'scale'], [I.milk, 150, 'scale']]),
  ]

  // ---- promotions, coupon, members --------------------------------------------------------------
  const happy = await call(ADMIN, 'promo.save', {
    name: 'Happy Hour ลด 10% (14:00–16:00)',
    type: 'percent',
    value: 1_000,
    rules: { startTime: '14:00', endTime: '16:00', combinable: false },
    active: true,
    startsAt: null,
    endsAt: null,
  })
  const welcome = await call(ADMIN, 'promo.save', { name: 'คูปองต้อนรับ ลด 10 บาท', type: 'amount', value: 1_000, rules: { couponOnly: true, minSpendSatang: 5_000 }, active: true, startsAt: null, endsAt: null })
  await call(ADMIN, 'coupons.save', { code: 'WELCOME10', promotionId: welcome.id, maxUses: 100, expiresAt: D(60) })
  void happy
  const members = [
    await call(CASHIER, 'members.register', { phone: '0891110001', name: 'คุณสมชาย', consent: true }),
    await call(CASHIER, 'members.register', { phone: '0891110002', name: 'คุณสมหญิง', consent: true }),
    await call(CASHIER, 'members.register', { phone: '0891110003', name: null, consent: true }),
  ]

  // ---- expense categories -----------------------------------------------------------------------
  const cats = await call(ADMIN, 'expenses.categories')
  const expCat = cats[0]?.id ?? (await call(ADMIN, 'expenses.saveCategory', { name: 'วัตถุดิบเบ็ดเตล็ด' } as Input<'expenses.saveCategory'>)).id

  // ---- a week of trading ------------------------------------------------------------------------
  const todayStartIct = Math.floor((realNow + ICT) / DAY) * DAY - ICT
  const DENOMS = [100_000, 50_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100] as const
  const breakdown = (satang: number) => {
    let left = satang
    return DENOMS.map((d) => {
      const count = Math.floor(left / d)
      left -= count * d
      return { denominationSatang: d, count }
    })
  }

  const sale = async (sender: number, opts: { delivery?: boolean; member?: string; coupon?: string; pay?: 'cash' | 'promptpay' | 'card' } = {}) => {
    const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const p = pick(P)
      const size = rnd() < 0.4 ? p.sizes[1]! : p.sizes[0]!
      const opt = [pick(sweet.options).id, ...(rnd() < 0.35 ? [pick(topping.options).id] : [])]
      return { productId: p.id, sizeId: size.id, qty: 1 + Math.floor(rnd() * 2), optionIds: opt, note: null }
    })
    const quote = await call(sender, 'pos.quote', { items, memberId: opts.member ?? null, couponCode: opts.coupon ?? null } as Input<'pos.quote'>)
    const total = quote.totalSatang
    const pay = opts.delivery ? 'delivery' : (opts.pay ?? (rnd() < 0.6 ? 'cash' : rnd() < 0.7 ? 'promptpay' : 'card'))
    const payment =
      pay === 'cash'
        ? { method: 'cash' as const, tenderedSatang: Math.ceil(total / 2_000) * 2_000 }
        : pay === 'promptpay'
          ? { method: 'promptpay' as const, confirmed: true as const, reference: null }
          : pay === 'card'
            ? { method: 'card' as const, reference: null }
            : { method: 'delivery' as const }
    return call(sender, 'pos.checkout', {
      requestId: uuidv7(clock),
      orderType: opts.delivery ? 'delivery' : rnd() < 0.7 ? 'dine_in' : 'takeaway',
      channel: opts.delivery ? pick(['grab', 'lineman', 'shopeefood'] as const) : null,
      extOrderId: opts.delivery ? `GF-${Math.floor(rnd() * 90000 + 10000)}` : null,
      commissionBp: opts.delivery ? 3_200 : null,
      items,
      payment,
      memberId: opts.member ?? null,
      couponCode: opts.coupon ?? null,
    } as Input<'pos.checkout'>)
  }

  for (let daysAgo = 7; daysAgo >= 0; daysAgo--) {
    const today = daysAgo === 0
    const dayStart = todayStartIct - daysAgo * DAY
    clock = today ? realNow - 3 * HOUR : at(dayStart, 7, 45)
    const sender = daysAgo % 2 ? CASHIER : MANAGER
    const shift = await call(sender, 'shift.open', { openingFloatSatang: 100_000 })

    const bills = today ? 6 : 14 + Math.floor(rnd() * 14)
    const span = today ? 2.5 * HOUR : 11 * HOUR
    for (let i = 0; i < bills; i++) {
      clock = (today ? realNow - 3 * HOUR : at(dayStart, 8)) + Math.floor(((i + rnd() * 0.8) / bills) * span)
      if (today && clock > realNow) clock = realNow - MIN
      const opts: Parameters<typeof sale>[1] = {}
      if (rnd() < 0.15) opts.delivery = true
      else if (rnd() < 0.2) opts.member = pick(members).id
      if (daysAgo === 3 && i === 2) opts.coupon = 'WELCOME10'
      await sale(sender, opts)
    }

    // one cash expense per day paid from the drawer
    clock += 10 * MIN
    if (!today) {
      await call(sender, 'expenses.create', { categoryId: expCat, amountSatang: 8_000 + Math.floor(rnd() * 12) * 500, source: 'drawer', description: pick(['น้ำแข็งเพิ่ม', 'ค่าขนส่งนม', 'ซื้อถุงขยะ', 'ค่าไฟ/น้ำย่อย']), hasTaxInvoice: false, vatSatang: 0 } as Input<'expenses.create'>)
    }

    // void one bill on day 4 (needs a reason; goes to audit_log with before/after)
    if (daysAgo === 4) {
      const list = await call(ADMIN, 'orders.list', {} as Input<'orders.list'>)
      const target = list.items.find((b) => b.status === 'paid')
      if (target) await call(MANAGER, 'orders.void', { id: target.id, reason: 'ลูกค้ายกเลิกออเดอร์ (ตัวอย่าง)' })
    }

    if (!today) {
      // close at night: drawer count off by a few baht on some days → Over/Short report
      const cur = await call(sender, 'shift.current')
      clock = at(dayStart, 19, 30)
      const expected = (cur as unknown as { expectedCashSatang?: number } | null)?.expectedCashSatang ?? 0
      const skew = daysAgo % 3 === 0 ? -2_000 : daysAgo % 5 === 0 ? 500 : 0
      await call(sender, 'shift.close', { shiftId: shift.id, counts: breakdown(Math.max(0, expected + skew)), note: skew ? 'นับเงินแล้วไม่ตรง (ตัวอย่าง)' : null })
    }
  }

  // ---- stock operations "today": waste, a pending count -----------------------------------------
  clock = realNow - 2 * HOUR
  await call(MANAGER, 'waste.record', { kind: 'ingredient', ingredientId: I.milk, lotId: null, qtyMilli: 500_000, reason: 'expired', note: 'นมหมดอายุ ตัวอย่าง' })
  await call(MANAGER, 'waste.record', { kind: 'drink', productId: P[0]!.id, sizeId: P[0]!.sizes[0]!.id, qty: 1, optionIds: [], reason: 'wrong_made', note: null })
  const count = await call(MANAGER, 'counts.create', { kind: 'daily', ingredientIds: [] } as Input<'counts.create'>)
  void count

  // leave the clock at real time so the app starts consistent
  clock = realNow

  const verify = await call(ADMIN, 'audit.verify')
  console.log('\nseeded:', userData)
  console.log('audit chain:', JSON.stringify(verify))
  for (const [t, label] of [
    ['bills', 'บิล'],
    ['stock_ledger', 'รายการสต็อก'],
    ['shifts', 'กะ'],
    ['expenses', 'ค่าใช้จ่าย'],
    ['audit_log', 'audit'],
  ] as const) {
    console.log(`  ${label.padEnd(12)} ${db.prepare(`SELECT count(*) FROM ${t}`).pluck().get()}`)
  }
  console.log('\nlogin (dev only):')
  console.log(`  admin    / ${PASSWORD.admin}   (เจ้าของร้าน)`)
  console.log(`  manager  / ${PASSWORD.manager}   PIN 2222`)
  console.log(`  cashier  / ${PASSWORD.cashier}   PIN 1111`)
  console.log(`\nrun: KPOSS_USER_DATA="${userData}" pnpm dev`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => db.close())
