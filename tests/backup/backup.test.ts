import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyPendingRestore, inspectFile } from '@main/backup/backup.service'
import { lastScheduledAt, selectForPrune } from '@main/backup/retention'
import { createTestApp } from '../helpers/app'
import { T0 } from '../helpers/fixtures'
import { closeAfter, tmpDir } from '../helpers/tmp'

const DAY = 86_400_000
const HOUR = 3_600_000

function files() {
  const root = tmpDir('kposs-backup-')
  return { root, dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }
}

async function fileApp(f = files(), relaunch?: () => void) {
  const t = createTestApp({ files: f, ...(relaunch ? { relaunch } : {}) })
  await t.setup()
  return { t, f }
}

const sqliteFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.sqlite')) : [])
const userCount = (db: Database.Database) => db.prepare('SELECT count(*) FROM users').pluck().get() as number

describe('retention (D25)', () => {
  it('keeps the newest N daily snapshots plus the first snapshot of each of the last 6 months', () => {
    // one snapshot per day for 240 days, starting 2026-01-01 03:00 ICT
    const start = Date.UTC(2025, 11, 31, 20, 0, 0)
    const snaps = Array.from({ length: 240 }, (_, i) => ({ id: `s${i}`, startedAt: start + i * DAY }))
    const drop = new Set(selectForPrune(snaps, 14, 6))
    const kept = snaps.filter((s) => !drop.has(s.id))
    // 14 newest + first of Mar..Aug (the newest 6 months); Aug 1st may already be among the 14 newest
    const newest = snaps.slice(-14).map((s) => s.id)
    for (const id of newest) expect(drop.has(id)).toBe(false)
    const monthFirsts = kept.filter((s) => !newest.includes(s.id)).map((s) => new Date(s.startedAt + 7 * HOUR).toISOString().slice(0, 10))
    expect(monthFirsts.every((d) => d.endsWith('-01'))).toBe(true)
    expect(kept.length).toBeLessThanOrEqual(20)
    expect(kept.length).toBeGreaterThanOrEqual(19)
    // January (oldest month) is beyond the 6-month window
    expect(drop.has('s0')).toBe(true)
  })

  it('a missed daily time is due at the next start', () => {
    const at = Date.UTC(2026, 10, 7, 1, 0, 0) // 08:00 ICT
    expect(lastScheduledAt(at, '03:00')).toBe(Date.UTC(2026, 10, 6, 20, 0, 0)) // today 03:00 ICT
    expect(lastScheduledAt(at, '22:00')).toBe(Date.UTC(2026, 10, 6, 15, 0, 0)) // yesterday 22:00 ICT
  })
})

describe('backup run', () => {
  it('writes a verified copy with a manifest, records it and audits it', async () => {
    const { t, f } = await fileApp()
    const b = await t.call(1, 'backup.run')
    expect(b).toMatchObject({ kind: 'manual', ok: true, verified: true, available: true, offsite: 'none' })
    expect(b.sizeBytes).toBeGreaterThan(0)
    const file = join(f.backupDir, b.fileName)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(`${file}.json`, 'utf8'))).toMatchObject({ id: b.id, verified: true })
    // a self-contained file: no WAL sidecars next to it after verification
    expect(existsSync(`${file}-wal`)).toBe(false)

    const info = inspectFile(file)
    expect(info.integrityOk).toBe(true)
    expect(info.audit.ok).toBe(true)
    expect(info.users).toBe(1)
    expect(t.auditActions()).toContain('backup.run')

    const list = await t.call(1, 'backup.list')
    expect(list.map((x) => x.id)).toEqual([b.id])
    const ov = await t.call(1, 'backup.overview')
    expect(ov).toMatchObject({ count: 1, keepDaily: 14, keepMonthly: 6, dailyTime: '03:00' })
  })

  it('needs backup:create; restore needs backup:restore', async () => {
    const { t } = await fileApp()
    await t.userOn(2, 'cashier1', 'cashier')
    await t.userOn(3, 'manager1', 'branch_manager')
    await t.fails('FORBIDDEN', 2, 'backup.run')
    await t.fails('FORBIDDEN', 2, 'backup.list')
    const b = await t.call(1, 'backup.run')
    await t.fails('FORBIDDEN', 3, 'backup.restoreCopy', { id: b.id, confirm: 'RESTORE' })
    await t.fails('INVALID_INPUT', 1, 'backup.restoreCopy', { id: b.id, confirm: 'restore' as 'RESTORE' })
  })

  it('is unavailable without a database file', async () => {
    const t = createTestApp()
    await t.setup()
    await t.fails('BACKUP_UNAVAILABLE', 1, 'backup.run')
  })

  it('runs the daily snapshot once per scheduled moment and prunes old snapshots', async () => {
    const { t, f } = await fileApp()
    // T0 = 10:00 ICT; the 03:00 snapshot for today is due right away (missed while "closed")
    expect(await t.app.backup.runDueSnapshot()).not.toBeNull()
    expect(await t.app.backup.runDueSnapshot()).toBeNull()
    for (let d = 1; d <= 19; d++) {
      t.advance(DAY)
      expect(await t.app.backup.runDueSnapshot()).not.toBeNull()
    }
    // 20 snapshots in Nov 5–24: 14 newest + Nov 5 (first of the month) remain
    const kept = await t.call(1, 'backup.list')
    expect(kept).toHaveLength(15)
    expect(sqliteFiles(f.backupDir)).toHaveLength(15)
    expect(t.auditActions().filter((a) => a === 'backup.prune').length).toBeGreaterThan(0)
  })
})

describe('off-site copy', () => {
  it('copies to the off-site folder and reports when it is unreachable', async () => {
    const { t, f } = await fileApp()
    const usb = join(f.root, 'usb')
    await t.fails('OFFSITE_UNREACHABLE', 1, 'backup.saveSchedule', { dailyTime: '03:00', keepDaily: 14, offsiteEnabled: true, offsiteDir: usb })
    await t.fails('INVALID_INPUT', 1, 'backup.saveSchedule', { dailyTime: '03:00', keepDaily: 14, offsiteEnabled: true, offsiteDir: 'relative/dir' })

    const usbDir = tmpDir('kposs-usb-')
    const ov = await t.call(1, 'backup.saveSchedule', { dailyTime: '22:30', keepDaily: 30, offsiteEnabled: true, offsiteDir: usbDir })
    expect(ov).toMatchObject({ dailyTime: '22:30', keepDaily: 30, offsiteEnabled: true, offsiteReachable: true })
    expect(t.auditActions()).toContain('settings.update')

    const b = await t.call(1, 'backup.run')
    expect(b.offsite).toBe('copied')
    expect(existsSync(join(usbDir, b.fileName))).toBe(true)
    expect(existsSync(join(usbDir, `${b.fileName}.json`))).toBe(true)

    // drive unplugged: the local backup still succeeds, the off-site copy is flagged
    rmSync(usbDir, { recursive: true, force: true })
    t.advance(60_000)
    const b2 = await t.call(1, 'backup.run')
    expect(b2).toMatchObject({ ok: true, offsite: 'failed' })
  })
})

describe('restore', () => {
  it('restore-as-copy verifies the backup and leaves the live database untouched', async () => {
    const { t } = await fileApp()
    const b = await t.call(1, 'backup.run')
    await t.userOn(2, 'later', 'cashier')
    const r = await t.call(1, 'backup.restoreCopy', { id: b.id, confirm: 'RESTORE' })
    expect(r).toMatchObject({ backupId: b.id, auditOk: true, users: 1 })
    expect(existsSync(r.path)).toBe(true)
    expect(userCount(t.db)).toBe(2)
    expect(t.auditActions()).toContain('backup.restore_copy')
  })

  it('refuses a damaged backup file', async () => {
    const { t, f } = await fileApp()
    const b = await t.call(1, 'backup.run')
    const file = join(f.backupDir, b.fileName)
    const bytes = readFileSync(file)
    bytes[bytes.length - 100] = (bytes[bytes.length - 100]! + 1) % 256
    writeFileSync(file, bytes)
    await t.fails('BACKUP_INVALID', 1, 'backup.restoreCopy', { id: b.id, confirm: 'RESTORE' })
    await t.fails('BACKUP_INVALID', 1, 'backup.restoreReplace', { id: b.id, confirm: 'RESTORE' })
  })

  it('replace: backs up the current state, swaps the file at the next start and audits it', async () => {
    const relaunch = vi.fn()
    const f = files()
    const { t } = await fileApp(f, relaunch)
    const b = await t.call(1, 'backup.run')
    await t.userOn(2, 'after_backup', 'cashier')
    expect(userCount(t.db)).toBe(2)

    const res = await t.call(1, 'backup.restoreReplace', { id: b.id, confirm: 'RESTORE' })
    expect(res.restarting).toBe(true)
    // (real timers: better-sqlite3's online backup API is driven by timers itself)
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce(), { timeout: 2_000 })
    // the current state was backed up first (pre_restore) and the request is in the audit log
    expect((await t.call(1, 'backup.list')).map((x) => x.kind)).toContain('pre_restore')
    expect(t.auditActions()).toContain('backup.restore_requested')

    // --- restart: the Electron entry closes the DB, swaps the file, then opens it again
    t.db.close()
    const result = applyPendingRestore(f.dbPath, T0 + HOUR)
    expect(result?.status).toBe('applied')
    expect(applyPendingRestore(f.dbPath)).toBeNull() // consumed

    const t2 = createTestApp({ files: f, startAt: T0 + HOUR })
    t2.app.backup.completeRestore(result)
    expect(userCount(t2.db)).toBe(1) // the user created after the backup is gone
    const actions = t2.auditActions()
    expect(actions.at(-1)).toBe('backup.restore')
    expect(t2.app.audit.verifyChain().ok).toBe(true)
    // backups made after the restored point were re-indexed from their manifests
    const kinds = t2.app.backup.list().map((x) => x.kind)
    expect(kinds).toContain('pre_restore')
    expect(kinds).toContain('manual')
    // the replaced file is kept
    expect(readdirSync(join(f.root, 'data')).some((n) => n.startsWith('replaced-'))).toBe(true)
  })

  it('a staged file that does not match its checksum is not applied', async () => {
    const f = files()
    const { t } = await fileApp(f)
    const b = await t.call(1, 'backup.run')
    await t.app.backup.stageReplace((await t.app.authService.resolve(t.app.sessions.get(1)!))!, b.id)
    t.db.close()
    writeFileSync(join(f.root, 'data', 'restore-pending.sqlite'), 'garbage')
    const result = applyPendingRestore(f.dbPath)
    expect(result).toMatchObject({ status: 'failed' })
    // the live DB is still there and opens fine
    const db = closeAfter(new Database(f.dbPath, { readonly: true }))
    expect(userCount(db)).toBe(1)
  })
})

describe('audit anchor', () => {
  it('detects a truncated audit log using the head recorded in the newest backup', async () => {
    const { t } = await fileApp()
    await t.call(1, 'backup.run')
    expect((await t.call(1, 'audit.verify')).anchor).toMatchObject({ ok: true })
    // simulate an attacker with file access: drop the guard trigger and cut the tail
    const seq = t.app.backup.checkAuditAnchor()!.seq
    const triggers = t.db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'audit_log'`).pluck().all() as string[]
    for (const name of triggers) t.db.exec(`DROP TRIGGER ${name}`)
    t.db.prepare('DELETE FROM audit_log WHERE seq >= ?').run(seq)
    const v = await t.call(1, 'audit.verify')
    expect(v.ok).toBe(true) // the remaining prefix is still a valid chain…
    expect(v.anchor).toMatchObject({ ok: false, seq }) // …but the backup anchor catches it
  })
})
