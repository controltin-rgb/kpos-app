import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@main/db/connection'
import { migrate } from '@main/db/migrate'
import { createClientContext } from '@main/lan/client-context'
import { HostConnection, pairWithHost } from '@main/lan/host-connection'
import { ClientStore } from '@main/sync/client-store'
import { nextPeriod } from '@main/sync/sync-host.service'
import type { QuoteDto } from '@shared/api-promo'
import type { SaleResult } from '@shared/api-sales'
import type { Envelope } from '@shared/errors'
import { DAY_MS } from '@shared/license'
import { ADMIN, createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'
import { requestId, seedShop } from '../helpers/shop'
import { closeAfter, tmpDir } from '../helpers/tmp'

const CLIENT_MIGRATIONS = join(import.meta.dirname, '../../migrations-client')
const stops: (() => unknown)[] = []
afterEach(async () => {
  while (stops.length) await stops.pop()!()
})

/** A port the OS hands out (random ports can hit Windows' reserved ranges → EACCES on CI); fixed per test so the Host can go offline and back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

/** Host + a paired Client with its offline store, logged in, shift open, snapshot pulled. */
async function setup(opts: { policy?: 'none' | 'daily' } = {}) {
  const port = await freePort()
  const t = createTestApp({ lan: { certDir: tmpDir('kposs-cert-'), bindHost: '127.0.0.1', listenPort: port } })
  stops.push(() => t.app.lan.stop())
  await t.setup()
  await installLicense(t, { features: { maxClients: 2 } })
  if (opts.policy) await t.call(1, 'settings.update', { 'bill.reset_policy': opts.policy })
  const shop = await seedShop(t)
  await t.call(1, 'promo.save', { name: 'ลด 10%', type: 'percent', value: 1_000, rules: {}, active: true, startsAt: null, endsAt: null })
  await t.call(1, 'lan.setMode', { mode: 'host' })
  const { code } = await t.call(1, 'lan.startPairing')
  const cfg = await pairWithHost(`127.0.0.1:${port}`, code, { name: 'POS-02', hardwareId: 'HW-C11E-0000-0000-0002', kind: 'pos' })

  const dbPath = join(tmpDir('kposs-client-'), 'client.sqlite')
  const local = closeAfter(openDatabase(dbPath))
  migrate(local, { dbPath, migrationsDir: CLIENT_MIGRATIONS, backupDir: join(tmpDir(), 'b') })
  const store = new ClientStore(local, () => t.now())
  const printed: string[] = []
  const c = createClientContext({
    conn: new HostConnection(cfg),
    device: { id: 'x', name: 'POS-02', hardwareId: 'h', role: 'client' },
    store,
    now: () => t.now(),
    printHtml: async (html) => void printed.push(html),
  })
  stops.push(() => c.stop())
  const raw = (channel: string, input?: unknown) => c.dispatch(5, channel, input)
  const call = async <T,>(channel: string, input?: unknown) => {
    const r = (await raw(channel, input)) as Envelope<T>
    if (!r.ok) throw new Error(`${channel}: ${JSON.stringify(r.error)}`)
    return r.data
  }
  await call('auth.login', { username: ADMIN.username, password: ADMIN.password })
  await call('shift.open', { openingFloatSatang: 100_000 })
  await c.sync!.pull()
  const goOffline = () => t.call(1, 'lan.setMode', { mode: 'standalone' })
  const goOnline = () => t.call(1, 'lan.setMode', { mode: 'host' })
  const cart = (n = 1) => [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: n, optionIds: [shop.normalSweet] }]
  const sell = (rid = requestId(), tendered = 10_000) =>
    raw('pos.checkout', { requestId: rid, orderType: 'takeaway', items: cart(), payment: { method: 'cash', tenderedSatang: tendered } }) as Promise<Envelope<SaleResult>>
  return { t, c, cfg, shop, store, call, raw, sell, cart, goOffline, goOnline, printed }
}

describe('offline numbering (D27)', () => {
  it('reserves a 200-number block per Client and the next period too when numbers reset', async () => {
    const { t, cfg, store } = await setup({ policy: 'daily' })
    const blocks = t.db.prepare('SELECT period, from_no, to_no FROM bill_number_blocks WHERE device_id = ? ORDER BY period').all(cfg.deviceId) as { period: string; from_no: number; to_no: number }[]
    expect(blocks).toHaveLength(2) // today + tomorrow
    expect(blocks.every((b) => b.to_no - b.from_no + 1 === 200)).toBe(true)
    expect(store.snapshot()!.blocks).toHaveLength(2)
    expect(nextPeriod('daily', Date.UTC(2026, 10, 7, 16, 59))).toBe('691108') // 23:59 ICT → tomorrow
    expect(nextPeriod('none', 0)).toBe('')
  })

  it('online bills continue after the reserved block', async () => {
    const { t, shop } = await setup()
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    const r = await t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 10_000 } })
    expect(r.bill.billNo).toBe('A-000201') // 1–200 belong to the Client
  })
})

describe('selling while the Host is down (D35, D36)', () => {
  it('sells from the snapshot with the same prices and promotions, then syncs it to the Host', async () => {
    const { t, c, cfg, call, raw, sell, cart, goOffline, goOnline, printed, store } = await setup()
    const onlineQuote = await call<QuoteDto>('pos.quote', { items: cart(2) })
    await goOffline()

    // the logged-in user keeps working; the POS has its catalog
    expect(await call('auth.me')).toMatchObject({ username: 'admin' })
    expect((await call<{ products: unknown[] }>('pos.catalog')).products.length).toBeGreaterThan(0)
    expect(await call<QuoteDto>('pos.quote', { items: cart(2) })).toEqual(onlineQuote) // same rules as the Host
    expect(onlineQuote.promotions).toHaveLength(1)
    expect(await raw('pos.quote', { items: cart(), couponCode: 'X' })).toMatchObject({ ok: false, error: { code: 'OFFLINE_NOT_SUPPORTED' } })

    const rid = requestId()
    const sale = await sell(rid)
    expect(sale.ok).toBe(true)
    if (!sale.ok) return
    expect(sale.data.bill.billNo).toBe('A-000001')
    expect(sale.data.bill.payments[0]).toMatchObject({ method: 'cash', tenderedSatang: 10_000 })
    // a retried checkout returns the same bill, no second sale
    expect(((await sell(rid)) as { ok: true; data: SaleResult }).data.bill.billNo).toBe('A-000001')
    expect(store.counts().pending).toBe(1)
    // receipt prints locally
    await call('orders.print', { id: rid })
    expect(printed[0]).toContain('A-000001')

    // closing the shift waits for the queue
    expect(await raw('shift.close', { shiftId: 'x', counts: [] })).toMatchObject({ ok: false, error: { code: 'SYNC_PENDING' } })

    await goOnline()
    await c.sync!.push()
    expect(store.counts()).toMatchObject({ pending: 0, sent: 1 })
    const bill = t.db.prepare('SELECT bill_no, device_id, total_satang, synced_at IS NOT NULL AS synced, shift_id FROM bills WHERE id = ?').get(rid) as Record<string, unknown>
    expect(bill).toMatchObject({ bill_no: 'A-000001', device_id: cfg.deviceId, total_satang: sale.data.bill.totalSatang, synced: 1 })
    // stock deducted by the BOM snapshot, cash in the Client's drawer
    const items = t.db.prepare('SELECT id FROM bill_items WHERE bill_id = ?').pluck().all(rid) as string[]
    expect(t.db.prepare(`SELECT count(*) FROM stock_ledger WHERE ref_type = 'bill_item' AND ref_id = ?`).pluck().get(items[0])).toBeGreaterThan(0)
    expect(t.db.prepare(`SELECT amount_satang FROM cash_ledger WHERE ref_id = ?`).pluck().get(rid)).toBe(sale.data.bill.totalSatang)
    expect(t.db.prepare('SELECT used_to FROM bill_number_blocks WHERE device_id = ?').pluck().get(cfg.deviceId)).toBe(1)
    expect(t.auditActions()).toContain('sync.offline_bills')
    expect(t.app.audit.verifyChain().ok).toBe(true)

    // now the shift can be closed, and its expected cash includes the offline sale
    const shift = await call<{ id: string }>('shift.current')
    const closed = await call<{ expectedCashSatang: number }>('shift.close', { shiftId: shift.id, counts: [] })
    expect(closed.expectedCashSatang).toBe(100_000 + sale.data.bill.totalSatang)
  })

  it('only people already logged in can sell offline', async () => {
    const { c, goOffline } = await setup()
    await goOffline()
    const other = await c.dispatch(9, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [], payment: { method: 'cash', tenderedSatang: 0 } })
    expect(other).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
  })

  it('the Host refuses tampered bills, keeps them in the audit log, and treats repeats as duplicates', async () => {
    const { t, cfg, sell, goOffline, store } = await setup()
    await goOffline()
    const rid = requestId()
    await sell(rid)
    const [bill] = store.pending()
    const deviceId = cfg.deviceId
    const forged = { ...bill!, id: '01a1b000-0000-7000-8000-00000000f001', billNo: 'A-000002', seq: 2, totalSatang: bill!.totalSatang - 100 }
    expect(t.app.syncHost.ingest(deviceId, [forged])).toEqual([{ id: forged.id, status: 'rejected', reason: 'totals' }])
    expect(t.auditActions()).toContain('sync.rejected_bill')
    const outside = { ...bill!, id: '01a1b000-0000-7000-8000-00000000f002', billNo: 'A-000999', seq: 999 }
    expect(t.app.syncHost.ingest(deviceId, [outside])[0]).toMatchObject({ status: 'rejected', reason: 'bill_number' })
    expect(t.app.syncHost.ingest(deviceId, [bill])[0]).toMatchObject({ status: 'ok' })
    expect(t.app.syncHost.ingest(deviceId, [bill])[0]).toMatchObject({ status: 'duplicate', billNo: 'A-000001' })
  })

  it('tops the block up when 50 or fewer numbers are left', async () => {
    const { t, cfg, c } = await setup()
    t.db.prepare('UPDATE bill_number_blocks SET used_to = 160 WHERE device_id = ?').run(cfg.deviceId)
    t.advance(DAY_MS / 24)
    await c.sync!.pull()
    const blocks = t.db.prepare('SELECT from_no, to_no FROM bill_number_blocks WHERE device_id = ? ORDER BY from_no').all(cfg.deviceId)
    expect(blocks).toEqual([
      { from_no: 1, to_no: 200 },
      { from_no: 201, to_no: 400 },
    ])
  })
})
