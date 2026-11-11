/**
 * Shared by the vendor-side license tools (pnpm license:issue, pnpm license:tool). Runs on the
 * vendor's machine only — never bundled into the app. The private key and the register of issued
 * licenses live OUTSIDE the repository (CLAUDE.md rule 8): ~/.kposs/ by default.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseLicense, signLicense } from '../src/main/license/license-file'
import { LICENSE_PUBLIC_KEYS } from '../src/main/license/public-key'
import { uuidv7 } from '../src/shared/id'
import { DAY_MS, evaluateLicense, FEATURE_KEYS, type FeatureKey, HARDWARE_ID_RE, type LicenseFeatures, type LicensePayload, resolveFeatures } from '../src/shared/license'
import type { Customer, CustomerRow, InspectResult, IssueInput, KeyInfo, LicenseEvent, LicenseRow, LicenseStatus, Plan, RegisterEntry, Term, TimelineItem } from './license-types'

export type { IssueInput, RegisterEntry } from './license-types'

export const REPO_ROOT = resolve(import.meta.dirname, '..')
export const defaultKeyPath = () => resolve(process.env['KPOSS_LICENSE_KEY'] ?? join(homedir(), '.kposs', 'license-signing-key.pem'))
export const defaultRegisterPath = () => resolve(process.env['KPOSS_LICENSE_REGISTER'] ?? join(homedir(), '.kposs', 'issued-licenses.jsonl'))

export class IssueError extends Error {}

export function loadPrivateKey(path = defaultKeyPath()): string {
  if (path.startsWith(REPO_ROOT)) throw new IssueError('the private key must not live inside the repository')
  if (!existsSync(path)) throw new IssueError(`private key not found: ${path} — run pnpm license:keygen first`)
  return readFileSync(path, 'utf8')
}

/** Does the key on this machine match a public key the app trusts? */
export function keyStatus(path = defaultKeyPath(), trustedKeys: readonly string[] = LICENSE_PUBLIC_KEYS): { path: string; found: boolean; trusted: boolean; error: string | null } {
  try {
    const pem = loadPrivateKey(path)
    const pub = (createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }) as string).trim()
    return { path, found: true, trusted: trustedKeys.some((k) => k.trim() === pub), error: null }
  } catch (err) {
    return { path, found: existsSync(path), trusted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function expiryOf(term: Term, now: number): number | null {
  if (term.kind === 'perpetual') return null
  if (term.kind === 'days') {
    if (!Number.isInteger(term.days) || term.days < 1 || term.days > 3650) throw new IssueError('days must be 1–3650')
    return now + term.days * DAY_MS
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term.date)
  if (!m) throw new IssueError('date must be YYYY-MM-DD')
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) - 7 * 3_600_000 // end of that day, Asia/Bangkok
  if (end <= now) throw new IssueError('the expiry date is in the past')
  return end
}

export function fileNameFor(licensee: string, hardwareId: string): string {
  // \p{M}: keep Thai vowel / tone marks (ร้าน, not ร_าน)
  return `${licensee.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_')}-${hardwareId}.LIC`
}

export interface StoreOpts {
  keyPath?: string
  registerPath?: string
  now?: number
  /** public keys the app trusts (default: the ones built into the app; tests pass a throwaway key) */
  trustedKeys?: readonly string[]
}
const registerOf = (o: StoreOpts) => o.registerPath ?? defaultRegisterPath()
const siblingOf = (o: StoreOpts, name: string) => join(dirname(registerOf(o)), name)
export const eventsPathOf = (o: StoreOpts = {}) => siblingOf(o, 'license-events.jsonl')
export const plansPathOf = (o: StoreOpts = {}) => siblingOf(o, 'license-plans.json')

/** Signs a license and appends it to the register. Returns the .LIC text and the payload. */
export function issue(input: IssueInput, opts: StoreOpts = {}): { content: string; payload: LicensePayload; fileName: string } {
  const now = opts.now ?? Date.now()
  const hardwareId = input.hardwareId.trim().toUpperCase()
  if (!HARDWARE_ID_RE.test(hardwareId)) throw new IssueError(`invalid Hardware ID ${hardwareId} (expected HW-XXXX-XXXX-XXXX-XXXX)`)
  if (!input.licensee.trim()) throw new IssueError('licensee is required')
  if (input.customerId && !listCustomers(opts).some((c) => c.id === input.customerId)) throw new IssueError('customer not found')
  const whole = (v: number, max: number, name: string) => {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new IssueError(`${name} must be a whole number 0–${max}`)
    return v
  }
  const payload: LicensePayload = {
    licenseId: uuidv7(now),
    licensee: input.licensee.trim(),
    plan: input.plan.trim() || 'Standard',
    hardwareId,
    issuedAt: now,
    expiresAt: expiryOf(input.term, now),
    features: resolveFeatures({
      maxEmployees: Math.max(1, whole(input.maxEmployees, 1000, 'employees')),
      maxClients: whole(input.maxClients, 100, 'clients'),
      cloudBackup: input.cloudBackup === true,
      maxMembers: whole(input.maxMembers ?? 0, 1_000_000, 'members'),
      ...flags(input),
    }),
  }
  const content = signLicense(payload, loadPrivateKey(opts.keyPath))
  // the signed file must verify with the keys built into the app (catches a key / build mismatch)
  const check = parseLicense(content, opts.trustedKeys ?? LICENSE_PUBLIC_KEYS, hardwareId)
  if (!check.ok) throw new IssueError(`the signing key does not match the app's public key (${check.problem}) — run pnpm license:keygen or update public-key.ts`)
  const fileName = fileNameFor(payload.licensee, hardwareId)
  const register = registerOf(opts)
  // older licenses of the same machine that are still in force are replaced by this one
  const older = licenseRows(opts, now).filter((r) => r.hardwareId === hardwareId && r.status !== 'void' && r.status !== 'superseded')
  mkdirSync(dirname(register), { recursive: true })
  const entry: RegisterEntry = { licenseId: payload.licenseId, issuedAt: now, hardwareId, licensee: payload.licensee, plan: payload.plan, expiresAt: payload.expiresAt, features: payload.features, note: (input.note ?? '').slice(0, 300), file: content }
  appendFileSync(register, JSON.stringify(entry) + '\n')
  if (input.customerId) appendEvent({ type: 'license.assign', at: now, licenseId: payload.licenseId, customerId: input.customerId }, opts)
  for (const r of older) appendEvent({ type: 'license.status', at: now, licenseId: r.licenseId, status: 'superseded', reason: '', supersededBy: payload.licenseId }, opts)
  return { content, payload, fileName }
}

/** Newest first; licenses issued in the same millisecond keep their file order (later line = newer). */
export function readRegister(path = defaultRegisterPath()): RegisterEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => {
      try {
        return [{ e: JSON.parse(l) as RegisterEntry, i }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.e.issuedAt - a.e.issuedAt || b.i - a.i)
    .map((x) => x.e)
}

/** Reads a .LIC (any machine) and reports what is inside and whether the app would trust it. */
export function inspect(content: string, hardwareId?: string, now = Date.now(), trustedKeys: readonly string[] = LICENSE_PUBLIC_KEYS): InspectResult {
  try {
    const file = JSON.parse(content) as { payload?: string }
    const payload = JSON.parse(Buffer.from(file.payload ?? '', 'base64url').toString('utf8')) as LicensePayload
    const r = parseLicense(content, trustedKeys, hardwareId?.trim() ? hardwareId.trim().toUpperCase() : payload.hardwareId)
    if (!r.ok) return { ok: false, problem: r.problem, payload, status: null, daysLeft: null }
    const ev = evaluateLicense(now, null, payload)
    return { ok: true, problem: null, payload, status: ev.state as LicenseStatus, daysLeft: ev.daysLeft }
  } catch {
    return { ok: false, problem: 'format', payload: null, status: null, daysLeft: null }
  }
}

// ---------------------------------------------------------------------------
// events: customers, links and manual status (append-only JSONL next to the register)
// ---------------------------------------------------------------------------

export function appendEvent(ev: LicenseEvent, opts: StoreOpts = {}): void {
  const path = eventsPathOf(opts)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(ev) + '\n')
}

export function readEvents(opts: StoreOpts = {}): LicenseEvent[] {
  const path = eventsPathOf(opts)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LicenseEvent]
      } catch {
        return []
      }
    })
}

export function listCustomers(opts: StoreOpts = {}): Customer[] {
  const map = new Map<string, Customer>()
  for (const e of readEvents(opts)) if (e.type === 'customer.upsert') map.set(e.customer.id, e.customer)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'th'))
}

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)

/** Creates a customer, or updates it when `id` exists. */
export function saveCustomer(input: Partial<Customer> & { name: string }, opts: StoreOpts = {}): Customer {
  const now = opts.now ?? Date.now()
  const name = clip(input.name, 160)
  if (!name) throw new IssueError('customer name is required')
  const customer: Customer = {
    id: input.id ? clip(input.id, 64) : uuidv7(now),
    name,
    contact: clip(input.contact, 120),
    phone: clip(input.phone, 40),
    email: clip(input.email, 120),
    taxId: clip(input.taxId, 20),
    branch: clip(input.branch, 120),
    note: clip(input.note, 500),
  }
  appendEvent({ type: 'customer.upsert', at: now, customer }, opts)
  return customer
}

/** Customers from the licensee names already in the register; links licenses that have no customer yet. */
export function importCustomers(opts: StoreOpts = {}): { created: number; assigned: number } {
  const now = opts.now ?? Date.now()
  const rows = licenseRows(opts, now)
  const byName = new Map(listCustomers(opts).map((c) => [c.name, c.id]))
  let created = 0
  let assigned = 0
  for (const r of [...rows].reverse()) {
    if (r.customerId) continue
    let id = byName.get(r.licensee)
    if (!id) {
      id = saveCustomer({ name: r.licensee }, { ...opts, now }).id
      byName.set(r.licensee, id)
      created++
    }
    appendEvent({ type: 'license.assign', at: now, licenseId: r.licenseId, customerId: id }, opts)
    assigned++
  }
  return { created, assigned }
}

/**
 * Marks a license void (cancelled in the register) or superseded. The signed .LIC itself keeps working on the
 * shop's machine until it expires: the app verifies licenses offline and has no revocation list.
 */
export function setLicenseStatus(licenseId: string, status: 'void' | 'superseded', reason: string, opts: StoreOpts = {}): void {
  const row = licenseRows(opts, opts.now ?? Date.now()).find((r) => r.licenseId === licenseId)
  if (!row) throw new IssueError('license not found')
  if (row.status === 'void' || row.status === 'superseded') throw new IssueError(`this license is already ${row.status}`)
  const why = clip(reason, 200)
  if (why.length < 3) throw new IssueError('a reason of at least 3 characters is required')
  appendEvent({ type: 'license.status', at: opts.now ?? Date.now(), licenseId, status, reason: why }, opts)
}

// ---------------------------------------------------------------------------
// derived views
// ---------------------------------------------------------------------------

const payloadOf = (e: Omit<RegisterEntry, 'file'>): LicensePayload => ({
  licenseId: e.licenseId,
  licensee: e.licensee,
  plan: e.plan,
  hardwareId: e.hardwareId,
  issuedAt: e.issuedAt,
  expiresAt: e.expiresAt,
  features: resolveFeatures(e.features),
})

/** Every issued license (newest first) with its customer, status (same rules as the app, D26) and whether it is the machine's current one. */
export function licenseRows(opts: StoreOpts = {}, now = Date.now()): LicenseRow[] {
  const customers = new Map(listCustomers(opts).map((c) => [c.id, c]))
  const assign = new Map<string, string>()
  const manual = new Map<string, { status: 'void' | 'superseded'; reason: string }>()
  for (const e of readEvents(opts)) {
    if (e.type === 'license.assign') assign.set(e.licenseId, e.customerId)
    else if (e.type === 'license.status') manual.set(e.licenseId, { status: e.status, reason: e.reason })
  }
  const seenMachine = new Set<string>()
  return readRegister(registerOf(opts)).map(({ file: _file, ...e }) => {
    const m = manual.get(e.licenseId)
    const ev = evaluateLicense(now, null, payloadOf(e))
    const status: LicenseStatus = m ? m.status : (ev.state as LicenseStatus)
    const inForce = !m
    const current = inForce && !seenMachine.has(e.hardwareId)
    if (current) seenMachine.add(e.hardwareId)
    const customerId = assign.get(e.licenseId) ?? null
    return {
      ...e,
      customerId,
      customerName: customerId ? (customers.get(customerId)?.name ?? null) : null,
      status,
      daysLeft: inForce ? ev.daysLeft : null,
      statusReason: m?.reason || null,
      current,
    }
  })
}

const expiryKey = (r: { expiresAt: number | null }) => r.expiresAt ?? Number.POSITIVE_INFINITY

export function customerRows(opts: StoreOpts = {}, now = Date.now()): CustomerRow[] {
  const rows = licenseRows(opts, now)
  return listCustomers(opts).map((c) => {
    const mine = rows.filter((r) => r.customerId === c.id)
    const next = mine.filter((r) => r.current).sort((a, b) => expiryKey(a) - expiryKey(b))[0] ?? null
    return { ...c, licenseCount: mine.length, status: next?.status ?? null, expiresAt: next?.expiresAt ?? null, daysLeft: next?.daysLeft ?? null }
  })
}

export function customerTimeline(customerId: string, opts: StoreOpts = {}, now = Date.now()): TimelineItem[] {
  const mine = licenseRows(opts, now).filter((r) => r.customerId === customerId)
  const ids = new Set(mine.map((r) => r.licenseId))
  const items: TimelineItem[] = mine.map((r) => ({ at: r.issuedAt, kind: 'issued', licenseId: r.licenseId, text: `${r.plan} · ${r.hardwareId}` }))
  for (const e of readEvents(opts)) {
    if (e.type === 'license.status' && ids.has(e.licenseId)) items.push({ at: e.at, kind: e.status, licenseId: e.licenseId, text: e.reason })
  }
  return items.sort((a, b) => b.at - a.at)
}

/** Machines whose current license ends within `days` (or already ended), soonest first. Perpetual licenses never appear. */
export function expiringSoon(days: number, opts: StoreOpts = {}, now = Date.now()): LicenseRow[] {
  return licenseRows(opts, now)
    .filter((r) => r.current && r.expiresAt !== null && r.expiresAt <= now + days * DAY_MS)
    .sort((a, b) => expiryKey(a) - expiryKey(b))
}

// ---------------------------------------------------------------------------
// renewal
// ---------------------------------------------------------------------------

const bangkokDate = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10)

/**
 * Term for renewing a license by `days`. 'from_expiry' keeps the time still left (an early renewal loses nothing);
 * 'from_now' counts from today. An already-expired or perpetual license renews from now.
 */
export function renewTerm(prevExpiresAt: number | null, days: number, mode: 'from_now' | 'from_expiry', now: number): Term {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new IssueError('days must be 1–3650')
  if (mode === 'from_now' || prevExpiresAt === null || prevExpiresAt <= now) return { kind: 'days', days }
  // an 'until' date means the end of that Bangkok day, so step back 1 ms to land exactly on prev + days
  return { kind: 'until', date: bangkokDate(prevExpiresAt + days * DAY_MS - 1) }
}

// ---------------------------------------------------------------------------
// plans (presets for the issue form)
// ---------------------------------------------------------------------------

const planOf = (name: string, f: Partial<LicenseFeatures> & Pick<LicenseFeatures, 'maxEmployees' | 'maxClients' | 'maxMembers'>): Plan => ({ name, ...resolveFeatures({ cloudBackup: false, ...f }) })

/** Starting packages (D51) — the vendor edits them in the Manager. */
export const DEFAULT_PLANS: Plan[] = [
  planOf('Starter', { maxEmployees: 3, maxClients: 0, maxMembers: 0, cfd: false, kds: false, promotions: false, autoUpdate: false, labels: false, drawerShift: false, inventory: false }),
  planOf('Standard', { maxEmployees: 5, maxClients: 2, maxMembers: 100, labels: false, inventory: false }),
  planOf('Plus', { maxEmployees: 15, maxClients: 4, maxMembers: 0, cloudBackup: true }),
  planOf('System (ทดสอบระบบ)', { maxEmployees: 15, maxClients: 4, maxMembers: 0, cloudBackup: true }),
  planOf('ทดลองใช้ (30วัน)', { maxEmployees: 10, maxClients: 0, maxMembers: 50, cfd: false, kds: false, autoUpdate: false }),
]

/** Reads the boolean feature flags off an input/plan, ignoring anything that is not a boolean. */
function flags(src: Partial<Record<FeatureKey, unknown>>): Partial<Record<FeatureKey, boolean>> {
  const out: Partial<Record<FeatureKey, boolean>> = {}
  for (const k of FEATURE_KEYS) if (k !== 'cloudBackup' && typeof src[k] === 'boolean') out[k] = src[k]
  return out
}

export function readPlans(opts: StoreOpts = {}): Plan[] {
  try {
    const v = JSON.parse(readFileSync(plansPathOf(opts), 'utf8')) as Array<Partial<Plan> & Pick<Plan, 'name' | 'maxEmployees' | 'maxClients' | 'cloudBackup'>>
    // plans saved before D51 have only the three old fields → the new features read as on
    return Array.isArray(v) && v.length ? v.map((p) => ({ name: p.name, ...resolveFeatures(p) })) : DEFAULT_PLANS
  } catch {
    return DEFAULT_PLANS
  }
}

export function savePlans(plans: Plan[], opts: StoreOpts = {}): Plan[] {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 20) throw new IssueError('1–20 plans are required')
  const clean = plans.map((p): Plan => {
    const name = clip(p.name, 60)
    if (!name) throw new IssueError('plan name is required')
    if (!Number.isInteger(p.maxEmployees) || p.maxEmployees < 1 || p.maxEmployees > 1000) throw new IssueError('employees must be 1–1000')
    if (!Number.isInteger(p.maxClients) || p.maxClients < 0 || p.maxClients > 100) throw new IssueError('clients must be 0–100')
    const maxMembers = p.maxMembers ?? 0
    if (!Number.isInteger(maxMembers) || maxMembers < 0 || maxMembers > 1_000_000) throw new IssueError('members must be 0–1,000,000')
    return { name, ...resolveFeatures({ maxEmployees: p.maxEmployees, maxClients: p.maxClients, cloudBackup: p.cloudBackup === true, maxMembers, ...flags(p) }) }
  })
  if (new Set(clean.map((p) => p.name)).size !== clean.length) throw new IssueError('plan names must be unique')
  mkdirSync(dirname(plansPathOf(opts)), { recursive: true })
  writeFileSync(plansPathOf(opts), JSON.stringify(clean, null, 2))
  return clean
}

// ---------------------------------------------------------------------------
// trial package (what a shop without a license gets for 30 days)
// ---------------------------------------------------------------------------

export const trialPackageFile = () => resolve(import.meta.dirname, '../src/shared/trial-package.json')

export function readTrialPackage(file = trialPackageFile()): { name: string; features: LicenseFeatures } {
  const v = JSON.parse(readFileSync(file, 'utf8')) as { name: string; features: LicenseFeatures }
  return { name: v.name, features: resolveFeatures(v.features) }
}

/** Makes a saved package the trial of the app. The file is committed with the app; shops get it with the next release. */
export function setTrialPackage(name: string, opts: StoreOpts = {}, file = trialPackageFile()): { name: string; features: LicenseFeatures } {
  const plan = readPlans(opts).find((p) => p.name === name)
  if (!plan) throw new IssueError('package not found')
  const { name: _n, ...features } = plan
  writeFileSync(file, JSON.stringify({ name: plan.name, features }, null, 2) + '\n')
  return { name: plan.name, features }
}

// ---------------------------------------------------------------------------
// keys and backup
// ---------------------------------------------------------------------------

/** SHA-256 of the public key (SPKI), 32 hex digits in groups of 4 — safe to show and compare. */
export function publicKeyFingerprint(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' })
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32).toUpperCase()
  return (hex.match(/.{4}/g) ?? []).join('-')
}

/** Key status for the UI: never includes the private key itself. */
export function keyInfo(path = defaultKeyPath(), trustedKeys: readonly string[] = LICENSE_PUBLIC_KEYS): KeyInfo {
  const st = keyStatus(path, trustedKeys)
  let fingerprint: string | null = null
  try {
    const pub = createPublicKey(createPrivateKey(loadPrivateKey(path))).export({ type: 'spki', format: 'pem' }) as string
    fingerprint = publicKeyFingerprint(pub)
  } catch {
    // no usable key
  }
  const trusted = trustedKeys.map((k) => {
    const fp = publicKeyFingerprint(k)
    return { fingerprint: fp, current: fp === fingerprint }
  })
  return { ...st, fingerprint, trustedKeys: trusted }
}

const stamp = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/** Copies the key, register, events and plans into <register folder>/backup/<timestamp>/ (still outside the repository). */
export function backupAll(opts: StoreOpts = {}): { dir: string; files: string[] } {
  const now = opts.now ?? Date.now()
  const dir = join(dirname(registerOf(opts)), 'backup', stamp(now))
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (const src of [opts.keyPath ?? defaultKeyPath(), registerOf(opts), eventsPathOf(opts), plansPathOf(opts)]) {
    if (!existsSync(src)) continue
    const to = join(dir, src.replace(/^.*[\\/]/, ''))
    copyFileSync(src, to)
    try {
      chmodSync(to, 0o600)
    } catch {
      // Windows: the user profile's NTFS permissions apply
    }
    files.push(to)
  }
  return { dir, files }
}

// ---------------------------------------------------------------------------
// CSV (UTF-8 with BOM so Excel shows Thai correctly)
// ---------------------------------------------------------------------------

const STATUS_TH: Record<LicenseStatus, string> = {
  active: 'ใช้งานอยู่',
  expiring: 'ใกล้หมดอายุ',
  grace: 'หมดอายุ (ช่วงผ่อนผัน)',
  expired: 'หมดอายุ',
  void: 'ยกเลิก',
  superseded: 'ถูกแทนที่',
}
const dateTh = (ms: number) => {
  const d = new Date(ms + 7 * 3_600_000)
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear() + 543}`
}

export function registerCsv(opts: StoreOpts = {}, now = Date.now()): string {
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  const rows: (string | number)[][] = [
    ['ลูกค้า', 'ชื่อในใบอนุญาต', 'Hardware ID', 'แพ็กเกจ', 'พนักงาน', 'เครื่องลูก (Host)', 'ลูกค้า (0=ไม่จำกัด)', 'ฟีเจอร์ที่เปิด', 'ออกเมื่อ', 'หมดอายุ', 'สถานะ', 'เหลือ (วัน)', 'หมายเหตุ'],
    ...licenseRows(opts, now).map((r) => [
      r.customerName ?? '',
      r.licensee,
      r.hardwareId,
      r.plan,
      r.features.maxEmployees,
      r.features.maxClients,
      resolveFeatures(r.features).maxMembers,
      FEATURE_KEYS.filter((k) => resolveFeatures(r.features)[k]).join(' '),
      dateTh(r.issuedAt),
      r.expiresAt === null ? 'ไม่หมดอายุ' : dateTh(r.expiresAt),
      STATUS_TH[r.status],
      r.daysLeft ?? '',
      r.note,
    ]),
  ]
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
