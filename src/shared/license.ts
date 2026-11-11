/**
 * License rules (D26, D28–D30). Pure functions shared by main (enforcement) and tests.
 * Times are epoch ms; "days" are whole 24-hour periods.
 */

import trialPackage from './trial-package.json'

export const DAY_MS = 86_400_000
export const TRIAL_DAYS = 30
export const WARN_DAYS = 30
export const GRACE_DAYS = 7

/** On/off features a license can grant (D51). Keep in sync with payloadSchema in license-file.ts. */
export const FEATURE_KEYS = ['cfd', 'kds', 'promotions', 'autoUpdate', 'labels', 'modifiers', 'drawerShift', 'inventory', 'cloudBackup'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export interface LicenseFeatures {
  /** active users per branch */
  maxEmployees: number
  /** Client devices (POS/KDS) that may connect to this Host; 0 = this machine cannot be a Host */
  maxClients: number
  /** members (customers) that may be registered; 0 = unlimited */
  maxMembers: number
  /** customer-facing display */
  cfd: boolean
  /** kitchen/bar display */
  kds: boolean
  /** promotions + coupons (manual discount and points stay available) */
  promotions: boolean
  autoUpdate: boolean
  /** A4 label printing */
  labels: boolean
  /** modifier groups / toppings */
  modifiers: boolean
  /** cash drawer + shift close; off = sell only */
  drawerShift: boolean
  /** ingredients, recipes, stock, purchasing; off = sell without stock */
  inventory: boolean
  cloudBackup: boolean
}

/** Everything on, unlimited members: what licenses issued before D51 (only the 3 old fields) are read as. */
export const LEGACY_FEATURES: Omit<LicenseFeatures, 'maxEmployees' | 'maxClients' | 'cloudBackup'> = {
  maxMembers: 0,
  cfd: true,
  kds: true,
  promotions: true,
  autoUpdate: true,
  labels: true,
  modifiers: true,
  drawerShift: true,
  inventory: true,
}

/** Fills missing fields (old licenses/registers/plans) with the legacy defaults. */
export function resolveFeatures(f: Partial<LicenseFeatures> & Pick<LicenseFeatures, 'maxEmployees' | 'maxClients' | 'cloudBackup'>): LicenseFeatures {
  return { ...LEGACY_FEATURES, ...f }
}

/**
 * What the trial (no valid license) allows (D28/D51): the package in trial-package.json, chosen in the License Manager
 * (pnpm license:trial, or "ใช้เป็นแพ็กเกจทดลอง"). A new choice reaches shops with the next app release.
 */
export const TRIAL_PACKAGE_NAME: string = trialPackage.name
export const TRIAL_FEATURES: LicenseFeatures = resolveFeatures(trialPackage.features)

/** Everything on — the default for services built without a license source (tests, tools). */
export const FULL_FEATURES: LicenseFeatures = resolveFeatures({ maxEmployees: 1000, maxClients: 100, cloudBackup: true })

/** How services read the current license features (D51). */
export type FeatureSource = () => LicenseFeatures

export const featureOn = (features: Pick<LicenseFeatures, FeatureKey>, key: FeatureKey): boolean => features[key]

/**
 * Channels that need a feature (D51). Checked by the router gate before the handler runs.
 * Shared channels (pos.checkout, pos.quote, shift.*, catalog.saveProduct, reports.*) are handled in services.
 */
const CHANNEL_FEATURE_PREFIX: ReadonlyArray<readonly [prefix: string, feature: FeatureKey]> = [
  ['kds.', 'kds'],
  ['promo.', 'promotions'],
  ['coupons.', 'promotions'],
  ['purchasing.', 'inventory'],
  ['counts.', 'inventory'],
  ['waste.', 'inventory'],
]
const CHANNEL_FEATURE_EXACT: Readonly<Record<string, FeatureKey>> = {
  'cfd.state': 'cfd',
  'shift.open': 'drawerShift',
  'shift.cashMove': 'drawerShift',
  'shift.close': 'drawerShift',
  'shift.printZ': 'drawerShift',
  'reports.zList': 'drawerShift',
  'reports.profit': 'inventory',
  'pos.showOnCfd': 'cfd',
  'catalog.saveGroup': 'modifiers',
  'catalog.deleteGroup': 'modifiers',
  'labels.print': 'labels',
  'update.check': 'autoUpdate',
  'update.install': 'autoUpdate',
  'cloud.save': 'cloudBackup',
  'cloud.test': 'cloudBackup',
  'cloud.syncNow': 'cloudBackup',
  'cloud.download': 'cloudBackup',
  'inventory.ingredients': 'inventory',
  'inventory.saveIngredient': 'inventory',
  'inventory.deleteIngredient': 'inventory',
  'inventory.lots': 'inventory',
  'inventory.addLot': 'inventory',
  'inventory.adjust': 'inventory',
}
export function featureForChannel(channel: string): FeatureKey | null {
  const exact = CHANNEL_FEATURE_EXACT[channel]
  if (exact) return exact
  return CHANNEL_FEATURE_PREFIX.find(([p]) => channel.startsWith(p))?.[1] ?? null
}

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
export function evaluateLicense(now: number, setupAt: number | null, license: LicensePayload | null, trialFeatures: LicenseFeatures = TRIAL_FEATURES): LicenseEvaluation {
  if (!license) {
    const trialEnd = (setupAt ?? now) + TRIAL_DAYS * DAY_MS
    if (now < trialEnd) return { state: 'trial', readOnly: false, features: trialFeatures, daysLeft: daysUntil(now, trialEnd), endsAt: trialEnd }
    return { state: 'trial_expired', readOnly: true, features: trialFeatures, daysLeft: 0, endsAt: trialEnd }
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
