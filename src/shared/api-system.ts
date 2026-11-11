import { z } from 'zod'
import type { Access, Endpoint } from './api'
import { aboutSchema, type AboutInfo } from './about'
import type { LicenseEvaluation } from './license'
import { MANUAL_SLUG_RE } from './manual'

/** Phase 4a IPC contract — Backup / Restore (Implement.md §6.10, D25) and the Audit Log page. */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Filter groups on the Audit page (docs/design/Audit.dc.html): action prefix → group. */
export const AUDIT_TYPES = ['bill', 'stock', 'auth', 'config'] as const
export type AuditType = (typeof AUDIT_TYPES)[number]

export const AUDIT_TYPE_PREFIXES: Record<AuditType, readonly string[]> = {
  bill: ['bill.', 'sale.', 'orders.', 'shift.', 'tax.', 'members.'],
  stock: ['inventory.', 'stock.', 'waste.', 'purchasing.', 'expenses.'],
  auth: ['auth.', 'users.', 'roles.'],
  config: ['settings.', 'backup.', 'license.', 'system.', 'catalog.', 'promo.', 'coupons.', 'reports.'],
}

export function auditTypeOf(action: string): AuditType | null {
  for (const t of AUDIT_TYPES) if (AUDIT_TYPE_PREFIXES[t].some((p) => action.startsWith(p))) return t
  return null
}

export type AuditRisk = 'low' | 'medium' | 'high'

export interface AuditEntryDto {
  id: string
  seq: number
  createdAt: number
  userId: string | null
  /** null = the system itself (scheduler, startup) */
  userName: string | null
  deviceName: string | null
  permission: string | null
  action: string
  entity: string | null
  entityId: string | null
  reason: string | null
  risk: AuditRisk
  before: unknown
  after: unknown
}

export interface AuditOverviewDto {
  today: number
  high7d: number
  activeUsersToday: number
  total: number
  /** users that appear in the log, for the filter; id null = system */
  users: { id: string | null; name: string }[]
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export const BACKUP_KINDS = ['snapshot', 'manual', 'pre_migrate', 'pre_restore', 'pre_update'] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/** D25: daily snapshots kept (selectable on the Backup page); 6 monthly snapshots are always kept on top. */
export const BACKUP_KEEP_DAILY = [14, 30, 90] as const
export const BACKUP_KEEP_MONTHLY = 6

/** D38: point-in-time restore window and how often the change journal is shipped to files. */
export const JOURNAL_KEEP_DAYS = 14
export const JOURNAL_SHIP_INTERVAL_MS = 10_000

/** Point-in-time restore (Tier B/C, D38). */
export interface PitrStatusDto {
  /** times that can be restored to, oldest first (one range per timeline) */
  ranges: { from: number; to: number }[]
  keepDays: number
  intervalSec: number
  /** captured changes not yet written to the journal files */
  pendingRows: number
  lastShippedAt: number | null
  offsite: 'off' | 'ok' | 'error'
  error: string | null
  /** size of the local journal folder */
  bytes: number
}

export interface PitrInspectDto extends RestoreInspectDto {
  /** the point asked for */
  pointInTime: number
  /** time of the last change actually included (≤ pointInTime) */
  appliedUntil: number
  /** changes replayed on top of the snapshot */
  changes: number
  baseStartedAt: number
  /** bills in the current data that the restored data does not have */
  lostBills: number
  lostSalesSatang: number
}

export interface BackupDto {
  id: string
  kind: BackupKind
  startedAt: number
  finishedAt: number | null
  sizeBytes: number | null
  ok: boolean
  /** integrity_check and audit chain inside the file both passed */
  verified: boolean
  error: string | null
  fileName: string
  schemaVersion: number | null
  auditSeq: number | null
  offsite: 'copied' | 'failed' | 'none'
  createdByName: string | null
  /** the file still exists (not pruned / not missing) */
  available: boolean
}

export interface BackupOverviewDto {
  last: BackupDto | null
  count: number
  totalBytes: number
  localDir: string
  dailyTime: string
  keepDaily: (typeof BACKUP_KEEP_DAILY)[number]
  keepMonthly: number
  offsiteEnabled: boolean
  offsiteDir: string
  /** off-site folder currently reachable (USB plugged in / NAS mounted) */
  offsiteReachable: boolean
  /** this build can open a native folder picker */
  canPickFolder: boolean
  /** the license includes cloud backup (D29) */
  cloudLicensed: boolean
  /** the cloud copy is switched on (D43) */
  cloudEnabled: boolean
  /** Client → Host / cloud outbox rows not sent yet (sync_queue) */
  outboxPending: number
  /** null = the change journal is not running on this machine */
  pitr: PitrStatusDto | null
}

export interface RestoreInspectDto {
  backupId: string
  /** verified copy written next to the app data, never over the live DB */
  path: string
  sizeBytes: number
  schemaVersion: number
  auditCount: number
  auditOk: boolean
  bills: number
  lastBillAt: number | null
  users: number
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const systemApi = {
  'audit.list': ep<{ items: AuditEntryDto[]; total: number }>()(
    'audit:view',
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(7),
      /** 'system' = rows without a user */
      userId: z.string().max(64).nullable().default(null),
      type: z.enum([...AUDIT_TYPES, 'all']).default('all'),
      risk: z.enum(['low', 'medium', 'high', 'all']).default('all'),
      q: z.string().trim().max(80).default(''),
    }),
  ),
  'audit.overview': ep<AuditOverviewDto>()('audit:view', z.undefined()),

  'backup.overview': ep<BackupOverviewDto>()('backup:view', z.undefined()),
  'backup.list': ep<BackupDto[]>()('backup:view', z.undefined()),
  'backup.run': ep<BackupDto>()('backup:create', z.undefined()),
  'backup.saveSchedule': ep<BackupOverviewDto>()(
    'settings:update',
    z.object({
      dailyTime: hhmm,
      keepDaily: z.union([z.literal(14), z.literal(30), z.literal(90)]),
      offsiteEnabled: z.boolean(),
      offsiteDir: z.string().trim().max(400),
    }),
  ),
  'backup.pickFolder': ep<string | null>()('settings:update', z.undefined()),
  /** Step 1 of a restore: verify the backup and write a separate copy to inspect. */
  'backup.restoreCopy': ep<RestoreInspectDto>()('backup:restore', z.object({ id, confirm: z.literal('RESTORE') })),
  /**
   * Replace the live DB with a backup. The current state is backed up first (always),
   * then the app restarts and swaps the file before opening it.
   */
  'backup.restoreReplace': ep<{ restarting: boolean }>()('backup:restore', z.object({ id, confirm: z.literal('RESTORE') })),
  /** Point-in-time step 1: snapshot + journal replay into a separate file, with what would be lost. */
  'backup.pitrCopy': ep<PitrInspectDto>()('backup:restore', z.object({ at: z.number().int().positive(), confirm: z.literal('RESTORE') })),
  /** Point-in-time step 2: rebuild the same point, back up the current state, swap at restart. */
  'backup.pitrReplace': ep<{ restarting: boolean }>()('backup:restore', z.object({ at: z.number().int().positive(), confirm: z.literal('RESTORE') })),
} as const

// ---------------------------------------------------------------------------
// License (Implement.md §6.11, D26, D28–D32)
// ---------------------------------------------------------------------------

export interface LicenseStatusDto extends LicenseEvaluation {
  /** this machine — the shop sends it to the seller to get a .LIC */
  hardwareId: string
  plan: string | null
  licensee: string | null
  licenseId: string | null
  issuedAt: number | null
  expiresAt: number | null
  installedAt: number | null
  installedByName: string | null
  /** trial start (first-run setup); null when licensed */
  trialStartedAt: number | null
  /** the installed file no longer verifies (other machine / bad signature) */
  problem: 'format' | 'signature' | 'hardware' | null
  /** the system clock is behind the newest audit entry */
  clockRollback: boolean
}

export const licenseApi = {
  'license.status': ep<LicenseStatusDto>()('authenticated', z.undefined()),
  /** content = the .LIC text; omitted → the main process opens a file dialog */
  'license.import': ep<LicenseStatusDto | null>()('license:manage', z.object({ content: z.string().max(16_000).optional() }).default({})),
} as const

// ---------------------------------------------------------------------------
// System menu: About / user manual / database reset
// ---------------------------------------------------------------------------

export interface AboutDto {
  info: AboutInfo
  /** false = the shipped default text */
  edited: boolean
  updatedAt: number | null
}

export interface ManualPageDto {
  slug: string
  title: string
  body: string
  sort: number
  /** shipped with the app (can be reset to the original text) */
  builtin: boolean
  /** the shop changed it (or added it) */
  edited: boolean
  hidden: boolean
  updatedAt: number | null
  updatedByName: string | null
}

export const aboutApi = {
  'system.about': ep<AboutDto>()('authenticated', z.undefined()),
  /** info null = back to the shipped text */
  'system.saveAbout': ep<AboutDto>()('system:update', z.object({ info: aboutSchema.nullable() })),

  /** includeHidden needs manual:update (checked in the handler) */
  'manual.list': ep<ManualPageDto[]>()('manual:view', z.object({ includeHidden: z.boolean().default(false) }).default({ includeHidden: false })),
  'manual.save': ep<ManualPageDto>()(
    'manual:update',
    z.object({
      slug: z.string().regex(MANUAL_SLUG_RE).nullable(),
      title: z.string().trim().min(1).max(120),
      body: z.string().max(100_000),
      sort: z.number().int().min(0).max(100_000).optional(),
      hidden: z.boolean().optional(),
    }),
  ),
  'manual.reset': ep<null>()('manual:update', z.object({ slug: z.string().regex(MANUAL_SLUG_RE) })),

  /** Super Admin only (checked in the service, with the password): wipe everything, keep the license, restart into first-run setup. */
  'system.resetDatabase': ep<{ restarting: boolean }>()('backup:restore', z.object({ confirm: z.literal('RESET'), password: z.string().min(1).max(128) })),
} as const

// ---------------------------------------------------------------------------
// Cloud backup (D43), auto-update (D42), PromptPay automatic check (D41)
// ---------------------------------------------------------------------------

export interface CloudStatusDto {
  configured: boolean
  lastSyncAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  uploadedFiles: number
  /** local files new or changed since the last upload */
  pendingFiles: number
  running: boolean
}

export interface CloudOverviewDto extends CloudStatusDto {
  /** the license includes cloud backup (D29) */
  licensed: boolean
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  /** secrets are never sent back to the screen — only whether they are set */
  hasSecretKey: boolean
  hasPassphrase: boolean
  intervalMin: number
}

/** how often the cloud mirror runs (plus right after every snapshot) */
export const CLOUD_SYNC_INTERVAL_MIN = 5

const secretInput = z.string().max(256).nullable().optional() // undefined = keep, null/'' = remove

export type UpdateState = 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatusDto {
  state: UpdateState
  configured: boolean
  feedUrl: string
  autoCheck: boolean
  currentVersion: string
  /** the newer version found */
  version: string | null
  releaseNotes: string | null
  /** 0–100 while downloading */
  percent: number | null
  checkedAt: number | null
  error: string | null
}

export const opsApi = {
  'cloud.overview': ep<CloudOverviewDto>()('backup:view', z.undefined()),
  'cloud.save': ep<CloudOverviewDto>()(
    'settings:update',
    z.object({
      enabled: z.boolean(),
      endpoint: z.string().trim().max(300),
      region: z.string().trim().max(40),
      bucket: z.string().trim().max(63),
      prefix: z.string().trim().max(120),
      accessKeyId: z.string().trim().max(128),
      secretAccessKey: secretInput,
      passphrase: z.string().min(8).max(256).nullable().optional(),
    }),
  ),
  /** checks the credentials by listing the bucket prefix */
  'cloud.test': ep<{ ok: true; objects: number }>()('settings:update', z.undefined()),
  'cloud.syncNow': ep<CloudOverviewDto>()('backup:create', z.undefined()),
  /** new machine: download + decrypt the cloud copy into the backup folder, then list it on the Backup page */
  'cloud.download': ep<{ files: number; backups: number }>()('backup:restore', z.object({ confirm: z.literal('DOWNLOAD') })),

  'update.status': ep<UpdateStatusDto>()('authenticated', z.undefined()),
  'update.check': ep<UpdateStatusDto>()('settings:update', z.undefined()),
  /** quits, installs the downloaded version and restarts */
  'update.install': ep<null>()('settings:update', z.undefined()),

  /** POS PromptPay screen polls this while waiting (only when promptpay.verify_mode = auto) */
  'pos.verifyPromptPay': ep<{ status: 'paid' | 'pending' | 'unavailable'; message: string | null }>()(
    'pos:create',
    z.object({ amountSatang: z.number().int().positive(), since: z.number().int().positive(), ref: z.string().max(64).optional() }),
  ),
  'payments.verifyInfo': ep<{ hasApiKey: boolean }>()('settings:view', z.undefined()),
  'payments.saveApiKey': ep<{ hasApiKey: boolean }>()('settings:update', z.object({ apiKey: secretInput })),
} as const
