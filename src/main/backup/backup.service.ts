import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { remoteScope } from '@main/request-scope'
import { AuditService, type VerifyResult } from '@main/services/audit.service'
import type { SettingsService } from '@main/services/settings.service'
import { BACKUP_KEEP_MONTHLY, JOURNAL_KEEP_DAYS, JOURNAL_SHIP_INTERVAL_MS, type BackupDto, type BackupKind, type BackupOverviewDto, type PitrInspectDto, type PitrStatusDto, type RestoreInspectDto } from '@shared/api-system'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { journalPosition, type JournalService } from './journal'
import { fileStamp, lastScheduledAt, selectForPrune } from './retention'

export interface BackupPaths {
  /** live database file (userData/data/kposs.sqlite) */
  dbPath: string
  /** local backup folder (userData/backup) — also used by the pre-migrate backup */
  backupDir: string
}

interface BackupRow {
  id: string
  kind: BackupKind
  path: string
  size_bytes: number | null
  ok: 0 | 1
  error: string | null
  created_by: string | null
  started_at: number
  finished_at: number | null
  sha256: string | null
  schema_version: number | null
  audit_seq: number | null
  audit_hash: string | null
  verified_at: number | null
  offsite_path: string | null
  offsite_error: string | null
  deleted_at: number | null
  journal_timeline: string | null
  journal_seq: number | null
  created_by_name?: string | null
}

/** Sidecar `<backup>.json` written next to every backup file so a folder can be re-indexed after a restore. */
interface Manifest {
  id: string
  kind: BackupKind
  startedAt: number
  finishedAt: number
  sha256: string
  sizeBytes: number
  schemaVersion: number
  audit: { seq: number; hash: string } | null
  verified: boolean
  createdBy: string | null
  /** change-journal position inside the file (D38) */
  journal?: { timeline: string; seq: number } | null
}

/** Written by stageReplace, consumed by applyPendingRestore at the next start. */
export interface PendingRestore {
  backupId: string
  backupFile: string
  backupStartedAt: number
  sha256: string
  requestedBy: string
  requestedByName: string
  requestedAt: number
  preRestoreBackupId: string
  preRestoreFile: string
  /** point-in-time restore: the time restored to (backupFile is then the base snapshot) */
  pointInTime?: number
  appliedUntil?: number
}

export type PendingRestoreResult =
  | { status: 'applied'; pending: PendingRestore; replacedPath: string | null }
  | { status: 'failed'; pending: PendingRestore | null; error: string }

export interface FileInspection {
  integrityOk: boolean
  schemaVersion: number
  audit: VerifyResult
  head: { seq: number; hash: string } | null
  bills: number
  lastBillAt: number | null
  users: number
  journal: { timeline: string; seq: number } | null
}

// ---------------------------------------------------------------------------
// File helpers (sync: used at startup before the DB is opened, and on small sidecars)
// ---------------------------------------------------------------------------

export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Opens a backup read-only and checks it: integrity_check, schema version, audit hash chain, a few counts. */
export function inspectFile(path: string): FileInspection {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const integrityOk = db.pragma('integrity_check', { simple: true }) === 'ok'
    const schemaVersion = db.pragma('user_version', { simple: true }) as number
    const audit = new AuditService(db)
    const count = (sql: string) => {
      try {
        return (db.prepare(sql).pluck().get() as number | null) ?? null
      } catch {
        return null
      }
    }
    return {
      integrityOk,
      schemaVersion,
      audit: audit.verifyChain(),
      head: audit.head(),
      bills: count('SELECT count(*) FROM bills') ?? 0,
      lastBillAt: count('SELECT max(created_at) FROM bills'),
      users: count('SELECT count(*) FROM users WHERE deleted_at IS NULL') ?? 0,
      journal: journalPosition(db),
    }
  } finally {
    db.close()
  }
}

const pendingPaths = (dbPath: string) => ({
  file: join(dirname(dbPath), 'restore-pending.sqlite'),
  manifest: join(dirname(dbPath), 'restore-pending.json'),
})

const rmQuiet = (p: string) => {
  try {
    rmSync(p, { force: true })
  } catch {
    // best effort (file may be locked by an antivirus scan on Windows)
  }
}

/**
 * Runs at startup BEFORE the database is opened: if a restore was staged, swap the live file for it.
 * The replaced file is kept as `replaced-<time>.sqlite` (it was also backed up as pre_restore).
 */
export function applyPendingRestore(dbPath: string, now: number = Date.now()): PendingRestoreResult | null {
  const p = pendingPaths(dbPath)
  if (!existsSync(p.manifest)) {
    if (existsSync(p.file)) rmQuiet(p.file) // stray file from an interrupted staging
    return null
  }
  let pending: PendingRestore | null = null
  try {
    pending = JSON.parse(readFileSync(p.manifest, 'utf8')) as PendingRestore
    if (!existsSync(p.file)) throw new Error('staged file missing')
    if (sha256File(p.file) !== pending.sha256) throw new Error('staged file checksum mismatch')

    let replacedPath: string | null = null
    if (existsSync(dbPath)) {
      replacedPath = join(dirname(dbPath), `replaced-${fileStamp(now)}.sqlite`)
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, replacedPath + suffix)
    }
    renameSync(p.file, dbPath)
    rmQuiet(p.manifest)
    return { status: 'applied', pending, replacedPath }
  } catch (err) {
    if (existsSync(p.file)) {
      try {
        renameSync(p.file, join(dirname(dbPath), `restore-failed-${fileStamp(now)}.sqlite`))
      } catch {
        rmQuiet(p.file)
      }
    }
    rmQuiet(p.manifest)
    return { status: 'failed', pending, error: String(err instanceof Error ? err.message : err) }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BackupServiceOptions {
  paths: BackupPaths | null
  now?: () => number
  /** native folder picker (Electron); absent in tests */
  pickFolder?: () => Promise<string | null>
  /** the license allows cloud backup (D29) */
  cloudLicensed?: () => boolean
  /** change journal for point-in-time restore (D38); absent = Tier A only */
  journal?: JournalService | null
}

/**
 * Tier A backup (Implement.md §6.10): verified daily snapshots via the SQLite online backup API,
 * D25 retention, optional off-site copy, restore-as-copy and staged replace.
 * Only the Host/Standalone machine (which owns the DB file) can back up.
 */
export class BackupService {
  private busy = false
  private readonly now: () => number
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly opts: BackupServiceOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.org = new OrgRepo(db)
  }

  get available(): boolean {
    return this.opts.paths !== null
  }

  private paths(): BackupPaths {
    if (!this.opts.paths) throw new AppError('BACKUP_UNAVAILABLE')
    return this.opts.paths
  }

  private rows(): BackupRow[] {
    return this.db
      .prepare(
        `SELECT r.*, u.display_name AS created_by_name FROM backup_runs r LEFT JOIN users u ON u.id = r.created_by
         WHERE r.deleted_at IS NULL ORDER BY r.started_at DESC LIMIT 200`,
      )
      .all() as BackupRow[]
  }

  private toDto(r: BackupRow): BackupDto {
    return {
      id: r.id,
      kind: r.kind,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      sizeBytes: r.size_bytes,
      ok: r.ok === 1,
      verified: r.verified_at !== null,
      error: r.error,
      fileName: basename(r.path),
      schemaVersion: r.schema_version,
      auditSeq: r.audit_seq,
      offsite: r.offsite_path ? 'copied' : r.offsite_error ? 'failed' : 'none',
      createdByName: r.created_by_name ?? null,
      available: r.ok === 1 && existsSync(r.path),
    }
  }

  list(): BackupDto[] {
    return this.rows().map((r) => this.toDto(r))
  }

  overview(): BackupOverviewDto {
    const rows = this.rows()
    const okRows = rows.filter((r) => r.ok === 1)
    const offsiteDir = this.settings.get('backup.offsite_dir')
    return {
      last: rows[0] ? this.toDto(rows[0]) : null,
      count: okRows.length,
      totalBytes: okRows.reduce((s, r) => s + (r.size_bytes ?? 0), 0),
      localDir: this.opts.paths?.backupDir ?? '',
      dailyTime: this.settings.get('backup.daily_time'),
      keepDaily: this.settings.get('backup.keep_daily'),
      keepMonthly: BACKUP_KEEP_MONTHLY,
      offsiteEnabled: this.settings.get('backup.offsite_enabled'),
      offsiteDir,
      offsiteReachable: offsiteDir !== '' && isWritableDir(offsiteDir),
      canPickFolder: !!this.opts.pickFolder && !remoteScope(),
      cloudLicensed: this.opts.cloudLicensed?.() ?? false,
      cloudEnabled: this.settings.get('cloud.enabled'),
      outboxPending: this.db.prepare('SELECT count(*) FROM sync_queue WHERE sent_at IS NULL').pluck().get() as number,
      pitr: this.pitrStatus(),
    }
  }

  async pickFolder(): Promise<string | null> {
    return this.opts.pickFolder ? this.opts.pickFolder() : null
  }

  /** Saves schedule / retention / off-site folder (audited through SettingsService, rule 4). */
  saveSchedule(actor: Actor, input: { dailyTime: string; keepDaily: 14 | 30 | 90; offsiteEnabled: boolean; offsiteDir: string }): BackupOverviewDto {
    const dir = input.offsiteDir.trim()
    if (input.offsiteEnabled) {
      if (!dir || !isAbsolute(dir)) throw new AppError('INVALID_INPUT', { invalid: ['offsiteDir'] })
      if (!isWritableDir(dir)) throw new AppError('OFFSITE_UNREACHABLE')
      const local = this.opts.paths?.backupDir
      if (local && samePath(dir, local)) throw new AppError('INVALID_INPUT', { invalid: ['offsiteDir'] })
    }
    this.settings.update(actor, {
      'backup.daily_time': input.dailyTime,
      'backup.keep_daily': input.keepDaily,
      'backup.offsite_enabled': input.offsiteEnabled,
      'backup.offsite_dir': dir,
    })
    return this.overview()
  }

  /** A scheduled snapshot is due when none started since the last scheduled moment (D25). */
  isDue(at: number = this.now()): boolean {
    const last = this.db.prepare(`SELECT max(started_at) FROM backup_runs WHERE kind = 'snapshot' AND ok = 1`).pluck().get() as number | null
    return (last ?? 0) < lastScheduledAt(at, this.settings.get('backup.daily_time'))
  }

  /** Scheduler tick (every minute from the Electron entry). Never throws. */
  async runDueSnapshot(): Promise<BackupDto | null> {
    if (!this.available || this.busy || !this.org.firstBranch() || !this.isDue()) return null
    try {
      return await this.run('snapshot', null)
    } catch {
      return null // already recorded in backup_runs + audit_log
    }
  }

  /**
   * Takes a backup with the SQLite online backup API (does not block sales), then re-opens the copy
   * read-only to verify it. Recorded in backup_runs and audit_log either way.
   */
  async run(kind: BackupKind, actor: Actor | null): Promise<BackupDto> {
    const { backupDir } = this.paths()
    if (this.busy) throw new AppError('BACKUP_BUSY')
    this.busy = true
    const startedAt = this.now()
    const id = uuidv7(startedAt)
    const file = join(backupDir, `kposs-${kind}-${fileStamp(startedAt)}-${id.slice(-6)}.sqlite`)
    try {
      mkdirSync(backupDir, { recursive: true })
      await this.db.backup(file)
      toRollbackJournal(file)
      return this.record(id, kind, file, startedAt, actor)
    } catch (err) {
      if (err instanceof AppError) throw err
      rmQuiet(file)
      this.db
        .transaction(() => {
          this.db
            .prepare(`INSERT INTO backup_runs (id, kind, path, ok, error, created_by, started_at, finished_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`)
            .run(id, kind, file, String(err instanceof Error ? err.message : err).slice(0, 500), actor?.userId ?? null, startedAt, this.now())
          this.audit.append({ action: 'backup.failed', permission: 'backup:create', userId: actor?.userId ?? null, branchId: this.branchId(actor), entity: 'backup', entityId: id, after: { kind, error: String(err).slice(0, 200) }, risk: 'medium' })
        })
        .immediate()
      throw new AppError('BACKUP_FAILED')
    } finally {
      this.busy = false
    }
  }

  /** Records a backup file created outside run() (the pre-migrate copy made at startup). */
  registerExisting(path: string, kind: BackupKind): BackupDto | null {
    if (!existsSync(path)) return null
    const known = this.db.prepare('SELECT id FROM backup_runs WHERE path = ?').pluck().get(path) as string | undefined
    if (known) return null
    toRollbackJournal(path)
    const at = statSync(path).mtimeMs
    return this.record(uuidv7(Math.floor(at)), kind, path, Math.floor(at), null)
  }

  private record(id: string, kind: BackupKind, file: string, startedAt: number, actor: Actor | null): BackupDto {
    const sizeBytes = statSync(file).size
    const sha256 = sha256File(file)
    const info = inspectFile(file)
    const verified = info.integrityOk && info.audit.ok
    const finishedAt = this.now()
    const manifest: Manifest = { id, kind, startedAt, finishedAt, sha256, sizeBytes, schemaVersion: info.schemaVersion, audit: info.head, verified, createdBy: actor?.userId ?? null, journal: info.journal }
    writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2))

    const offsite = this.copyOffsite(file)
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO backup_runs (id, kind, path, size_bytes, ok, error, created_by, started_at, finished_at, sha256, schema_version,
               audit_seq, audit_hash, verified_at, offsite_path, offsite_error, journal_timeline, journal_seq)
             VALUES (@id, @kind, @path, @size, @ok, @error, @by, @startedAt, @finishedAt, @sha256, @schema, @seq, @hash, @verifiedAt, @offsitePath, @offsiteError, @jt, @js)`,
          )
          .run({
            id,
            kind,
            path: file,
            size: sizeBytes,
            ok: verified ? 1 : 0,
            error: verified ? null : info.integrityOk ? 'audit chain broken' : 'integrity_check failed',
            by: actor?.userId ?? null,
            startedAt,
            finishedAt,
            sha256,
            schema: info.schemaVersion,
            seq: info.head?.seq ?? null,
            hash: info.head?.hash ?? null,
            verifiedAt: verified ? finishedAt : null,
            offsitePath: offsite.path,
            offsiteError: offsite.error,
            jt: info.journal?.timeline ?? null,
            js: info.journal?.seq ?? null,
          })
        this.audit.append({
          action: verified ? 'backup.run' : 'backup.failed',
          permission: 'backup:create',
          userId: actor?.userId ?? null,
          branchId: this.branchId(actor),
          entity: 'backup',
          entityId: id,
          after: { kind, fileName: basename(file), sizeBytes, verified, offsite: offsite.path ? 'copied' : offsite.error ? 'failed' : 'none' },
          risk: verified ? 'low' : 'medium',
        })
      })
      .immediate()
    if (verified && kind === 'snapshot') {
      this.prune()
      this.pruneJournal()
    }
    const row = this.db.prepare('SELECT r.*, u.display_name AS created_by_name FROM backup_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?').get(id) as BackupRow
    if (!verified) throw new AppError('BACKUP_INVALID', { id })
    return this.toDto(row)
  }

  private copyOffsite(file: string): { path: string | null; error: string | null } {
    if (!this.settings.get('backup.offsite_enabled')) return { path: null, error: null }
    const dir = this.settings.get('backup.offsite_dir')
    try {
      if (!dir || !isWritableDir(dir)) throw new Error('unreachable')
      const dest = join(dir, basename(file))
      copyFileSync(file, dest)
      copyFileSync(`${file}.json`, `${dest}.json`)
      if (sha256File(dest) !== sha256File(file)) throw new Error('copy checksum mismatch')
      return { path: dest, error: null }
    } catch (err) {
      return { path: null, error: String(err instanceof Error ? err.message : err).slice(0, 200) }
    }
  }

  /** Applies D25 retention to scheduled snapshots (local + off-site copies). Returns the number removed. */
  prune(): number {
    const snaps = this.db
      .prepare(`SELECT id, started_at AS startedAt, path, offsite_path AS offsitePath FROM backup_runs WHERE kind = 'snapshot' AND ok = 1 AND deleted_at IS NULL`)
      .all() as { id: string; startedAt: number; path: string; offsitePath: string | null }[]
    const drop = new Set(selectForPrune(snaps, this.settings.get('backup.keep_daily'), BACKUP_KEEP_MONTHLY))
    if (drop.size === 0) return 0
    const at = this.now()
    const removed = snaps.filter((s) => drop.has(s.id))
    for (const s of removed) for (const f of [s.path, `${s.path}.json`, ...(s.offsitePath ? [s.offsitePath, `${s.offsitePath}.json`] : [])]) rmQuiet(f)
    this.db
      .transaction(() => {
        const mark = this.db.prepare('UPDATE backup_runs SET deleted_at = ? WHERE id = ?')
        for (const s of removed) mark.run(at, s.id)
        this.audit.append({ action: 'backup.prune', permission: 'backup:create', branchId: this.branchId(null), entity: 'backup', after: { removed: removed.map((s) => basename(s.path)) }, risk: 'low' })
      })
      .immediate()
    return removed.length
  }

  /** D38 retention of the change journal (after the snapshot retention, so bases are final). */
  pruneJournal(): string[] {
    const j = this.opts.journal
    if (!j?.isStarted) return []
    const removed = j.prune(this.bases().map((b) => ({ timeline: b.journal_timeline!, finishedAt: b.finished_at!, seq: b.journal_seq! })))
    if (removed.length)
      this.db
        .transaction(() => {
          this.audit.append({ action: 'backup.journal_prune', permission: 'backup:create', branchId: this.branchId(null), entity: 'journal', after: { removed: removed.length }, risk: 'low' })
        })
        .immediate()
    return removed
  }

  private verifiedFile(id: string): { row: BackupRow; info: FileInspection } {
    const row = this.db.prepare('SELECT * FROM backup_runs WHERE id = ? AND deleted_at IS NULL').get(id) as BackupRow | undefined
    if (!row) throw new AppError('NOT_FOUND')
    if (row.ok !== 1 || !existsSync(row.path)) throw new AppError('BACKUP_INVALID', { id })
    if (row.sha256 && sha256File(row.path) !== row.sha256) throw new AppError('BACKUP_INVALID', { id, reason: 'checksum' })
    const info = inspectFile(row.path)
    if (!info.integrityOk || !info.audit.ok) throw new AppError('BACKUP_INVALID', { id })
    return { row, info }
  }

  /** Restore step 1 (default mode on the Backup page): verified copy to inspect — the live DB is untouched. */
  restoreCopy(actor: Actor, id: string): RestoreInspectDto {
    const { backupDir } = this.paths()
    const { row, info } = this.verifiedFile(id)
    const dir = join(dirname(backupDir), 'restore')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, `restore-${fileStamp(row.started_at)}-${row.id.slice(-6)}.sqlite`)
    copyFileSync(row.path, dest)
    this.db
      .transaction(() => {
        this.audit.append({ action: 'backup.restore_copy', permission: 'backup:restore', userId: actor.userId, branchId: actor.branchId, entity: 'backup', entityId: id, after: { fileName: basename(row.path), copy: dest }, risk: 'medium' })
      })
      .immediate()
    return {
      backupId: id,
      path: dest,
      sizeBytes: statSync(dest).size,
      schemaVersion: info.schemaVersion,
      auditCount: info.audit.count,
      auditOk: info.audit.ok,
      bills: info.bills,
      lastBillAt: info.lastBillAt,
      users: info.users,
    }
  }

  /**
   * Restore step 2 (replace): always backs up the current state first (pre_restore), then stages the
   * verified file. The swap happens at the next start (applyPendingRestore) — the caller restarts the app.
   */
  async stageReplace(actor: Actor, id: string): Promise<PendingRestore> {
    const { dbPath } = this.paths()
    const { row } = this.verifiedFile(id)
    this.db
      .transaction(() => {
        this.audit.append({ action: 'backup.restore_requested', permission: 'backup:restore', userId: actor.userId, branchId: actor.branchId, entity: 'backup', entityId: id, after: { fileName: basename(row.path), backupAt: row.started_at }, risk: 'high' })
      })
      .immediate()
    const pre = await this.run('pre_restore', actor)
    copyFileSync(row.path, pendingPaths(dbPath).file)
    return this.writePending(actor, row, pre, {})
  }

  private writePending(actor: Actor, base: BackupRow, pre: BackupDto, extra: Pick<PendingRestore, 'pointInTime' | 'appliedUntil'>): PendingRestore {
    const p = pendingPaths(this.paths().dbPath)
    const pending: PendingRestore = {
      backupId: base.id,
      backupFile: basename(base.path),
      backupStartedAt: base.started_at,
      sha256: sha256File(p.file),
      requestedBy: actor.userId,
      requestedByName: actor.displayName,
      requestedAt: this.now(),
      preRestoreBackupId: pre.id,
      preRestoreFile: pre.fileName,
      ...extra,
    }
    writeFileSync(p.manifest, JSON.stringify(pending, null, 2))
    return pending
  }

  /**
   * After a restart: re-index backup files the restored DB does not know about, and record the
   * outcome of the staged restore in the (restored) audit log.
   */
  completeRestore(result: PendingRestoreResult | null): void {
    if (!result) return
    this.reconcile()
    const pending = result.pending
    const userExists = pending ? !!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(pending.requestedBy) : false
    this.db
      .transaction(() => {
        this.audit.append({
          action: result.status === 'applied' ? 'backup.restore' : 'backup.restore_failed',
          permission: 'backup:restore',
          userId: userExists ? pending!.requestedBy : null,
          branchId: this.branchId(null),
          entity: 'backup',
          entityId: pending?.backupId ?? null,
          before: result.status === 'applied' ? { replacedFile: result.replacedPath ? basename(result.replacedPath) : null, preRestoreBackup: pending?.preRestoreFile ?? null } : null,
          after:
            result.status === 'applied'
              ? { restoredFrom: pending!.backupFile, backupAt: pending!.backupStartedAt, requestedBy: pending!.requestedByName, ...(pending!.pointInTime ? { pointInTime: pending!.pointInTime, appliedUntil: pending!.appliedUntil } : {}) }
              : { error: result.error, requestedBy: pending?.requestedByName ?? null },
          risk: 'high',
        })
      })
      .immediate()
  }

  /** Adds rows for backup files (with sidecar manifests) found in the local folder but unknown to this DB. */
  reconcile(): number {
    if (!this.opts.paths) return 0
    const { backupDir } = this.opts.paths
    if (!existsSync(backupDir)) return 0
    let added = 0
    const known = this.db.prepare('SELECT 1 FROM backup_runs WHERE id = ? OR path = ?')
    const insert = this.db.prepare(
      `INSERT INTO backup_runs (id, kind, path, size_bytes, ok, created_by, started_at, finished_at, sha256, schema_version, audit_seq, audit_hash, verified_at, journal_timeline, journal_seq)
       VALUES (@id, @kind, @path, @size, @ok, NULL, @startedAt, @finishedAt, @sha256, @schema, @seq, @hash, @verifiedAt, @jt, @js)`,
    )
    this.db
      .transaction(() => {
        for (const name of readdirSync(backupDir)) {
          if (!name.endsWith('.sqlite.json')) continue
          const path = join(backupDir, name.slice(0, -'.json'.length))
          if (!existsSync(path)) continue
          let m: Manifest
          try {
            m = JSON.parse(readFileSync(join(backupDir, name), 'utf8')) as Manifest
          } catch {
            continue
          }
          if (known.get(m.id, path)) continue
          insert.run({ id: m.id, kind: m.kind, path, size: m.sizeBytes, ok: m.verified ? 1 : 0, startedAt: m.startedAt, finishedAt: m.finishedAt, sha256: m.sha256, schema: m.schemaVersion, seq: m.audit?.seq ?? null, hash: m.audit?.hash ?? null, verifiedAt: m.verified ? m.finishedAt : null, jt: m.journal?.timeline ?? null, js: m.journal?.seq ?? null })
          added++
        }
      })
      .immediate()
    return added
  }

  /**
   * Off-box anchor for the audit chain: the newest verified backup recorded audit seq/hash at that time.
   * If that row is now different (or gone), the live log was rewritten or truncated.
   */
  checkAuditAnchor(): { ok: boolean; seq: number; at: number } | null {
    const a = this.db
      .prepare(`SELECT audit_seq AS seq, audit_hash AS hash, started_at AS at FROM backup_runs WHERE verified_at IS NOT NULL AND audit_seq IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
      .get() as { seq: number; hash: string; at: number } | undefined
    if (!a) return null
    const live = this.db.prepare('SELECT hash FROM audit_log WHERE seq = ?').pluck().get(a.seq) as string | undefined
    return { ok: live === a.hash, seq: a.seq, at: a.at }
  }

  // ---------------------------------------------------------------------------
  // Point-in-time restore (Tier B/C, D38): snapshot of a timeline + its change journal
  // ---------------------------------------------------------------------------

  /** Verified backups whose files exist and that know their journal position. */
  private bases(): BackupRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM backup_runs WHERE verified_at IS NOT NULL AND deleted_at IS NULL AND journal_timeline IS NOT NULL AND journal_seq IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at`)
        .all() as BackupRow[]
    ).filter((r) => existsSync(r.path))
  }

  /**
   * Restorable ranges, one per timeline: from its oldest usable base snapshot (the newest one taken
   * before the 14-day window, when there is one — older segments are pruned) to the moment the
   * timeline stopped being live (now, for the current one).
   */
  private pitrRanges(): { timeline: string; from: number; to: number }[] {
    const j = this.opts.journal
    if (!j?.isStarted) return []
    const now = this.now()
    const windowStart = now - JOURNAL_KEEP_DAYS * 86_400_000
    const bases = this.bases()
    const tls = j.timelines()
    const out: { timeline: string; from: number; to: number }[] = []
    tls.forEach((tl, i) => {
      const own = bases.filter((b) => b.journal_timeline === tl.id)
      if (!own.length) return
      const before = own.filter((b) => b.finished_at! <= windowStart)
      const from = before.length ? before[before.length - 1]!.finished_at! : own[0]!.finished_at!
      const to = tl.id === j.timeline ? now : (tls[i + 1]?.createdAt ?? now)
      if (from <= to) out.push({ timeline: tl.id, from, to })
    })
    return out
  }

  private pitrStatus(): PitrStatusDto | null {
    const j = this.opts.journal
    if (!j?.isStarted) return null
    const s = j.status()
    return {
      ranges: this.pitrRanges().map(({ from, to }) => ({ from, to })),
      keepDays: JOURNAL_KEEP_DAYS,
      intervalSec: JOURNAL_SHIP_INTERVAL_MS / 1000,
      pendingRows: s.pendingRows,
      lastShippedAt: s.lastShippedAt,
      offsite: s.offsite,
      error: s.error,
      bytes: s.bytes,
    }
  }

  /** A new timeline needs a snapshot to replay from: taken at start and retried by the minute tick. */
  async ensureJournalBase(): Promise<BackupDto | null> {
    const j = this.opts.journal
    if (!j?.isStarted || !this.available || this.busy || !this.org.firstBranch()) return null
    if (this.bases().some((b) => b.journal_timeline === j.timeline)) return null
    try {
      return await this.run('snapshot', null)
    } catch {
      return null // recorded in backup_runs + audit_log; retried next minute
    }
  }

  /** Builds the database as it was at `at` into a new file next to the app data (the live DB is untouched). */
  private pitrBuild(at: number): { file: string; base: BackupRow; info: FileInspection; changes: number; appliedUntil: number } {
    const j = this.opts.journal
    const { backupDir } = this.paths()
    if (!j?.isStarted) throw new AppError('PITR_UNAVAILABLE')
    if (this.busy) throw new AppError('BACKUP_BUSY')
    j.ship() // everything captured so far goes to the files first
    if (j.status().pendingRows > 0) throw new AppError('PITR_UNAVAILABLE', { reason: 'ship' })
    const range = this.pitrRanges().find((r) => at >= r.from && at <= r.to)
    if (!range) throw new AppError('PITR_OUT_OF_RANGE')
    const base = this.bases()
      .filter((b) => b.journal_timeline === range.timeline && b.finished_at! <= at)
      .pop()
    if (!base) throw new AppError('PITR_OUT_OF_RANGE')
    this.verifiedFile(base.id)

    this.busy = true
    const dir = join(dirname(backupDir), 'restore')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `pitr-${fileStamp(at)}-${uuidv7(this.now()).slice(-6)}.sqlite`)
    try {
      copyFileSync(base.path, file)
      const target = new Database(file)
      let r: ReturnType<JournalService['replay']>
      try {
        r = j.replay(target, range.timeline, base.journal_seq!, at)
        if ((target.pragma('foreign_key_check') as unknown[]).length) throw new AppError('JOURNAL_CORRUPT', { reason: 'foreign_key_check' })
      } finally {
        target.close()
      }
      const info = inspectFile(file)
      if (!info.integrityOk || !info.audit.ok) throw new AppError('BACKUP_INVALID', { reason: 'pitr' })
      return { file, base, info, changes: r.applied, appliedUntil: r.lastAt ?? base.finished_at! }
    } catch (err) {
      rmQuiet(file)
      throw err
    } finally {
      this.busy = false
    }
  }

  /** Bills in the live data that the restored file does not have (what a replace would lose). */
  private lostSince(file: string): { bills: number; satang: number } {
    this.db.prepare('ATTACH DATABASE ? AS pitr').run(file)
    try {
      const r = this.db.prepare('SELECT count(*) AS n, coalesce(sum(total_satang), 0) AS s FROM main.bills WHERE id NOT IN (SELECT id FROM pitr.bills)').get() as { n: number; s: number }
      return { bills: r.n, satang: r.s }
    } finally {
      this.db.exec('DETACH DATABASE pitr')
    }
  }

  /** Point-in-time step 1: a verified copy at `at`, plus what the current data has beyond it. */
  pitrCopy(actor: Actor, at: number): PitrInspectDto {
    const b = this.pitrBuild(at)
    const lost = this.lostSince(b.file)
    this.db
      .transaction(() => {
        this.audit.append({ action: 'backup.pitr_copy', permission: 'backup:restore', userId: actor.userId, branchId: actor.branchId, entity: 'backup', entityId: b.base.id, after: { pointInTime: at, appliedUntil: b.appliedUntil, changes: b.changes, copy: b.file }, risk: 'medium' })
      })
      .immediate()
    return {
      backupId: b.base.id,
      path: b.file,
      sizeBytes: statSync(b.file).size,
      schemaVersion: b.info.schemaVersion,
      auditCount: b.info.audit.count,
      auditOk: b.info.audit.ok,
      bills: b.info.bills,
      lastBillAt: b.info.lastBillAt,
      users: b.info.users,
      pointInTime: at,
      appliedUntil: b.appliedUntil,
      changes: b.changes,
      baseStartedAt: b.base.started_at,
      lostBills: lost.bills,
      lostSalesSatang: lost.satang,
    }
  }

  /**
   * Point-in-time step 2: rebuilds the same point (deterministic), backs up the current state, and
   * stages the file for the swap at the next start.
   */
  async pitrReplace(actor: Actor, at: number): Promise<PendingRestore> {
    const { dbPath } = this.paths()
    this.db
      .transaction(() => {
        this.audit.append({ action: 'backup.restore_requested', permission: 'backup:restore', userId: actor.userId, branchId: actor.branchId, entity: 'backup', after: { pointInTime: at }, risk: 'high' })
      })
      .immediate()
    const b = this.pitrBuild(at)
    try {
      const pre = await this.run('pre_restore', actor)
      renameSync(b.file, pendingPaths(dbPath).file)
      return this.writePending(actor, b.base, pre, { pointInTime: at, appliedUntil: b.appliedUntil })
    } catch (err) {
      rmQuiet(b.file)
      throw err
    }
  }

  private branchId(actor: Actor | null): string | null {
    return actor?.branchId ?? this.org.firstBranch()?.id ?? null
  }
}

/** Plain rollback journal: the copy is one self-contained file (no -wal / -shm appear when it is opened). */
function toRollbackJournal(file: string): void {
  const copy = new Database(file)
  try {
    copy.pragma('journal_mode = DELETE')
  } finally {
    copy.close()
  }
}

function isWritableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    const probe = join(dir, `.kposs-write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}
