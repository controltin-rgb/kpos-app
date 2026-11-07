import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { applyPendingRestore } from '@main/backup/backup.service'
import { readSegment, tableShapes } from '@main/backup/journal'
import { createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'
import { requestId, seedShop } from '../helpers/shop'
import { T0 } from '../helpers/fixtures'
import { closeAfter, tmpDir } from '../helpers/tmp'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function files() {
  const root = tmpDir('kposs-journal-')
  return { root, dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }
}
type Files = ReturnType<typeof files>

async function journalApp(f: Files = files(), opts: { relaunch?: () => void; startAt?: number } = {}) {
  const t = createTestApp({ files: f, journal: true, ...opts })
  await t.setup()
  await installLicense(t)
  return { t, f, jdir: join(f.backupDir, 'journal') }
}

type App = Awaited<ReturnType<typeof journalApp>>['t']

async function sell(t: App, shop: Awaited<ReturnType<typeof seedShop>>) {
  return t.call(1, 'pos.checkout', {
    requestId: requestId(),
    orderType: 'takeaway',
    items: [{ productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] }],
    payment: { method: 'cash', tenderedSatang: 10_000 },
  })
}

/** Every table's rows (journal bookkeeping excluded), for comparing two database files. */
function dump(path: string): Record<string, unknown[]> {
  const db = closeAfter(new Database(path, { readonly: true }))
  const out: Record<string, unknown[]> = {}
  for (const t of tableShapes(db)) out[t.name] = db.prepare(`SELECT * FROM "${t.name}" ORDER BY ${t.pk.length ? t.pk.map((c) => `"${c}"`).join(', ') : 'rowid'}`).all()
  db.close()
  return out
}

const segFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('seg-')) : [])

describe('change journal (D38)', () => {
  it('captures every row change and ships it to segment files every tick', async () => {
    const { t, jdir } = await journalApp()
    expect(t.app.journal?.isStarted).toBe(true)
    expect(t.auditActions()).toContain('backup.journal_start')
    const pending = t.db.prepare('SELECT count(*) FROM change_journal').pluck().get() as number
    expect(pending).toBeGreaterThan(0) // setup wrote users, roles, branch, audit …

    // one transaction → one time for all its rows
    const before = t.db.prepare('SELECT max(seq) FROM change_journal').pluck().get() as number
    t.advance(5_000)
    await t.call(1, 'catalog.saveCategory', { name: 'กาแฟ', kdsStation: 'bar' })
    const rows = t.db.prepare('SELECT at, tbl, op FROM change_journal WHERE seq > ?').all(before) as { at: number; tbl: string; op: string }[]
    expect(rows.map((r) => r.tbl)).toEqual(expect.arrayContaining(['categories', 'audit_log']))
    expect(new Set(rows.map((r) => r.at))).toEqual(new Set([t.now()]))

    expect(t.app.journal!.ship().shipped).toBe(pending + rows.length)
    expect(t.db.prepare('SELECT count(*) FROM change_journal').pluck().get()).toBe(0)
    const segs = segFiles(jdir)
    expect(segs).toHaveLength(1)
    const entries = readSegment(join(jdir, segs[0]!))
    expect(entries.map((e) => e[0])).toEqual(entries.map((_, i) => entries[0]![0] + i)) // contiguous
    // the journal is invisible to the backup: TEMP triggers are not copied
    const b = await t.call(1, 'backup.run')
    const copy = closeAfter(new Database(join(t.app.backup.overview().localDir, b.fileName), { readonly: true }))
    expect(copy.prepare(`SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'kposs_j_%'`).pluck().get()).toBe(0)
    copy.close()
  })

  it('restores the exact state at a point in time (snapshot + replay)', async () => {
    const { t } = await journalApp()
    const base = await t.app.backup.ensureJournalBase() // the timeline's first snapshot
    expect(base?.kind).toBe('snapshot')
    t.advance(60_000)
    const shop = await seedShop(t)
    await t.call(1, 'shift.open', { openingFloatSatang: 50_000 })
    t.advance(60_000)
    const first = await sell(t, shop)
    t.app.journal!.ship()
    t.advance(1_000)
    // reference: a snapshot of exactly this state (its own bookkeeping rows are written after the copy)
    const ref = await t.call(1, 'backup.run')
    const point = t.now() - 500 // after the first sale, before the reference backup's own rows

    t.advance(60_000)
    await sell(t, shop)
    await t.call(1, 'catalog.saveCategory', { name: 'หลังจุดกู้', kdsStation: 'bar' })
    await t.call(1, 'catalog.deleteCategory', { id: shop.category.id }).catch(() => null)

    const pitr = await t.call(1, 'backup.pitrCopy', { at: point, confirm: 'RESTORE' })
    expect(pitr).toMatchObject({ bills: 1, auditOk: true, lostBills: 1, lostSalesSatang: 4_500, pointInTime: point })
    expect(pitr.changes).toBeGreaterThan(50)
    expect(pitr.appliedUntil).toBeLessThanOrEqual(point)
    expect(dump(pitr.path)).toEqual(dump(join(t.app.backup.overview().localDir, ref.fileName)))
    const restored = closeAfter(new Database(pitr.path, { readonly: true }))
    expect(restored.prepare('SELECT id FROM bills').pluck().all()).toEqual([first.bill.id])
    restored.close()
    expect(t.auditActions()).toContain('backup.pitr_copy')
  })

  it('refuses a time outside the restorable range', async () => {
    const { t } = await journalApp()
    await t.fails('PITR_OUT_OF_RANGE', 1, 'backup.pitrCopy', { at: t.now(), confirm: 'RESTORE' }) // no base snapshot yet
    await t.app.backup.ensureJournalBase()
    t.advance(1_000)
    await t.fails('PITR_OUT_OF_RANGE', 1, 'backup.pitrCopy', { at: T0 - DAY, confirm: 'RESTORE' })
    const ov = await t.call(1, 'backup.overview')
    expect(ov.pitr).toMatchObject({ keepDays: 14, intervalSec: 10 })
    expect(ov.pitr!.ranges).toEqual([{ from: expect.any(Number), to: t.now() }])
  })

  it('replace: stages the point, restarts on a new timeline that can itself be restored', async () => {
    const relaunch = vi.fn()
    const f = files()
    const { t } = await journalApp(f, { relaunch })
    await t.app.backup.ensureJournalBase()
    t.advance(60_000)
    await t.userOn(2, 'kept_user', 'cashier')
    t.advance(60_000)
    const point = t.now()
    t.advance(60_000)
    await t.userOn(3, 'lost_user', 'cashier')
    const timeline1 = t.app.journal!.timeline

    const res = await t.call(1, 'backup.pitrReplace', { at: point, confirm: 'RESTORE' })
    expect(res.restarting).toBe(true)
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce(), { timeout: 2_000 })
    expect(t.auditActions()).toContain('backup.restore_requested')
    t.app.journal!.ship() // will-quit
    t.db.close()

    const result = applyPendingRestore(f.dbPath, point + 10 * 60_000)
    expect(result).toMatchObject({ status: 'applied', pending: { pointInTime: point } })
    const t2 = createTestApp({ files: f, journal: { restored: true }, startAt: point + 10 * 60_000 })
    t2.app.backup.completeRestore(result)
    const names = t2.db.prepare('SELECT username FROM users ORDER BY username').pluck().all()
    expect(names).toContain('kept_user')
    expect(names).not.toContain('lost_user')
    expect(t2.app.audit.verifyChain().ok).toBe(true)
    expect(t2.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'backup.restore'`).pluck().get()).toContain(String(point))

    // a new timeline with its own base snapshot; the old one stays restorable up to the restore
    expect(t2.app.journal!.timeline).not.toBe(timeline1)
    await t2.app.backup.ensureJournalBase()
    t2.advance(60_000)
    const ranges = t2.app.backup.overview().pitr!.ranges
    expect(ranges).toHaveLength(2)
  })

  it('a database that went back in time (restored by hand) starts a new timeline', async () => {
    const f = files()
    const { t } = await journalApp(f)
    const tl = t.app.journal!.timeline
    t.app.journal!.ship()
    // simulate: shop restores an older copy by hand → journal_state says tl but its seq is behind
    t.db.prepare(`UPDATE sqlite_sequence SET seq = 1 WHERE name = 'change_journal'`).run()
    t.db.close()
    const t2 = createTestApp({ files: f, journal: true })
    expect(t2.app.journal!.timeline).not.toBe(tl)
    expect(t2.db.prepare(`SELECT reason FROM journal_state`).pluck().get()).toBe('diverged')
  })

  it('survives a crash mid-append and re-shipped rows', async () => {
    const { t, jdir } = await journalApp()
    await t.app.backup.ensureJournalBase()
    t.advance(1_000)
    await t.userOn(2, 'user1', 'cashier')
    t.app.journal!.ship()
    const seg = segFiles(jdir).at(-1)!
    // a torn line at the end (power cut during the append)
    appendFileSync(join(jdir, seg), '[999999,1,"users","i",null,"{\\"id')
    expect(() => readSegment(join(jdir, seg))).not.toThrow()
    t.advance(1_000)
    await t.userOn(3, 'user2', 'cashier')
    t.app.journal!.ship()
    const pitr = await t.call(1, 'backup.pitrCopy', { at: t.now(), confirm: 'RESTORE' })
    const db = closeAfter(new Database(pitr.path, { readonly: true }))
    expect(db.prepare(`SELECT count(*) FROM users WHERE username IN ('user1', 'user2')`).pluck().get()).toBe(2)
    db.close()
  })

  it('mirrors the journal to the off-site folder', async () => {
    const { t, jdir } = await journalApp()
    const off = tmpDir('kposs-offsite-')
    await t.call(1, 'backup.saveSchedule', { dailyTime: '03:00', keepDaily: 14, offsiteEnabled: true, offsiteDir: off })
    t.app.journal!.ship()
    await t.call(1, 'catalog.saveCategory', { name: 'x', kdsStation: 'bar' })
    t.app.journal!.ship()
    const local = readdirSync(jdir).sort()
    expect(readdirSync(join(off, 'journal')).sort()).toEqual(local)
    for (const n of local) expect(readFileSync(join(off, 'journal', n), 'utf8')).toBe(readFileSync(join(jdir, n), 'utf8'))
    expect((await t.call(1, 'backup.overview')).pitr?.offsite).toBe('ok')
  })

  it('keeps 14 days: segments already inside the newest base before the window are removed', async () => {
    const { t, jdir } = await journalApp()
    const j = t.app.journal!
    const mk = async (name: string) => {
      await t.call(1, 'catalog.saveCategory', { name, kdsStation: 'bar' })
      j.ship()
      t.advance(HOUR) // next segment
    }
    await mk('a')
    await mk('b')
    const seqAfterB = t.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'change_journal'`).pluck().get() as number
    await mk('c')
    expect(segFiles(jdir)).toHaveLength(3)
    t.advance(20 * DAY)
    const removed = j.prune([{ timeline: j.timeline, finishedAt: T0 + 2 * HOUR, seq: seqAfterB }])
    expect(removed).toHaveLength(2)
    expect(segFiles(jdir)).toHaveLength(1)
  })

  it('is off without a database file (tests in memory / Client mode)', () => {
    const t = createTestApp()
    expect(t.app.journal).toBeNull()
    mkdirSync(tmpDir('x'), { recursive: true })
  })
})
