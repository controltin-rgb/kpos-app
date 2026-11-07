/**
 * License rules (D26, D28–D30). Pure functions shared by main (enforcement) and tests.
 * Times are epoch ms; "days" are whole 24-hour periods.
 */

export const DAY_MS = 86_400_000
export const TRIAL_DAYS = 30
export const WARN_DAYS = 30
export const GRACE_DAYS = 7

export interface LicenseFeatures {
  /** active users per branch */
  maxEmployees: number
  /** Client devices (POS/KDS) that may connect to this Host */
  maxClients: number
  cloudBackup: boolean
}

/** What the trial (no valid license) allows — D28. */
export const TRIAL_FEATURES: LicenseFeatures = { maxEmployees: 10, maxClients: 0, cloudBackup: false }

/** Signed content of a .LIC file (D29). */
export interface LicensePayload {
  licenseId: string
  licensee: string
  plan: string
  hardwareId: string
  issuedAt: number
  /** null = perpetual */
  expiresAt: number | null
  features: LicenseFeatures
}

export type LicenseState =
  /** no valid license, within the 30-day trial */
  | 'trial'
  /** trial over — read-only */
  | 'trial_expired'
  | 'active'
  /** active, expires within WARN_DAYS */
  | 'expiring'
  /** expired, within GRACE_DAYS — still sells, with a warning */
  | 'grace'
  /** past the grace period — read-only */
  | 'expired'

export interface LicenseEvaluation {
  state: LicenseState
  readOnly: boolean
  features: LicenseFeatures
  /** days until the next limit (trial end / expiry / end of grace); null = perpetual */
  daysLeft: number | null
  /** when the current period ends (trial end / expiry / grace end); null = perpetual */
  endsAt: number | null
}

const daysUntil = (from: number, to: number) => Math.max(0, Math.ceil((to - from) / DAY_MS))

/**
 * Evaluates the license at `now` (already clock-rollback protected by the caller).
 * `license` must be a payload whose signature and hardware id were verified; pass null otherwise.
 * `setupAt` = when the shop was first set up (trial start); null before first-run setup.
 */
export function evaluateLicense(now: number, setupAt: number | null, license: LicensePayload | null): LicenseEvaluation {
  if (!license) {
    const trialEnd = (setupAt ?? now) + TRIAL_DAYS * DAY_MS
    if (now < trialEnd) return { state: 'trial', readOnly: false, features: TRIAL_FEATURES, daysLeft: daysUntil(now, trialEnd), endsAt: trialEnd }
    return { state: 'trial_expired', readOnly: true, features: TRIAL_FEATURES, daysLeft: 0, endsAt: trialEnd }
  }
  const { expiresAt, features } = license
  if (expiresAt === null) return { state: 'active', readOnly: false, features, daysLeft: null, endsAt: null }
  if (now < expiresAt) {
    const left = daysUntil(now, expiresAt)
    return { state: left <= WARN_DAYS ? 'expiring' : 'active', readOnly: false, features, daysLeft: left, endsAt: expiresAt }
  }
  const graceEnd = expiresAt + GRACE_DAYS * DAY_MS
  if (now < graceEnd) return { state: 'grace', readOnly: false, features, daysLeft: daysUntil(now, graceEnd), endsAt: graceEnd }
  return { state: 'expired', readOnly: true, features, daysLeft: 0, endsAt: graceEnd }
}

/**
 * Channels refused while read-only (D26, D32): anything that sells or creates a new business document.
 * Viewing, closing shifts, voids, backups, users/settings and installing a license stay available.
 */
export const READ_ONLY_BLOCKED_CHANNELS: ReadonlySet<string> = new Set([
  'pos.checkout',
  'shift.open',
  'orders.refund',
  'tax.issue',
  'purchasing.saveOrder',
  'purchasing.receive',
  'inventory.addLot',
  'waste.record',
  'counts.create',
  'expenses.create',
  'members.register',
])

/** Hardware id format shown to the shop and embedded in licenses: HW-XXXX-XXXX-XXXX-XXXX. */
export const HARDWARE_ID_RE = /^HW-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/
