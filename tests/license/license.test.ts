import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { formatHardwareId } from '@main/license/hardware-id'
import { parseLicense, signLicense } from '@main/license/license-file'
import { DAY_MS, evaluateLicense, resolveFeatures, TRIAL_FEATURES, type LicensePayload } from '@shared/license'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: publicKey.export({ type: 'spki', format: 'pem' }) as string }
}
const K = keys()
const OTHER = keys()
const HW = 'HW-1A2B-3C4D-5E6F-7A8B'

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  licenseId: 'lic-1',
  licensee: 'ร้านทดสอบ',
  plan: 'Standard',
  hardwareId: HW,
  issuedAt: T0,
  expiresAt: T0 + 365 * DAY_MS,
  features: resolveFeatures({ maxEmployees: 3, maxClients: 2, cloudBackup: true }),
  ...over,
})

async function app(startAt = T0) {
  const t = createTestApp({ hardwareId: HW, licensePublicKeys: [K.pub], startAt })
  await t.setup()
  return t
}

describe('evaluateLicense (D26, D28)', () => {
  const setup = T0
  it('trial: 30 days from setup, then read-only with no extra grace', () => {
    expect(evaluateLicense(setup, setup, null)).toMatchObject({ state: 'trial', readOnly: false, daysLeft: 30, features: TRIAL_FEATURES })
    expect(evaluateLicense(setup + 29 * DAY_MS + 1, setup, null)).toMatchObject({ state: 'trial', daysLeft: 1 })
    expect(evaluateLicense(setup + 30 * DAY_MS, setup, null)).toMatchObject({ state: 'trial_expired', readOnly: true })
  })

  it('license: warns 30 days ahead, 7 days of grace, then read-only', () => {
    const lic = payload()
    const exp = lic.expiresAt!
    expect(evaluateLicense(exp - 31 * DAY_MS, setup, lic)).toMatchObject({ state: 'active', readOnly: false })
    expect(evaluateLicense(exp - 30 * DAY_MS, setup, lic)).toMatchObject({ state: 'expiring', daysLeft: 30 })
    expect(evaluateLicense(exp, setup, lic)).toMatchObject({ state: 'grace', readOnly: false, daysLeft: 7 })
    expect(evaluateLicense(exp + 7 * DAY_MS - 1, setup, lic)).toMatchObject({ state: 'grace', daysLeft: 1 })
    expect(evaluateLicense(exp + 7 * DAY_MS, setup, lic)).toMatchObject({ state: 'expired', readOnly: true })
  })

  it('perpetual licenses never expire', () => {
    expect(evaluateLicense(T0 + 5000 * DAY_MS, setup, payload({ expiresAt: null }))).toMatchObject({ state: 'active', daysLeft: null, endsAt: null })
  })
})

describe('.LIC file', () => {
  it('verifies the Ed25519 signature and the hardware id', () => {
    const raw = signLicense(payload(), K.priv)
    expect(parseLicense(raw, [K.pub], HW)).toMatchObject({ ok: true, payload: { plan: 'Standard' } })
    expect(parseLicense(raw, [OTHER.pub], HW)).toEqual({ ok: false, problem: 'signature' })
    expect(parseLicense(raw, [OTHER.pub, K.pub], HW).ok).toBe(true) // key rotation
    expect(parseLicense(raw, [K.pub], 'HW-0000-0000-0000-0000')).toEqual({ ok: false, problem: 'hardware' })
    expect(parseLicense('not json', [K.pub], HW)).toEqual({ ok: false, problem: 'format' })
  })

  it('rejects a payload edited after signing', () => {
    const file = JSON.parse(signLicense(payload(), K.priv)) as { payload: string }
    const body = JSON.parse(Buffer.from(file.payload, 'base64url').toString()) as LicensePayload
    body.features.maxEmployees = 999
    const forged = JSON.stringify({ ...file, payload: Buffer.from(JSON.stringify(body)).toString('base64url') })
    expect(parseLicense(forged, [K.pub], HW)).toEqual({ ok: false, problem: 'signature' })
  })

  it('formats hardware ids as HW-XXXX-XXXX-XXXX-XXXX, stable per machine id', () => {
    const a = formatHardwareId('4c4c4544-0042-3510-8051-b4c04f4d3132')
    expect(a).toMatch(/^HW-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/)
    expect(formatHardwareId('4C4C4544-0042-3510-8051-B4C04F4D3132 ')).toBe(a)
    expect(formatHardwareId('other')).not.toBe(a)
  })
})

describe('license service', () => {
  it('starts in trial with the trial limits and shows the hardware id', async () => {
    const t = await app()
    const s = await t.call(1, 'license.status')
    expect(s).toMatchObject({ state: 'trial', readOnly: false, daysLeft: 30, hardwareId: HW, plan: null, trialStartedAt: T0 })
    expect((await t.call(1, 'settings.get'))['license.employee_cap']).toBe(10)
  })

  it('installs a license (license:manage only), audits it and applies its limits', async () => {
    const t = await app()
    await t.userOn(2, 'owner1', 'owner') // Owner has everything except license:manage (D6)
    const raw = signLicense(payload(), K.priv)
    await t.fails('FORBIDDEN', 2, 'license.import', { content: raw })

    const s = await t.call(1, 'license.import', { content: raw })
    expect(s).toMatchObject({ state: 'active', plan: 'Standard', licensee: 'ร้านทดสอบ', features: { maxEmployees: 3, maxClients: 2, cloudBackup: true }, installedByName: 'ผู้ดูแล' })
    expect(t.auditActions()).toContain('license.install')

    // employee cap now 3 per branch: admin + owner1 + one more
    await t.userOn(3, 'cashier1', 'cashier')
    await t.fails('EMPLOYEE_CAP_REACHED', 1, 'users.create', { username: 'cashier2', displayName: 'c2', roleId: await t.roleId('cashier'), password: 'cashier2-pass-1234', mustChangePassword: false })
  })

  it('refuses files for another machine, with a bad signature, or already dead', async () => {
    const t = await app()
    await t.fails('LICENSE_INVALID', 1, 'license.import', { content: signLicense(payload({ hardwareId: 'HW-0000-0000-0000-0001' }), K.priv) })
    await t.fails('LICENSE_INVALID', 1, 'license.import', { content: signLicense(payload(), OTHER.priv) })
    await t.fails('LICENSE_INVALID', 1, 'license.import', { content: signLicense(payload({ expiresAt: T0 - 8 * DAY_MS }), K.priv) })
    expect((await t.call(1, 'license.status')).state).toBe('trial')
  })

  it('replacing a license keeps the history', async () => {
    const t = await app()
    await t.call(1, 'license.import', { content: signLicense(payload(), K.priv) })
    await t.call(1, 'license.import', { content: signLicense(payload({ licenseId: 'lic-2', plan: 'Pro', expiresAt: null }), K.priv) })
    expect(await t.call(1, 'license.status')).toMatchObject({ plan: 'Pro', state: 'active', daysLeft: null })
    const rows = t.db.prepare('SELECT license_id, replaced_at IS NOT NULL AS replaced FROM licenses ORDER BY installed_at').all()
    expect(rows).toEqual([
      { license_id: 'lic-1', replaced: 1 },
      { license_id: 'lic-2', replaced: 0 },
    ])
  })

  it('a file issued before the installed one is refused (no going back to an old, bigger package); picking the installed file again is reported', async () => {
    const t = await app()
    const oldSystem = signLicense(payload({ licenseId: 'old-system', plan: 'System', issuedAt: T0 - 10 * DAY_MS, expiresAt: null }), K.priv)
    const newStandard = signLicense(payload({ licenseId: 'new-standard', plan: 'Standard', issuedAt: T0 - DAY_MS, expiresAt: null, features: resolveFeatures({ maxEmployees: 3, maxClients: 0, cloudBackup: false, kds: false }) }), K.priv)
    await t.call(1, 'license.import', { content: oldSystem })
    await t.call(1, 'license.import', { content: newStandard }) // downgrade: newer file, smaller package — allowed
    expect(await t.call(1, 'license.status')).toMatchObject({ plan: 'Standard', features: { kds: false } })
    await t.fails('LICENSE_OUTDATED', 1, 'license.import', { content: oldSystem })
    expect(await t.call(1, 'license.status')).toMatchObject({ plan: 'Standard' })
    await t.fails('LICENSE_ALREADY_INSTALLED', 1, 'license.import', { content: newStandard }) // picking the installed file again is reported
    const later = signLicense(payload({ licenseId: 'later-pro', plan: 'Pro', issuedAt: T0, expiresAt: null }), K.priv)
    await t.call(1, 'license.import', { content: later })
    expect(await t.call(1, 'license.status')).toMatchObject({ plan: 'Pro' })
  })

  it('a license row edited in the database does not verify (back to trial rules)', async () => {
    const t = await app()
    await t.call(1, 'license.import', { content: signLicense(payload(), K.priv) })
    t.db.prepare(`UPDATE licenses SET raw = replace(raw, '"signature": "', '"signature": "AA')`).run()
    t.app.license.invalidate()
    expect(await t.call(1, 'license.status')).toMatchObject({ state: 'trial', problem: 'signature' })
  })
})

describe('read-only mode (D26, D32)', () => {
  it('after the trial: no selling or new documents; viewing, closing shifts and installing a license still work', async () => {
    const t = await app()
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
    t.advance(30 * DAY_MS)
    t.app.license.invalidate()
    expect(await t.call(1, 'license.status')).toMatchObject({ state: 'trial_expired', readOnly: true })

    await t.fails('LICENSE_READ_ONLY', 1, 'pos.checkout', { requestId: '01a1b000-0000-7000-8000-000000000001', orderType: 'takeaway', items: [{ productId: 'x', qty: 1 }], payment: { method: 'cash', tenderedSatang: 0 } })
    await t.fails('LICENSE_READ_ONLY', 1, 'expenses.create', { categoryId: 'x', amountSatang: 100, source: 'drawer', description: 'x' })
    await t.call(1, 'users.list', {})
    await t.call(1, 'reports.sales', { from: T0, to: T0 + DAY_MS })
    const cur = await t.call(1, 'shift.current')
    await t.call(1, 'shift.close', { shiftId: cur!.id, counts: [] })
    await t.fails('LICENSE_READ_ONLY', 1, 'shift.open', { openingFloatSatang: 0 })
    expect(t.auditActions()).toContain('license.state_change')

    // a valid license lifts read-only immediately
    await t.call(1, 'license.import', { content: signLicense(payload({ expiresAt: t.now() + 365 * DAY_MS }), K.priv) })
    await t.call(1, 'shift.open', { openingFloatSatang: 0 })
  })

  it('winding the clock back does not reopen an expired trial', async () => {
    const t = await app()
    t.advance(31 * DAY_MS)
    await t.call(1, 'auth.login', { username: 'admin', password: 'admin-pass-1234' }) // day-31 activity lands in the audit log
    t.advance(-20 * DAY_MS) // the shop sets the PC clock back
    t.app.license.invalidate()
    expect(await t.call(1, 'license.status')).toMatchObject({ state: 'trial_expired', readOnly: true, clockRollback: true })
  })

  it('the dashboard shows the days left', async () => {
    const t = await app()
    t.advance(10 * DAY_MS)
    t.app.license.invalidate()
    expect((await t.call(1, 'dashboard.summary', { period: 'today' })).pending.licenseDaysLeft).toBe(20)
  })
})
