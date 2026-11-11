import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLicenseServer, type LicenseServer } from '../../scripts/license-server'
import type { ManagerState } from '../../scripts/license-types'
import { T0 } from '../helpers/fixtures'
import { tmpDir } from '../helpers/tmp'

const HW = 'HW-AAAA-0000-0000-0001'
const servers: LicenseServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
})

async function start() {
  const dir = tmpDir('kposs-lms-')
  const pair = generateKeyPairSync('ed25519')
  const keyPath = join(dir, 'key.pem')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const srv = await createLicenseServer({ ui: false, keyPath, registerPath: join(dir, 'issued.jsonl'), trustedKeys: [pair.publicKey.export({ type: 'spki', format: 'pem' }) as string], now: () => T0 })
  servers.push(srv)
  const base = `http://127.0.0.1:${srv.port}`
  // first visit with the token swaps it for the cookie
  const first = await fetch(`${base}/?t=${srv.token}`, { redirect: 'manual' })
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!
  const call = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { srv, base, cookie, call, keyPath, dir, first }
}

describe('License Manager server', () => {
  it('only answers with the token cookie and a localhost Host header', async () => {
    const { srv, base, first, call } = await start()
    expect(first.status).toBe(302)
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/)
    expect((await fetch(`${base}/api/state`)).status).toBe(403) // no cookie
    expect((await fetch(`${base}/api/state?t=wrong`)).status).toBe(403)
    expect((await fetch(`${base}/api/state`, { headers: { cookie: 'kposs_license_manager=nope' } })).status).toBe(403)
    expect((await call('/api/state')).status).toBe(200)
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/)
    // a rebinding page sends its own Host header
    const { request } = await import('node:http')
    const status = await new Promise<number>((ok) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { host: 'evil.example:80', cookie: first.headers.get('set-cookie')!.split(';')[0]! } }, (res) => ok(res.statusCode ?? 0))
      r.end()
    })
    expect(status).toBe(403)
  })

  it('never reveals the private key; reports its fingerprint', async () => {
    const { call, keyPath } = await start()
    const state = (await (await call('/api/state')).json()) as ManagerState
    expect(state.key).toMatchObject({ found: true, trusted: true })
    expect(state.key.fingerprint).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/)
    const priv = readFileSync(keyPath, 'utf8').split('\n')[1]!
    expect(JSON.stringify(state)).not.toContain(priv.slice(0, 20))
    expect((await call('/api/file/..%2Fkey.pem')).status).toBe(404)
  })

  it('issue → customer → renew preview → download → inspect → void → CSV', async () => {
    const { call } = await start()
    const customer = (await (await call('/api/customers', { name: 'ร้านกาแฟ', phone: '081' })).json()) as { id: string }
    const issued = (await (await call('/api/issue', { hardwareId: HW, licensee: 'ร้านกาแฟ', plan: 'Plus', term: { kind: 'days', days: 40 }, maxEmployees: 20, maxClients: 2, cloudBackup: false, customerId: customer.id })).json()) as { payload: { licenseId: string }; content: string; fileName: string }
    expect(issued.fileName).toBe(`ร้านกาแฟ-${HW}.LIC`)

    const preview = (await (await call('/api/renew-preview', { licenseId: issued.payload.licenseId, days: 365, mode: 'from_expiry' })).json()) as { term: { kind: string }; expiresAt: number; previousExpiresAt: number }
    expect(preview.term.kind).toBe('until')
    expect(preview.expiresAt).toBeGreaterThanOrEqual(preview.previousExpiresAt + 365 * 86_400_000)

    const file = await call(`/api/file/${issued.payload.licenseId}`)
    expect(file.headers.get('content-disposition')).toContain('filename*=UTF-8')
    expect(await file.text()).toBe(issued.content)

    expect(await (await call('/api/inspect', { content: issued.content, hardwareId: HW })).json()).toMatchObject({ ok: true, status: 'active', daysLeft: 40 })
    expect(await (await call('/api/inspect', { content: issued.content, hardwareId: 'HW-FFFF-0000-0000-0009' })).json()).toMatchObject({ ok: false, problem: 'hardware' })

    const detail = (await (await call(`/api/customers/${customer.id}`)).json()) as { licenses: unknown[]; timeline: unknown[] }
    expect(detail.licenses).toHaveLength(1)
    expect(detail.timeline).toHaveLength(1)

    expect((await call('/api/status', { licenseId: issued.payload.licenseId, status: 'void', reason: 'x' })).status).toBe(400) // reason too short
    expect((await call('/api/status', { licenseId: issued.payload.licenseId, status: 'void', reason: 'เลิกกิจการ' })).status).toBe(200)
    const state = (await (await call('/api/state')).json()) as ManagerState
    expect(state.licenses[0]).toMatchObject({ status: 'void', customerName: 'ร้านกาแฟ' })

    const csv = await call('/api/export.csv')
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(await csv.text()).toContain('ยกเลิก')
  })

  it('bad input is a 400 with a message, not a crash', async () => {
    const { call } = await start()
    const r = await call('/api/issue', { hardwareId: 'nope', licensee: 'x', plan: 'p', term: { kind: 'perpetual' }, maxEmployees: 1, maxClients: 0, cloudBackup: false })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain('invalid Hardware ID')
    expect((await call('/api/unknown', {})).status).toBe(404)
  })

  it('packages carry every feature: save, issue with switches, inspect shows them, a bad value is a 400', async () => {
    const { call } = await start()
    const plans = (await (await call('/api/plans', { plans: [{ name: 'Mini', maxEmployees: 3, maxClients: 0, maxMembers: 50, cloudBackup: false, kds: false, inventory: false, cfd: true, promotions: true, autoUpdate: true, labels: true, modifiers: true, drawerShift: true }] })).json()) as { name: string; kds: boolean; maxMembers: number }[]
    expect(plans[0]).toMatchObject({ name: 'Mini', kds: false, maxMembers: 50 })
    const issued = (await (await call('/api/issue', { hardwareId: HW, licensee: 'ร้านเล็ก', plan: 'Mini', term: { kind: 'perpetual' }, maxEmployees: 3, maxClients: 0, maxMembers: 50, cloudBackup: false, kds: false, inventory: false })).json()) as { payload: { features: Record<string, unknown> }; content: string }
    expect(issued.payload.features).toMatchObject({ kds: false, inventory: false, cfd: true, maxMembers: 50, maxClients: 0 })
    const seen = (await (await call('/api/inspect', { content: issued.content })).json()) as { payload: { features: Record<string, unknown> } }
    expect(seen.payload.features).toMatchObject({ kds: false, inventory: false })
    const bad = await call('/api/issue', { hardwareId: HW, licensee: 'x', plan: 'p', term: { kind: 'perpetual' }, maxEmployees: 1, maxClients: 0, cloudBackup: false, maxMembers: -3 })
    expect(bad.status).toBe(400)
  })

  it('key generation needs the confirmation phrase and refuses to replace unless asked', async () => {
    const { call } = await start()
    expect((await call('/api/key/generate', { replace: true })).status).toBe(400)
    const noReplace = await call('/api/key/generate', { confirm: 'สร้างคีย์ใหม่' })
    expect(noReplace.status).toBe(400) // a key already exists
    expect(((await noReplace.json()) as { error: string }).error).toContain('already exists')
  })

  it('backup writes a copy next to the register', async () => {
    const { call } = await start()
    await call('/api/customers', { name: 'ร้านกาแฟ' })
    const b = (await (await call('/api/backup', {})).json()) as { dir: string; files: string[] }
    expect(b.files.length).toBeGreaterThanOrEqual(2)
  })
})
