/**
 * Types shared by the vendor license tools (scripts/license-*.ts) and the License Manager UI
 * (tools/license-manager). Pure types — no Node imports, so the browser build can use them.
 * Dev/vendor machine only: none of this is bundled into the shop app.
 */
import type { FeatureKey, LicenseFeatures, LicensePayload } from '../src/shared/license'

export type { FeatureKey, LicenseFeatures, LicensePayload }

export type Term = { kind: 'days'; days: number } | { kind: 'until'; date: string } | { kind: 'perpetual' }

export interface IssueInput {
  hardwareId: string
  licensee: string
  plan: string
  /** 'days' | 'until' (YYYY-MM-DD, end of that day Bangkok) | 'perpetual' */
  term: Term
  maxEmployees: number
  /** 0 = this machine cannot be a Host */
  maxClients: number
  cloudBackup: boolean
  /** D51 feature flags: all optional, absent = on (members: absent = unlimited) */
  maxMembers?: number
  cfd?: boolean
  kds?: boolean
  promotions?: boolean
  autoUpdate?: boolean
  labels?: boolean
  modifiers?: boolean
  drawerShift?: boolean
  inventory?: boolean
  note?: string
  /** link the new license to a customer in the register */
  customerId?: string
}

/** One line of issued-licenses.jsonl (format kept from the first version of the tool). */
export interface RegisterEntry {
  licenseId: string
  issuedAt: number
  hardwareId: string
  licensee: string
  plan: string
  expiresAt: number | null
  features: LicenseFeatures
  note: string
  file: string
}

export interface Customer {
  id: string
  name: string
  contact: string
  phone: string
  email: string
  taxId: string
  branch: string
  note: string
}

export type LicenseEvent =
  | { type: 'customer.upsert'; at: number; customer: Customer }
  | { type: 'license.assign'; at: number; licenseId: string; customerId: string }
  | { type: 'license.status'; at: number; licenseId: string; status: 'void' | 'superseded'; reason: string; supersededBy?: string }

/** Where a license stands, using the same rules as the app (D26): active → expiring (≤30 d) → grace (7 d) → expired. */
export type LicenseStatus = 'active' | 'expiring' | 'grace' | 'expired' | 'void' | 'superseded'

/** A register entry without the signed file, plus what the manager derives from it. */
export type LicenseRow = Omit<RegisterEntry, 'file'> & {
  customerId: string | null
  customerName: string | null
  status: LicenseStatus
  /** days to the next limit (expiry / end of grace); null = perpetual or void/superseded */
  daysLeft: number | null
  statusReason: string | null
  /** the newest license for its Hardware ID that is neither void nor superseded */
  current: boolean
}

export interface CustomerRow extends Customer {
  licenseCount: number
  /** status of the current license; null = no license yet */
  status: LicenseStatus | null
  expiresAt: number | null
  daysLeft: number | null
}

export interface TimelineItem {
  at: number
  kind: 'issued' | 'void' | 'superseded'
  licenseId: string
  text: string
}

/** A package preset: a name plus every feature (same keys as the signed payload's features). */
export interface Plan extends LicenseFeatures {
  name: string
}

export interface KeyInfo {
  path: string
  found: boolean
  /** the key on this machine matches a public key the app trusts */
  trusted: boolean
  error: string | null
  /** SHA-256 of the signing key's public half (grouped hex), null when no key */
  fingerprint: string | null
  /** every public key the app trusts */
  trustedKeys: { fingerprint: string; current: boolean }[]
}

export interface InspectResult {
  ok: boolean
  problem: string | null
  payload: LicensePayload | null
  status: LicenseStatus | null
  daysLeft: number | null
}

export interface ManagerState {
  key: KeyInfo
  paths: { key: string; register: string; events: string; plans: string }
  plans: Plan[]
  /** the package the app gives a shop without a license (src/shared/trial-package.json) */
  trialPackage: string
  customers: CustomerRow[]
  licenses: LicenseRow[]
}
