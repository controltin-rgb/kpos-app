import { z } from 'zod'
import type { Access, Endpoint } from './api'
import type { LicenseEvaluation } from './license'

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
  /** the license includes cloud backup (the uploader itself is not built yet) */
  cloudLicensed: boolean
  /** Client → Host / cloud outbox rows not sent yet (sync_queue) */
  outboxPending: number
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
