import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './connection'

export interface Migration {
  version: number
  name: string
  sql: string
  sha256: string
}

export interface MigrateOptions {
  /** Path of the DB file being migrated (':memory:' disables the pre-migrate backup). */
  dbPath: string
  migrationsDir: string
  backupDir: string
  now?: () => number
}

export interface MigrateResult {
  from: number
  to: number
  applied: string[]
  backupPath: string | null
}

export type MigrationErrorCode =
  | 'INVALID_MIGRATION_FILES'
  | 'CHECKSUM_MISMATCH'
  | 'DB_NEWER_THAN_APP'
  | 'BACKUP_FAILED'
  | 'MIGRATION_FAILED'

/** Carries a machine-readable code; the UI maps it to a Thai message. */
export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    readonly details: { file?: string; backupPath?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause })
    this.name = 'MigrationError'
  }
  get file(): string | undefined {
    return this.details.file
  }
  get backupPath(): string | null {
    return this.details.backupPath ?? null
  }
}

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Reads `NNNN_name.sql` files, ordered, contiguous from 0001. */
export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
  const list: Migration[] = []
  for (const name of files) {
    const m = FILE_RE.exec(name)
    if (!m) throw new MigrationError('INVALID_MIGRATION_FILES', `Invalid migration file name: ${name}`, { file: name })
    const sql = readFileSync(join(dir, name), 'utf8')
    list.push({ version: Number(m[1]), name, sql, sha256: sha256(sql) })
  }
  list.sort((a, b) => a.version - b.version)
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        'INVALID_MIGRATION_FILES',
        `Migrations must be numbered contiguously from 0001; found ${m.name} at position ${i + 1}`,
        { file: m.name },
      )
    }
  })
  return list
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT`

function hasLedger(db: Db): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'`).get()
}

/**
 * Brings the database to the latest migration.
 * - Verifies already-applied files were not edited (CLAUDE.md rule 7).
 * - Backs up a non-empty DB with `VACUUM INTO` before applying anything.
 * - Applies all pending files in ONE `BEGIN IMMEDIATE` transaction; any failure rolls back the batch.
 */
export function migrate(db: Db, opts: MigrateOptions): MigrateResult {
  const now = opts.now ?? Date.now
  const migrations = loadMigrations(opts.migrationsDir)
  const latest = migrations.length
  const from = db.pragma('user_version', { simple: true }) as number

  if (from > latest) {
    throw new MigrationError('DB_NEWER_THAN_APP', `Database version ${from} is newer than this app (${latest})`)
  }

  if (from > 0 && hasLedger(db)) {
    const applied = db.prepare('SELECT version, name, sha256 FROM schema_migrations').all() as {
      version: number
      name: string
      sha256: string
    }[]
    for (const row of applied) {
      const file = migrations[row.version - 1]
      if (!file || file.sha256 !== row.sha256 || file.name !== row.name) {
        throw new MigrationError('CHECKSUM_MISMATCH', `Applied migration ${row.name} was modified or removed`, {
          file: row.name,
        })
      }
    }
  }

  const pending = migrations.slice(from)
  if (pending.length === 0) return { from, to: from, applied: [], backupPath: null }

  let backupPath: string | null = null
  if (opts.dbPath !== ':memory:' && from > 0) {
    try {
      if (!existsSync(opts.backupDir)) mkdirSync(opts.backupDir, { recursive: true })
      backupPath = join(opts.backupDir, `pre-migrate-v${from}-to-v${latest}-${now()}.sqlite`)
      db.prepare('VACUUM INTO ?').run(backupPath)
    } catch (cause) {
      throw new MigrationError('BACKUP_FAILED', 'Could not back up database before migrating', { backupPath, cause })
    }
  }

  let current: Migration | undefined
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(LEDGER_DDL)
    const record = db.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)')
    for (const m of pending) {
      current = m
      db.exec(m.sql)
      record.run(m.version, m.name, m.sha256, now())
      // user_version lives in the DB header and is rolled back with the transaction
      db.pragma(`user_version = ${m.version}`)
    }
    db.exec('COMMIT')
  } catch (cause) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw new MigrationError('MIGRATION_FAILED', `Migration ${current?.name ?? '?'} failed: ${String(cause)}`, {
      file: current?.name,
      backupPath,
      cause,
    })
  }

  // fail fast if the schema left dangling foreign keys
  const fk = db.pragma('foreign_key_check') as unknown[]
  if (fk.length > 0) {
    throw new MigrationError('MIGRATION_FAILED', `foreign_key_check failed after migrating (${fk.length} rows)`, {
      backupPath,
    })
  }

  return { from, to: latest, applied: pending.map((m) => m.name), backupPath }
}
