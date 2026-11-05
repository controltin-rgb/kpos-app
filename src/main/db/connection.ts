import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * Open a SQLite database with the PRAGMAs required by CLAUDE.md.
 * The Host/Standalone main process is the only place that opens the DB file.
 */
export function openDatabase(filename: string): Db {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}

/** Returns the SQLite library version bundled with better-sqlite3. */
export function sqliteVersion(db: Db): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
  return row.v
}
