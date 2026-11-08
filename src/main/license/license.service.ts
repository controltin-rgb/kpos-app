import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import type { AuditService } from '@main/services/audit.service'
import type { LicenseStatusDto } from '@shared/api-system'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { evaluateLicense, type LicensePayload } from '@shared/license'
import { parseLicense, type LicenseProblem } from './license-file'

const CACHE_MS = 60_000
/** clock may drift a little between writes; only a clearly backwards clock counts as rollback */
const ROLLBACK_TOLERANCE_MS = 5 * 60_000
const STATE_KEY = 'license.last_state'

interface LicenseRow {
  id: string
  license_id: string
  raw: string
  installed_at: number
  installed_by_name: string | null
}

export interface LicenseServiceOptions {
  /** this machine's Hardware ID (HW-XXXX-…) */
  hardwareId: string
  /** trusted Ed25519 public keys (SPKI PEM) */
  publicKeys: readonly string[]
  now?: () => number
  /** native "open .LIC" dialog; returns the file contents or null */
  pickFile?: () => Promise<string | null>
}

/**
 * License state and enforcement (Implement.md §6.11, D26, D28–D32). The .LIC is verified offline
 * against the embedded public key and this machine's Hardware ID on every evaluation, so editing
 * the `licenses` table cannot grant anything.
 */
export class LicenseService {
  private cache: { at: number; dto: LicenseStatusDto } | null = null
  private readonly now: () => number
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly opts: LicenseServiceOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.org = new OrgRepo(db)
  }

  get hardwareId(): string {
    return this.opts.hardwareId
  }

  /** Clock-rollback protection: never evaluate earlier than the newest audit entry. */
  private effectiveNow(): { at: number; rollback: boolean } {
    const now = this.now()
    const hwm = (this.db.prepare('SELECT max(created_at) FROM audit_log').pluck().get() as number | null) ?? 0
    return { at: Math.max(now, hwm), rollback: now < hwm - ROLLBACK_TOLERANCE_MS }
  }

  private currentRow(): LicenseRow | undefined {
    return this.db
      .prepare(
        `SELECT l.id, l.license_id, l.raw, l.installed_at, u.display_name AS installed_by_name
         FROM licenses l LEFT JOIN users u ON u.id = l.installed_by
         WHERE l.replaced_at IS NULL ORDER BY l.installed_at DESC LIMIT 1`,
      )
      .get() as LicenseRow | undefined
  }

  private verify(raw: string): { ok: true; payload: LicensePayload } | { ok: false; problem: LicenseProblem } {
    return parseLicense(raw, this.opts.publicKeys, this.opts.hardwareId)
  }

  status(): LicenseStatusDto {
    const now = this.now()
    if (this.cache && now - this.cache.at < CACHE_MS && now >= this.cache.at) return this.cache.dto
    const dto = this.compute()
    this.cache = { at: now, dto }
    this.recordTransition(dto)
    return dto
  }

  invalidate(): void {
    this.cache = null
  }

  private compute(): LicenseStatusDto {
    const { at, rollback } = this.effectiveNow()
    const companiesAt = this.db.prepare('SELECT min(created_at) FROM companies').pluck().get() as number | null
    // a database reset carries the original trial start over, so it never grants a new trial
    const carried = this.db.prepare(`SELECT value_json FROM settings WHERE key = 'license.trial_started_at' AND branch_id IS NULL`).pluck().get() as string | undefined
    const trialAt = carried ? (JSON.parse(carried) as number) : null
    const setupAt = companiesAt === null ? trialAt : trialAt === null ? companiesAt : Math.min(companiesAt, trialAt)
    const row = this.currentRow()
    const parsed = row ? this.verify(row.raw) : null
    const license = parsed?.ok ? parsed.payload : null
    const ev = evaluateLicense(at, setupAt, license)
    return {
      ...ev,
      hardwareId: this.opts.hardwareId,
      plan: license?.plan ?? null,
      licensee: license?.licensee ?? null,
      licenseId: license?.licenseId ?? null,
      issuedAt: license?.issuedAt ?? null,
      expiresAt: license?.expiresAt ?? null,
      installedAt: license && row ? row.installed_at : null,
      installedByName: license && row ? row.installed_by_name : null,
      trialStartedAt: license ? null : setupAt,
      problem: parsed && !parsed.ok ? parsed.problem : null,
      clockRollback: rollback,
    }
  }

  /** Audits state changes (e.g. trial → trial_expired) once, as the system. */
  private recordTransition(dto: LicenseStatusDto): void {
    const branch = this.org.firstBranch()
    if (!branch) return // before first-run setup there is nothing to log against
    const prev = this.org.getSetting<string>(STATE_KEY, null)
    const key = `${dto.state}${dto.problem ? `:${dto.problem}` : ''}`
    if (prev === key) return
    const at = this.now()
    this.db
      .transaction(() => {
        this.org.setSetting({ id: uuidv7(at), key: STATE_KEY, branchId: null, value: key, userId: null, now: at })
        this.audit.append({
          action: 'license.state_change',
          permission: 'license:manage',
          branchId: branch.id,
          entity: 'license',
          entityId: dto.licenseId,
          before: prev === undefined ? null : { state: prev },
          after: { state: key, readOnly: dto.readOnly, daysLeft: dto.daysLeft },
          risk: dto.readOnly || dto.problem ? 'high' : 'medium',
        })
      })
      .immediate()
  }

  isReadOnly(): boolean {
    return this.status().readOnly
  }

  employeeCap(): number {
    return this.status().features.maxEmployees
  }

  async pickFile(): Promise<string | null> {
    return this.opts.pickFile ? this.opts.pickFile() : null
  }

  /** Installs a .LIC (license:manage). Rejects bad signatures, other machines' files and dead licenses. */
  install(actor: Actor, raw: string): LicenseStatusDto {
    const parsed = this.verify(raw)
    if (!parsed.ok) throw new AppError('LICENSE_INVALID', { reason: parsed.problem })
    const p = parsed.payload
    const { at } = this.effectiveNow()
    if (evaluateLicense(at, null, p).state === 'expired') throw new AppError('LICENSE_INVALID', { reason: 'expired' })

    const before = this.status()
    const now = this.now()
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE licenses SET replaced_at = ? WHERE replaced_at IS NULL').run(now)
        this.db
          .prepare(
            `INSERT INTO licenses (id, license_id, raw, hardware_id, issued_at, expires_at, features_json, installed_at, installed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(now), p.licenseId, raw, p.hardwareId, p.issuedAt, p.expiresAt, JSON.stringify(p.features), now, actor.userId)
        this.audit.append({
          action: 'license.install',
          permission: 'license:manage',
          userId: actor.userId,
          branchId: actor.branchId,
          entity: 'license',
          entityId: p.licenseId,
          before: { state: before.state, plan: before.plan, expiresAt: before.expiresAt, maxEmployees: before.features.maxEmployees },
          after: { plan: p.plan, licensee: p.licensee, expiresAt: p.expiresAt, ...p.features },
          risk: 'high',
        })
      })
      .immediate()
    this.invalidate()
    return this.status()
  }
}
