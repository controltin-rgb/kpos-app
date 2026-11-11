import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from '@main/db/connection'
import { uuidv7 } from '@shared/id'

/**
 * "Reset database" (Super Admin, Backup page): start over as a brand-new install.
 * Staged like a restore: the request is written next to the DB, the app restarts, and the file is
 * removed BEFORE the database is opened (no live connection, no half-wiped tables, no append-only
 * trigger fights). Kept across the reset: the installed license (and the trial start, so a reset
 * never hands out a new trial), the device identity, and backup files already on disk.
 */
export interface PendingReset {
  requestedBy: string
  requestedByName: string
  requestedAt: number
  /** active .LIC contents, re-installed into the new DB */
  license: { raw: string; licenseId: string; hardwareId: string; issuedAt: number; expiresAt: number | null; featuresJson: string; installedAt: number } | null
  trialStartedAt: number | null
}

export const resetMarkerPath = (dbPath: string) => join(dirname(dbPath), 'reset-pending.json')
/** written after a reset so the fresh DB can pick up what was carried over */
const carryPath = (dbPath: string) => join(dirname(dbPath), 'reset-carry.json')

export function stageReset(db: Db, dbPath: string, by: { userId: string; name: string }, now: number): PendingReset {
  const lic = db
    .prepare(
      `SELECT raw, license_id AS licenseId, hardware_id AS hardwareId, issued_at AS issuedAt, expires_at AS expiresAt,
              features_json AS featuresJson, installed_at AS installedAt
       FROM licenses WHERE replaced_at IS NULL ORDER BY installed_at DESC LIMIT 1`,
    )
    .get() as PendingReset['license'] | undefined
  const companies = db.prepare('SELECT min(created_at) FROM companies').pluck().get() as number | null
  const carried = db.prepare(`SELECT value_json FROM settings WHERE key = 'license.trial_started_at' AND branch_id IS NULL`).pluck().get() as string | undefined
  const prevTrial = carried ? (JSON.parse(carried) as number) : null
  const trialStartedAt = [companies, prevTrial].filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)[0] ?? null
  const pending: PendingReset = { requestedBy: by.userId, requestedByName: by.name, requestedAt: now, license: lic ?? null, trialStartedAt }
  writeFileSync(resetMarkerPath(dbPath), JSON.stringify(pending, null, 2))
  return pending
}

export function cancelStagedReset(dbPath: string): void {
  rmSync(resetMarkerPath(dbPath), { force: true })
}

/** Startup, before the DB is opened: removes the database file if a reset was staged. */
export function applyPendingReset(dbPath: string): PendingReset | null {
  const marker = resetMarkerPath(dbPath)
  if (!existsSync(marker)) return null
  const pending = JSON.parse(readFileSync(marker, 'utf8')) as PendingReset
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  // the marker becomes the carry file only after the DB is gone: a crash in between retries the reset
  renameSync(marker, carryPath(dbPath))
  return pending
}

/**
 * After migrations created the empty DB: re-install the license and the trial start, and record the
 * reset as the first audit entry. Idempotent (runs once, then the carry file is removed).
 */
export function finishReset(db: Db, dbPath: string, audit: { append: (e: { action: string; entity: string; after: unknown; risk: 'high' }) => void }, now: number): PendingReset | null {
  const file = carryPath(dbPath)
  if (!existsSync(file)) return null
  const p = JSON.parse(readFileSync(file, 'utf8')) as PendingReset
  db.transaction(() => {
    if (p.license) {
      const l = p.license
      db.prepare(
        `INSERT INTO licenses (id, license_id, raw, hardware_id, issued_at, expires_at, features_json, installed_at, installed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(uuidv7(now), l.licenseId, l.raw, l.hardwareId, l.issuedAt, l.expiresAt, l.featuresJson, l.installedAt)
    }
    if (p.trialStartedAt !== null)
      db.prepare(`INSERT INTO settings (id, branch_id, key, value_json, updated_at, updated_by) VALUES (?, NULL, 'license.trial_started_at', ?, ?, NULL)`).run(
        uuidv7(now),
        JSON.stringify(p.trialStartedAt),
        now,
      )
    audit.append({ action: 'system.database_reset', entity: 'system', after: { requestedByName: p.requestedByName, requestedAt: p.requestedAt, licenseKept: !!p.license }, risk: 'high' })
  }).immediate()
  rmSync(file, { force: true })
  return p
}
