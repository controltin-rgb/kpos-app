import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateKey } from '../../scripts/license-key'
import {
  backupAll,
  customerRows,
  customerTimeline,
  expiringSoon,
  importCustomers,
  inspect,
  issue,
  IssueError,
  keyInfo,
  licenseRows,
  plansPathOf,
  readPlans,
  readRegister,
  registerCsv,
  renewTerm,
  saveCustomer,
  savePlans,
  readTrialPackage,
  setLicenseStatus,
  setTrialPackage,
  type StoreOpts,
} from '../../scripts/license-lib'
import { DAY_MS, resolveFeatures } from '../../src/shared/license'
import { T0 } from '../helpers/fixtures'
import { tmpDir } from '../helpers/tmp'

const HW1 = 'HW-AAAA-0000-0000-0001'
const HW2 = 'HW-BBBB-0000-0000-0002'

/** A throwaway signing key and an empty register in a temp folder (never ~/.kposs). */
function vendor(now = T0) {
  const dir = tmpDir('kposs-lm-')
  const pair = generateKeyPairSync('ed25519')
  const keyPath = join(dir, 'key.pem')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string
  const o: StoreOpts & { now: number } = { keyPath, registerPath: join(dir, 'register', 'issued.jsonl'), trustedKeys: [pub], now }
  const at = (ms: number): StoreOpts & { now: number } => ({ ...o, now: ms })
  const give = (hardwareId: string, extra: Partial<Parameters<typeof issue>[0]> = {}, ms = o.now) =>
    issue({ hardwareId, licensee: 'ร้านกาแฟ', plan: 'Standard', term: { kind: 'days', days: 365 }, maxEmployees: 10, maxClients: 0, cloudBackup: false, ...extra }, at(ms))
  return { dir, o, at, give, pub }
}

describe('License Manager — register, customers and status', () => {
  it('a new license for the same machine supersedes the old one; only the newest is current', () => {
    const v = vendor()
    const first = v.give(HW1)
    v.give(HW2)
    const second = v.give(HW1, { plan: 'Plus' }, T0 + DAY_MS)
    const rows = licenseRows(v.at(T0 + DAY_MS), T0 + DAY_MS)
    const byId = new Map(rows.map((r) => [r.licenseId, r]))
    expect(byId.get(first.payload.licenseId)).toMatchObject({ status: 'superseded', current: false, daysLeft: null })
    expect(byId.get(second.payload.licenseId)).toMatchObject({ status: 'active', current: true, plan: 'Plus' })
    expect(rows.filter((r) => r.current)).toHaveLength(2)
    expect(readRegister(v.o.registerPath).length).toBe(3) // the register itself is never rewritten
  })

  it('statuses follow the app rules: active → expiring (≤30 d) → grace (7 d) → expired; void wins', () => {
    const v = vendor()
    const { payload } = v.give(HW1, { term: { kind: 'days', days: 60 } })
    const at = (days: number) => licenseRows(v.o, T0 + days * DAY_MS)[0]!
    expect(at(10)).toMatchObject({ status: 'active', daysLeft: 50 })
    expect(at(40)).toMatchObject({ status: 'expiring', daysLeft: 20 })
    expect(at(63)).toMatchObject({ status: 'grace' })
    expect(at(70)).toMatchObject({ status: 'expired', daysLeft: 0 })
    setLicenseStatus(payload.licenseId, 'void', 'ลูกค้าเลิกใช้', v.o)
    expect(at(10)).toMatchObject({ status: 'void', statusReason: 'ลูกค้าเลิกใช้', current: false })
    expect(() => setLicenseStatus(payload.licenseId, 'void', 'ซ้ำ', v.o)).toThrow(IssueError)
    expect(() => setLicenseStatus('nope', 'void', 'ไม่มี', v.o)).toThrow('not found')
    expect(() => setLicenseStatus(payload.licenseId, 'void', 'x', v.o)).toThrow()
  })

  it('customers: create, update, link at issue time, import from the old register, timeline', () => {
    const v = vendor()
    const old = v.give(HW2, { licensee: 'ร้านเก่า' }) // issued before customers existed
    const c = saveCustomer({ name: 'ร้านกาแฟ', phone: '081-000-0000', contact: 'คุณก้อง' }, v.o)
    expect(() => saveCustomer({ name: '  ' }, v.o)).toThrow(IssueError)
    expect(() => v.give(HW1, { customerId: 'missing' })).toThrow('customer not found')
    const mine = v.give(HW1, { customerId: c.id })
    saveCustomer({ ...c, note: 'ต่ออายุทุกปี' }, v.o) // update, same id
    expect(customerRows(v.o, T0).find((x) => x.id === c.id)).toMatchObject({ note: 'ต่ออายุทุกปี', licenseCount: 1, status: 'active' })

    expect(importCustomers(v.o)).toEqual({ created: 1, assigned: 1 }) // only the old shop was unlinked
    expect(licenseRows(v.o, T0).find((r) => r.licenseId === old.payload.licenseId)).toMatchObject({ customerName: 'ร้านเก่า' })
    expect(importCustomers(v.o)).toEqual({ created: 0, assigned: 0 }) // idempotent

    v.give(HW1, { customerId: c.id, plan: 'Plus' }, T0 + DAY_MS)
    const kinds = customerTimeline(c.id, v.at(T0 + DAY_MS), T0 + DAY_MS).map((i) => i.kind)
    expect(kinds).toEqual(expect.arrayContaining(['issued', 'superseded']))
    expect(kinds.filter((k) => k === 'issued')).toHaveLength(2)
    expect(mine.payload.licenseId).toBeTruthy()
  })

  it('renewal: keeps the time left (from_expiry) or counts from today; expired and perpetual start today', () => {
    const exp = T0 + 20 * DAY_MS
    const early = renewTerm(exp, 365, 'from_expiry', T0)
    expect(early.kind).toBe('until')
    const v = vendor()
    const { payload } = v.give(HW1, { term: early })
    // ends at the end of the Bangkok day, 20 + 365 days after T0 (within one day of exp + 365 d)
    expect(payload.expiresAt! - (exp + 365 * DAY_MS)).toBeGreaterThanOrEqual(0)
    expect(payload.expiresAt! - (exp + 365 * DAY_MS)).toBeLessThan(DAY_MS)
    expect(renewTerm(exp, 365, 'from_now', T0)).toEqual({ kind: 'days', days: 365 })
    expect(renewTerm(T0 - DAY_MS, 30, 'from_expiry', T0)).toEqual({ kind: 'days', days: 30 })
    expect(renewTerm(null, 30, 'from_expiry', T0)).toEqual({ kind: 'days', days: 30 })
    expect(() => renewTerm(exp, 0, 'from_now', T0)).toThrow(IssueError)
  })

  it('expiring list: current licenses ending within N days (or already ended), soonest first; perpetual never', () => {
    const v = vendor()
    v.give(HW1, { term: { kind: 'days', days: 20 } })
    v.give(HW2, { term: { kind: 'days', days: 80 } })
    v.give('HW-CCCC-0000-0000-0003', { term: { kind: 'perpetual' } })
    expect(expiringSoon(30, v.o, T0).map((r) => r.hardwareId)).toEqual([HW1])
    expect(expiringSoon(90, v.o, T0).map((r) => r.hardwareId)).toEqual([HW1, HW2])
    expect(expiringSoon(30, v.o, T0 + 100 * DAY_MS).map((r) => r.hardwareId)).toEqual([HW1, HW2]) // both already ended
  })

  it('inspect checks the signature, an optional Hardware ID, and reports the status', () => {
    const v = vendor()
    const { content } = v.give(HW1, { term: { kind: 'days', days: 10 } })
    expect(inspect(content, undefined, T0, [v.pub])).toMatchObject({ ok: true, status: 'expiring', daysLeft: 10 })
    expect(inspect(content, HW2, T0, [v.pub])).toMatchObject({ ok: false, problem: 'hardware' })
    expect(inspect(content, undefined, T0, [generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string])).toMatchObject({ ok: false, problem: 'signature' })
    expect(inspect('not json')).toMatchObject({ ok: false, problem: 'format' })
  })

  it('plans: the four default packages, validated save, persisted next to the register', () => {
    const v = vendor()
    const defaults = readPlans(v.o)
    expect(defaults.map((p) => p.name)).toEqual(['Starter', 'Standard', 'Plus', 'System (ทดสอบระบบ)', 'ทดลองใช้ (30วัน)'])
    expect(defaults[0]).toMatchObject({ maxClients: 0, kds: false, inventory: false, drawerShift: false, cloudBackup: false })
    expect(defaults[3]).toMatchObject({ maxClients: 4, cloudBackup: true, kds: true, maxMembers: 0 })
    const mini = { name: 'Mini', ...resolveFeatures({ maxEmployees: 3, maxClients: 0, cloudBackup: false, kds: false, maxMembers: 50 }) }
    savePlans([mini], v.o)
    expect(readPlans(v.o)).toEqual([mini])
    expect(() => savePlans([], v.o)).toThrow(IssueError)
    expect(() => savePlans([{ ...mini, maxEmployees: 0 }], v.o)).toThrow(IssueError)
    expect(() => savePlans([{ ...mini, maxMembers: -1 }], v.o)).toThrow(IssueError)
    expect(() => savePlans([mini, { ...mini, cloudBackup: true }], v.o)).toThrow('unique')
  })

  it('a saved package can be made the app trial; an unknown name is refused', () => {
    const v = vendor()
    const file = join(v.dir, 'trial-package.json')
    savePlans([{ name: 'ทดลอง', ...resolveFeatures({ maxEmployees: 10, maxClients: 1, cloudBackup: false, kds: false }) }], v.o)
    expect(setTrialPackage('ทดลอง', v.o, file)).toMatchObject({ name: 'ทดลอง' })
    expect(readTrialPackage(file)).toMatchObject({ name: 'ทดลอง', features: { maxClients: 1, kds: false, cfd: true } })
    expect(() => setTrialPackage('ไม่มี', v.o, file)).toThrow(IssueError)
  })

  it('a plans file saved before D51 (three fields) reads with every new feature on', () => {
    const v = vendor()
    mkdirSync(join(v.dir, 'register'), { recursive: true })
    writeFileSync(plansPathOf(v.o), JSON.stringify([{ name: 'Old', maxEmployees: 7, maxClients: 1, cloudBackup: true }]))
    expect(readPlans(v.o)).toEqual([{ name: 'Old', ...resolveFeatures({ maxEmployees: 7, maxClients: 1, cloudBackup: true }) }])
    expect(readPlans(v.o)[0]).toMatchObject({ kds: true, inventory: true, maxMembers: 0 })
  })

  it('issue() signs the feature flags into the payload; omitted flags are on, members 0 = unlimited', () => {
    const v = vendor()
    const all = v.give(HW1)
    expect(all.payload.features).toMatchObject({ cfd: true, kds: true, promotions: true, autoUpdate: true, labels: true, modifiers: true, drawerShift: true, inventory: true, maxMembers: 0 })
    const some = v.give(HW2, { kds: false, inventory: false, drawerShift: false, maxMembers: 150 })
    expect(some.payload.features).toMatchObject({ kds: false, inventory: false, drawerShift: false, cfd: true, maxMembers: 150 })
    expect(inspect(some.content, undefined, T0, [v.pub]).payload?.features).toMatchObject({ kds: false, maxMembers: 150 })
    expect(() => v.give('HW-CCCC-0000-0000-0003', { maxMembers: -5 })).toThrow(IssueError)
  })

  it('CSV has a BOM, Thai headers and one row per license', () => {
    const v = vendor()
    v.give(HW1)
    const csv = registerCsv(v.o, T0)
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.trim().split('\r\n')).toHaveLength(2)
    expect(csv).toContain('ใช้งานอยู่')
  })
})

describe('License Manager — keys and backup', () => {
  it('fingerprints identify keys without exposing them; backup copies key, register, events and plans', () => {
    const v = vendor()
    v.give(HW1)
    saveCustomer({ name: 'ร้านกาแฟ' }, v.o)
    const info = keyInfo(v.o.keyPath, [v.pub])
    expect(info).toMatchObject({ found: true, trusted: true })
    expect(info.fingerprint).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/)
    expect(info.trustedKeys).toEqual([{ fingerprint: info.fingerprint, current: true }])
    expect(JSON.stringify(info)).not.toContain('PRIVATE')

    const b = backupAll(v.o)
    expect(b.files.map((f) => f.replace(/^.*[\\/]/, '')).sort()).toEqual(['issued.jsonl', 'key.pem', 'license-events.jsonl'])
    expect(readFileSync(join(b.dir, 'issued.jsonl'), 'utf8')).toBe(readFileSync(v.o.registerPath!, 'utf8'))
  })

  it('generateKey refuses the repo and an existing key; replace keeps a backup and the old public keys', () => {
    const dir = tmpDir('kposs-key-')
    const pubFile = join(dir, 'public-key.ts')
    const seed = 'export const LICENSE_PUBLIC_KEYS: readonly string[] = [\n  `OLD-KEY`,\n]\n'
    writeFileSync(pubFile, seed)
    const out = join(dir, 'k', 'key.pem')
    expect(() => generateKey({ out: join(process.cwd(), 'oops.pem') })).toThrow('inside the repository')

    const first = generateKey({ out, publicKeyFile: pubFile })
    expect(first.backup).toBeNull()
    expect(existsSync(out)).toBe(true)
    expect(() => generateKey({ out, publicKeyFile: pubFile })).toThrow('already exists')

    const second = generateKey({ out, replace: true, publicKeyFile: pubFile, now: 123 })
    expect(second.backup).toBe(`${out}.bak-123`)
    expect(existsSync(`${out}.bak-123`)).toBe(true)
    const keys = readFileSync(pubFile, 'utf8')
    expect(keys).toContain('OLD-KEY') // old public keys stay trusted
    expect(keys.match(/BEGIN PUBLIC KEY/g)).toHaveLength(2)
    expect(first.fingerprint).not.toBe(second.fingerprint)

    generateKey({ out, replace: true, dropOldPublicKeys: true, publicKeyFile: pubFile })
    expect(readFileSync(pubFile, 'utf8')).not.toContain('OLD-KEY')
    mkdirSync(join(dir, 'x'), { recursive: true })
  })
})
