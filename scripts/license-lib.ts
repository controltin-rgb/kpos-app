/**
 * Shared by the vendor-side license tools (pnpm license:issue, pnpm license:tool). Runs on the
 * vendor's machine only — never bundled into the app. The private key and the register of issued
 * licenses live OUTSIDE the repository (CLAUDE.md rule 8): ~/.kposs/ by default.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseLicense, signLicense } from '../src/main/license/license-file'
import { LICENSE_PUBLIC_KEYS } from '../src/main/license/public-key'
import { uuidv7 } from '../src/shared/id'
import { DAY_MS, HARDWARE_ID_RE, type LicensePayload } from '../src/shared/license'

export const REPO_ROOT = resolve(import.meta.dirname, '..')
export const defaultKeyPath = () => resolve(process.env['KPOSS_LICENSE_KEY'] ?? join(homedir(), '.kposs', 'license-signing-key.pem'))
export const defaultRegisterPath = () => resolve(process.env['KPOSS_LICENSE_REGISTER'] ?? join(homedir(), '.kposs', 'issued-licenses.jsonl'))

export interface IssueInput {
  hardwareId: string
  licensee: string
  plan: string
  /** 'days' | 'until' (YYYY-MM-DD, end of that day Bangkok) | 'perpetual' */
  term: { kind: 'days'; days: number } | { kind: 'until'; date: string } | { kind: 'perpetual' }
  maxEmployees: number
  maxClients: number
  cloudBackup: boolean
  note?: string
}

export interface RegisterEntry {
  licenseId: string
  issuedAt: number
  hardwareId: string
  licensee: string
  plan: string
  expiresAt: number | null
  features: LicensePayload['features']
  note: string
  file: string
}

export class IssueError extends Error {}

export function loadPrivateKey(path = defaultKeyPath()): string {
  if (path.startsWith(REPO_ROOT)) throw new IssueError('the private key must not live inside the repository')
  if (!existsSync(path)) throw new IssueError(`private key not found: ${path} — run pnpm license:keygen first`)
  return readFileSync(path, 'utf8')
}

/** Does the key on this machine match a public key the app trusts? */
export function keyStatus(path = defaultKeyPath()): { path: string; found: boolean; trusted: boolean; error: string | null } {
  try {
    const pem = loadPrivateKey(path)
    const pub = (createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }) as string).trim()
    return { path, found: true, trusted: LICENSE_PUBLIC_KEYS.some((k) => k.trim() === pub), error: null }
  } catch (err) {
    return { path, found: existsSync(path), trusted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function expiryOf(term: IssueInput['term'], now: number): number | null {
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

/** Signs a license and appends it to the register. Returns the .LIC text and the payload. */
export function issue(input: IssueInput, opts: { keyPath?: string; registerPath?: string; now?: number } = {}): { content: string; payload: LicensePayload; fileName: string } {
  const now = opts.now ?? Date.now()
  const hardwareId = input.hardwareId.trim().toUpperCase()
  if (!HARDWARE_ID_RE.test(hardwareId)) throw new IssueError(`invalid Hardware ID ${hardwareId} (expected HW-XXXX-XXXX-XXXX-XXXX)`)
  if (!input.licensee.trim()) throw new IssueError('licensee is required')
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
    features: { maxEmployees: Math.max(1, whole(input.maxEmployees, 1000, 'employees')), maxClients: whole(input.maxClients, 100, 'clients'), cloudBackup: input.cloudBackup },
  }
  const content = signLicense(payload, loadPrivateKey(opts.keyPath))
  // the signed file must verify with the keys built into the app (catches a key / build mismatch)
  const check = parseLicense(content, LICENSE_PUBLIC_KEYS, hardwareId)
  if (!check.ok) throw new IssueError(`the signing key does not match the app's public key (${check.problem}) — run pnpm license:keygen or update public-key.ts`)
  const fileName = fileNameFor(payload.licensee, hardwareId)
  const register = opts.registerPath ?? defaultRegisterPath()
  mkdirSync(dirname(register), { recursive: true })
  const entry: RegisterEntry = { licenseId: payload.licenseId, issuedAt: now, hardwareId, licensee: payload.licensee, plan: payload.plan, expiresAt: payload.expiresAt, features: payload.features, note: (input.note ?? '').slice(0, 300), file: content }
  appendFileSync(register, JSON.stringify(entry) + '\n')
  return { content, payload, fileName }
}

export function readRegister(path = defaultRegisterPath()): RegisterEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RegisterEntry]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.issuedAt - a.issuedAt)
}

/** Reads a .LIC (any machine) and reports what is inside and whether the app would trust it. */
export function inspect(content: string): { ok: boolean; problem: string | null; payload: LicensePayload | null } {
  try {
    const file = JSON.parse(content) as { payload?: string }
    const payload = JSON.parse(Buffer.from(file.payload ?? '', 'base64url').toString('utf8')) as LicensePayload
    const r = parseLicense(content, LICENSE_PUBLIC_KEYS, payload.hardwareId)
    return { ok: r.ok, problem: r.ok ? null : r.problem, payload }
  } catch {
    return { ok: false, problem: 'format', payload: null }
  }
}
