import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { fileStamp } from './retention'

/**
 * Backup before running a new app version (D39): updates are installed over the old version by
 * hand, so the first start of a new version copies the database before anything (migrations,
 * new code) touches it. Recorded as kind 'pre_update' (not pruned, D25).
 */

const versionFile = (dbPath: string) => join(dirname(dbPath), 'app-version.json')

export function lastAppVersion(dbPath: string): string | null {
  try {
    return (JSON.parse(readFileSync(versionFile(dbPath), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** Copies the DB when the app version differs from the one that last ran it. Returns the copy, or null. */
export function preUpdateBackup(dbPath: string, backupDir: string, version: string, now: number = Date.now()): string | null {
  const prev = lastAppVersion(dbPath)
  if (prev === version || !existsSync(dbPath)) return null // same version, or a fresh install
  mkdirSync(backupDir, { recursive: true })
  const safe = (v: string) => v.replace(/[^0-9A-Za-z.-]/g, '_')
  const file = join(backupDir, `kposs-pre_update-${fileStamp(now)}-v${safe(prev ?? 'old')}-to-v${safe(version)}.sqlite`)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.prepare('VACUUM INTO ?').run(file)
  } finally {
    db.close()
  }
  return file
}

/** Written after a successful start, so a version that fails to start is backed up again next time. */
export function recordAppVersion(dbPath: string, version: string, now: number = Date.now()): void {
  writeFileSync(versionFile(dbPath), JSON.stringify({ version, at: now }, null, 2))
}
