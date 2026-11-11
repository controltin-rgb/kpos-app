import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '@main/db/connection'
import { loadMigrations, migrate, MigrationError } from '@main/db/migrate'
import { closeAfter, migrationsDir, tmpDir } from '../helpers/tmp'

const M1 = 'CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;'
const M2 = 'CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;'
const BROKEN = 'CREATE TABLE c (id TEXT PRIMARY KEY) STRICT; INSERT INTO nope VALUES (1);'

function setup(files: Record<string, string>) {
  const dir = tmpDir()
  const dbPath = join(dir, 'kposs.sqlite')
  const backupDir = join(dir, 'backup')
  const db = closeAfter(openDatabase(dbPath))
  return { db, dbPath, backupDir, migrationsDir: migrationsDir(files) }
}

function tables(db: Db): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`).all() as { name: string }[]
  ).map((r) => r.name)
}

const version = (db: Db) => db.pragma('user_version', { simple: true }) as number

describe('loadMigrations', () => {
  it('sorts by number and computes checksums', () => {
    const dir = migrationsDir({ '0002_b.sql': M2, '0001_a.sql': M1 })
    const list = loadMigrations(dir)
    expect(list.map((m) => m.version)).toEqual([1, 2])
    expect(list[0]!.name).toBe('0001_a.sql')
    expect(list[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores non-sql files', () => {
    const dir = migrationsDir({ '0001_a.sql': M1, '.gitkeep': '', 'README.md': '#' })
    expect(loadMigrations(dir)).toHaveLength(1)
  })

  it.each<[Record<string, string>, string]>([
    [{ '0001_a.sql': M1, '0003_c.sql': M2 }, 'gap'],
    [{ '0002_b.sql': M2 }, 'not starting at 1'],
    [{ '0001_a.sql': M1, '0001_b.sql': M2 }, 'duplicate'],
    [{ '1_a.sql': M1 }, 'bad name'],
  ])('rejects invalid sets (%#: %s)', (files) => {
    expect(() => loadMigrations(migrationsDir(files))).toThrow(MigrationError)
  })
})

describe('migrate', () => {
  it('applies all migrations to a fresh database without a backup', () => {
    const s = setup({ '0001_a.sql': M1, '0002_b.sql': M2 })
    const r = migrate(s.db, s)
    expect(r).toMatchObject({ from: 0, to: 2, applied: ['0001_a.sql', '0002_b.sql'], backupPath: null })
    expect(version(s.db)).toBe(2)
    expect(tables(s.db)).toEqual(['a', 'b', 'schema_migrations'])
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('is a no-op when already up to date', () => {
    const s = setup({ '0001_a.sql': M1 })
    migrate(s.db, s)
    const r = migrate(s.db, s)
    expect(r.applied).toEqual([])
    expect(r.backupPath).toBeNull()
  })

  it('backs up the existing database before upgrading', () => {
    const s = setup({ '0001_a.sql': M1 })
    migrate(s.db, s)
    s.db.prepare(`INSERT INTO a VALUES ('keep-me')`).run()
    writeFileSync(join(s.migrationsDir, '0002_b.sql'), M2)

    const r = migrate(s.db, s)
    expect(r.applied).toEqual(['0002_b.sql'])
    expect(r.backupPath).not.toBeNull()
    expect(existsSync(r.backupPath!)).toBe(true)
    expect(r.backupPath!).toContain('pre-migrate-v1')

    const backup = closeAfter(openDatabase(r.backupPath!))
    expect(version(backup)).toBe(1)
    expect(backup.prepare('SELECT id FROM a').pluck().all()).toEqual(['keep-me'])
    backup.close()
  })

  it('rolls back everything and keeps the backup when a migration fails', () => {
    const s = setup({ '0001_a.sql': M1 })
    migrate(s.db, s)
    writeFileSync(join(s.migrationsDir, '0002_b.sql'), M2)
    writeFileSync(join(s.migrationsDir, '0003_c.sql'), BROKEN)

    let err: unknown
    try {
      migrate(s.db, s)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MigrationError)
    const me = err as MigrationError
    expect(me.code).toBe('MIGRATION_FAILED')
    expect(me.file).toBe('0003_c.sql')
    expect(me.backupPath && existsSync(me.backupPath)).toBe(true)

    // 0002 must be rolled back too: the whole batch is one transaction
    expect(version(s.db)).toBe(1)
    expect(tables(s.db)).toEqual(['a', 'schema_migrations'])
    expect(s.db.inTransaction).toBe(false)
  })

  it('refuses to run when an applied migration file was modified', () => {
    const s = setup({ '0001_a.sql': M1 })
    migrate(s.db, s)
    writeFileSync(join(s.migrationsDir, '0001_a.sql'), M1 + '\n-- edited')
    expect(() => migrate(s.db, s)).toThrow(expect.objectContaining({ code: 'CHECKSUM_MISMATCH' }))
  })

  it('refuses to open a database newer than the app', () => {
    const s = setup({ '0001_a.sql': M1, '0002_b.sql': M2 })
    migrate(s.db, s)
    const older = migrationsDir({ '0001_a.sql': M1 })
    expect(() => migrate(s.db, { ...s, migrationsDir: older })).toThrow(
      expect.objectContaining({ code: 'DB_NEWER_THAN_APP' }),
    )
  })

  it('does not write backups for in-memory databases', () => {
    const backupDir = join(tmpDir(), 'backup')
    const db = openDatabase(':memory:')
    migrate(db, { dbPath: ':memory:', backupDir, migrationsDir: migrationsDir({ '0001_a.sql': M1 }) })
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([])
  })
})
