import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientContext } from '@main/lan/client-context'
import { HostConnection, pairWithHost, type HostConfig } from '@main/lan/host-connection'
import { loadOrCreateHostCert } from '@main/lan/cert'
import type { AppEvent } from '@shared/api'
import type { Envelope } from '@shared/errors'
import { ADMIN, createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'
import { requestId, seedShop } from '../helpers/shop'
import { tmpDir } from '../helpers/tmp'

const CLIENT_HW = 'HW-C11E-0000-0000-0001'
const stops: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (stops.length) await stops.pop()!()
})

async function host(opts: { clients?: number } = {}) {
  const hostPrints: string[] = []
  const t = createTestApp({
    lan: { certDir: tmpDir('kposs-cert-'), bindHost: '127.0.0.1', listenPort: 0 },
    printHtml: async (html) => void hostPrints.push(html),
    device: { id: '00000000-0000-7000-8000-0000000000a1', name: 'HOST', hardwareId: 'host-hw', role: 'standalone' },
  })
  stops.push(() => t.app.lan.stop())
  await t.setup()
  if (opts.clients !== 0) await installLicense(t, { features: { maxClients: opts.clients ?? 2 } })
  await t.call(1, 'lan.setMode', { mode: 'host' })
  const address = `127.0.0.1:${t.app.lan.listeningPort}`
  return { t, address, hostPrints }
}

async function client(cfg: HostConfig) {
  const printed: { html: string; paperMm: number }[] = []
  const saved: string[] = []
  const conn = new HostConnection(cfg)
  const c = createClientContext({
    conn,
    device: { id: 'local-id-unused', name: 'POS-02', hardwareId: CLIENT_HW, role: 'client' },
    printHtml: async (html, o) => void printed.push({ html, paperMm: o.paperMm }),
    saveFile: async (name) => (saved.push(name), `C:/exports/${name}`),
  })
  stops.push(() => c.stop())
  const call = async <T,>(sender: number, channel: string, input?: unknown) => {
    const r = (await c.dispatch(sender, channel, input)) as Envelope<T>
    if (!r.ok) throw new Error(`${channel}: ${JSON.stringify(r.error)}`)
    return r.data
  }
  const fails = async (code: string, sender: number, channel: string, input?: unknown) => {
    const r = await c.dispatch(sender, channel, input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(code)
  }
  return { c, conn, call, fails, printed, saved }
}

async function paired(opts: { clients?: number } = {}) {
  const h = await host(opts)
  const { code } = await h.t.call(1, 'lan.startPairing')
  const cfg = await pairWithHost(h.address, code, { name: 'POS-02', hardwareId: CLIENT_HW, kind: 'pos' })
  return { ...h, cfg, ...(await client(cfg)) }
}

describe('pairing (D34)', () => {
  it('pairs with the code shown on the Host, pins its certificate and audits it', async () => {
    const { t, cfg, address } = await paired()
    expect(cfg).toMatchObject({ hostName: 'HOST', shopName: 'KPOSS Cafe', hostname: '127.0.0.1' })
    expect(cfg.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(t.db.prepare(`SELECT name, role, kind, token_hash IS NOT NULL AS has_token FROM devices WHERE id = ?`).get(cfg.deviceId)).toEqual({ name: 'POS-02', role: 'client', kind: 'pos', has_token: 1 })
    expect(t.auditActions()).toEqual(expect.arrayContaining(['lan.set_mode', 'lan.pairing_start', 'lan.pair']))
    // the code is single use
    await expect(pairWithHost(address, 'AAAAAAAA', { name: 'x', hardwareId: 'HW-X', kind: 'pos' })).rejects.toMatchObject({ code: 'LAN_PAIRING_INVALID' })
    const s = await t.call(1, 'lan.status')
    expect(s).toMatchObject({ role: 'host', running: true, maxClients: 2, pairing: null })
    expect(s.clients).toHaveLength(1)
  })

  it('rejects a wrong code and closes pairing after 5 wrong guesses', async () => {
    const { t, address } = await host()
    const { code } = await t.call(1, 'lan.startPairing')
    for (let i = 0; i < 5; i++) await expect(pairWithHost(address, 'BBBBBBBB', { name: 'x', hardwareId: 'HW-X', kind: 'pos' })).rejects.toMatchObject({ code: 'LAN_PAIRING_INVALID' })
    // even the right code no longer works
    await expect(pairWithHost(address, code, { name: 'x', hardwareId: 'HW-X', kind: 'pos' })).rejects.toMatchObject({ code: 'LAN_PAIRING_INVALID' })
  })

  it('respects the number of Clients in the license (trial: none)', async () => {
    const { t, address } = await host({ clients: 0 })
    const { code } = await t.call(1, 'lan.startPairing')
    await expect(pairWithHost(address, code, { name: 'x', hardwareId: 'HW-X', kind: 'pos' })).rejects.toMatchObject({ code: 'LAN_CLIENT_LIMIT' })
  })

  it('refuses a Host whose certificate differs from the pinned one', async () => {
    const { cfg } = await paired()
    const other = await loadOrCreateHostCert(tmpDir('kposs-cert-'))
    const evil = new HostConnection({ ...cfg, certPem: other.cert, fingerprint: other.fingerprint })
    await expect(evil.rpc(1, 'auth.me', undefined)).rejects.toMatchObject({ code: 'LAN_CERT_MISMATCH' })
  })
})

describe('Client works through the Host (D33)', () => {
  it('logs in, opens its own shift and sells as its own device', async () => {
    const { t, cfg, call } = await paired()
    const shop = await seedShop(t)
    await call(5, 'auth.login', { username: ADMIN.username, password: ADMIN.password })
    expect(await call<{ username: string }>(5, 'auth.me')).toMatchObject({ username: 'admin' })

    await call(5, 'shift.open', { openingFloatSatang: 100_000 })
    // the Host's own drawer is separate
    expect(await t.call(1, 'shift.current')).toBeNull()
    expect(t.db.prepare('SELECT device_id FROM shifts').pluck().all()).toEqual([cfg.deviceId])

    const sale = await call<{ bill: { id: string } }>(5, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'takeaway',
      items: [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] }],
      payment: { method: 'cash', tenderedSatang: 10_000 },
    })
    expect(t.db.prepare('SELECT device_id FROM bills WHERE id = ?').pluck().get(sale.bill.id)).toBe(cfg.deviceId)
    // audit rows name the Client device
    expect(t.db.prepare(`SELECT device_id FROM audit_log WHERE action = 'shift.open'`).pluck().get()).toBe(cfg.deviceId)
  })

  it('prints and saves on the Client, not on the Host', async () => {
    const { t, call, printed, saved, hostPrints } = await paired()
    const shop = await seedShop(t)
    await call(5, 'auth.login', { username: ADMIN.username, password: ADMIN.password })
    await call(5, 'shift.open', { openingFloatSatang: 0 })
    const sale = await call<{ bill: { id: string } }>(5, 'pos.checkout', {
      requestId: requestId(),
      orderType: 'takeaway',
      items: [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] }],
      payment: { method: 'cash', tenderedSatang: 10_000 },
    })
    await call(5, 'orders.print', { id: sale.bill.id })
    expect(printed).toHaveLength(1)
    expect(printed[0]!.html).toContain('ชานมไข่มุก')
    expect(hostPrints).toHaveLength(0)

    const path = await call<string | null>(5, 'reports.export', { report: 'sales', from: 0, to: Date.now() + 1e10 })
    expect(saved[0]).toMatch(/\.csv$/)
    expect(path).toBe(`C:/exports/${saved[0]}`)
  })

  it('each Client window has its own session; KDS windows share their opener’s', async () => {
    const { c, call } = await paired()
    await call(5, 'auth.login', { username: ADMIN.username, password: ADMIN.password })
    expect(await call(6, 'auth.me')).toBeNull()
    c.aliasWindow(6, 5)
    expect(await call(6, 'auth.me')).toMatchObject({ username: 'admin' })
  })

  it('the session lives with the Client window: a Host restart keeps it, a Client restart does not inherit it', async () => {
    const { t, cfg, call } = await paired()
    await call(5, 'auth.login', { username: ADMIN.username, password: ADMIN.password })
    // nothing about the Client window stays in the Host's memory between calls (a Host restart loses nothing)
    expect([...(t.app.sessions as unknown as { map: Map<number, string> }).map.keys()].filter((k) => k < 0)).toEqual([])
    expect(await call(5, 'auth.me')).toMatchObject({ username: 'admin' })
    // the Client app restarts: same window id, new run → not logged in
    const restarted = await client(cfg)
    expect(await restarted.call(5, 'auth.me')).toBeNull()
  })

  it('keeps the customer display local and refuses Host administration from a Client', async () => {
    const { call, fails, conn } = await paired()
    await call(5, 'auth.login', { username: ADMIN.username, password: ADMIN.password })
    const cfd = { orderLabel: 'A', lines: [], discountSatang: 0, vatSatang: 0, totalSatang: 0, vatRateBp: 700, promptPayPayload: null, state: 'idle' }
    await call(5, 'pos.showOnCfd', cfd)
    expect(await call(7, 'cfd.state')).toMatchObject({ orderLabel: 'A' })
    await fails('LAN_NOT_AVAILABLE', 5, 'lan.startPairing')
    // even sent straight to the Host, mode switching is refused for remote callers
    expect((await conn.rpc(5, 'lan.setMode', { mode: 'standalone' })).envelope).toMatchObject({ ok: false, error: { code: 'LAN_NOT_AVAILABLE' } })
    expect(await call(5, 'lan.status')).toMatchObject({ role: 'client', host: { name: 'HOST', connected: true } })
  })

  it('receives Host events (KDS / shifts) over the event stream', async () => {
    const { t, c } = await paired()
    const got: AppEvent[] = []
    c.events.on('event', (e: AppEvent) => got.push(e))
    await vi.waitFor(() => expect(t.app.lan.host.connected.size).toBe(1), { timeout: 3_000 })
    await t.call(1, 'shift.open', { openingFloatSatang: 0 }) // a change on the Host
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'shift.changed' }), { timeout: 3_000 })
  })

  it('a revoked Client is locked out', async () => {
    const { t, cfg, fails } = await paired()
    await t.call(1, 'lan.revokeDevice', { id: cfg.deviceId })
    await fails('LAN_DEVICE_REVOKED', 5, 'auth.me')
    expect(t.auditActions()).toContain('lan.revoke')
    expect((await t.call(1, 'lan.status')).clients[0]).toMatchObject({ revoked: true, online: false })
  })

  it('stopping the Host makes calls fail with LAN_UNREACHABLE', async () => {
    const { t, fails } = await paired()
    await t.call(1, 'lan.setMode', { mode: 'standalone' })
    await fails('LAN_UNREACHABLE', 5, 'auth.me')
  })
})
