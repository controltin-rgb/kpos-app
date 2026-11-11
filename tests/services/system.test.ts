import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPendingReset, finishReset, resetMarkerPath } from '@main/backup/reset'
import { openDatabase } from '@main/db/connection'
import { migrate } from '@main/db/migrate'
import { AuditService } from '@main/services/audit.service'
import { DEFAULT_ABOUT } from '@shared/about'
import { BUILTIN_MANUAL } from '@shared/manual'
import { createTestApp } from '../helpers/app'
import { MIGRATIONS_DIR } from '../helpers/fixtures'
import { installLicense } from '../helpers/license'
import { closeAfter, tmpDir } from '../helpers/tmp'

describe('About page (system:update)', () => {
  it('shows the shipped text until edited, audits edits, resets to default', async () => {
    const t = createTestApp()
    await t.setup()
    const a0 = await t.call(1, 'system.about')
    expect(a0).toEqual({ info: DEFAULT_ABOUT, edited: false, updatedAt: null })

    const info = { ...DEFAULT_ABOUT, vendor: 'Korn Co.', contactPhone: '02-000-0000', upcoming: [{ title: 'สาขาออนไลน์', detail: '', eta: 'Q2', status: 'in_progress' as const }] }
    const a1 = await t.call(1, 'system.saveAbout', { info })
    expect(a1).toMatchObject({ info: { vendor: 'Korn Co.', upcoming: [{ title: 'สาขาออนไลน์', status: 'in_progress' }] }, edited: true })
    expect(t.auditActions()).toContain('system.about_update')

    // a cashier reads it but cannot change it
    await t.userOn(2, 'cashier1', 'cashier')
    expect((await t.call(2, 'system.about')).info.vendor).toBe('Korn Co.')
    await t.fails('FORBIDDEN', 2, 'system.saveAbout', { info })

    expect(await t.call(1, 'system.saveAbout', { info: null })).toMatchObject({ edited: false, info: DEFAULT_ABOUT })
  })
})

describe('user manual (manual:view / manual:update)', () => {
  it('lists the built-in pages, lets an editor change / hide / reset them and add pages', async () => {
    const t = createTestApp()
    await t.setup()
    const pages = await t.call(1, 'manual.list', { includeHidden: false })
    expect(pages.map((p) => p.slug)).toEqual([...BUILTIN_MANUAL].sort((a, b) => a.sort - b.sort).map((p) => p.slug))
    expect(pages.every((p) => p.builtin && !p.edited)).toBe(true)

    const edited = await t.call(1, 'manual.save', { slug: 'pos', title: 'ขายหน้าร้าน (ฉบับร้าน)', body: '# ขาย\n- ข้อ 1' })
    expect(edited).toMatchObject({ slug: 'pos', builtin: true, edited: true, title: 'ขายหน้าร้าน (ฉบับร้าน)', updatedByName: 'ผู้ดูแล' })
    const custom = await t.call(1, 'manual.save', { slug: null, title: 'เปิดร้านตอนเช้า', body: '1. เปิดไฟ\n2. เปิดกะ' })
    expect(custom).toMatchObject({ builtin: false, edited: true })
    expect(custom.sort).toBeGreaterThan(BUILTIN_MANUAL.at(-1)!.sort)
    await t.call(1, 'manual.save', { slug: 'faq', title: 'ปัญหาที่พบบ่อย', body: 'x', hidden: true })

    // staff see the shop's version, never the hidden page
    await t.userOn(2, 'cashier1', 'cashier')
    const staff = await t.call(2, 'manual.list', { includeHidden: true }) // ignored without manual:update
    expect(staff.find((p) => p.slug === 'pos')!.title).toBe('ขายหน้าร้าน (ฉบับร้าน)')
    expect(staff.some((p) => p.slug === 'faq')).toBe(false)
    expect(staff.some((p) => p.slug === custom.slug)).toBe(true)
    await t.fails('FORBIDDEN', 2, 'manual.save', { slug: 'pos', title: 'x', body: 'x' })
    expect((await t.call(1, 'manual.list', { includeHidden: true })).find((p) => p.slug === 'faq')!.hidden).toBe(true)

    // reset: built-in → shipped text, custom → gone
    await t.call(1, 'manual.reset', { slug: 'pos' })
    await t.call(1, 'manual.reset', { slug: custom.slug })
    const after = await t.call(1, 'manual.list', { includeHidden: false })
    expect(after.find((p) => p.slug === 'pos')).toMatchObject({ edited: false, title: BUILTIN_MANUAL.find((p) => p.slug === 'pos')!.title })
    expect(after.some((p) => p.slug === custom.slug)).toBe(false)
    expect(t.auditActions().filter((a) => a.startsWith('manual.'))).toEqual(['manual.update', 'manual.create', 'manual.update', 'manual.reset', 'manual.delete'])
    await t.fails('NOT_FOUND', 1, 'manual.save', { slug: 'nope', title: 'x', body: 'x' })
  })

  it('every default role can read the manual; only Owner / Super Admin edit it', async () => {
    const t = createTestApp()
    await t.setup()
    const perms = (key: string) => t.db.prepare('SELECT permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ?').pluck().all(key) as string[]
    for (const key of ['branch_manager', 'head_barista', 'cashier']) {
      expect(perms(key)).toContain('manual:view')
      expect(perms(key)).not.toContain('manual:update')
      expect(perms(key)).not.toContain('system:update')
    }
    expect(perms('owner')).toEqual(expect.arrayContaining(['manual:view', 'manual:update', 'system:update']))
  })
})

describe('reset database (Super Admin only)', () => {
  it('needs the Super Admin and their password, then wipes everything but the license and the trial start', async () => {
    const root = tmpDir('kposs-reset-')
    const files = { dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }
    const restarts: number[] = []
    const t = createTestApp({ files, relaunch: () => restarts.push(1) })
    await t.setup()
    const setupAt = t.now()
    await installLicense(t)
    const before = await t.call(1, 'license.status')
    await t.call(1, 'catalog.saveCategory', { name: 'ชา' })

    // an Owner has backup:restore but is not the Super Admin
    await t.userOn(2, 'owner1', 'owner')
    await t.fails('SUPER_ADMIN_ONLY', 2, 'system.resetDatabase', { confirm: 'RESET', password: 'owner1-pass-1234' })
    await t.fails('INVALID_CREDENTIALS', 1, 'system.resetDatabase', { confirm: 'RESET', password: 'wrong-password' })
    expect(existsSync(resetMarkerPath(files.dbPath))).toBe(false)

    t.advance(5_000)
    expect(await t.call(1, 'system.resetDatabase', { confirm: 'RESET', password: 'admin-pass-1234' })).toEqual({ restarting: true })
    expect(existsSync(resetMarkerPath(files.dbPath))).toBe(true)
    expect(t.auditActions()).toContain('system.database_reset_requested')
    t.db.close()

    // next start: the file goes before anything opens it, migrations build an empty DB
    expect(applyPendingReset(files.dbPath)).toMatchObject({ requestedByName: 'ผู้ดูแล', trialStartedAt: setupAt })
    expect(existsSync(files.dbPath)).toBe(false)
    const fresh = closeAfter(openDatabase(files.dbPath))
    migrate(fresh, { dbPath: files.dbPath, migrationsDir: MIGRATIONS_DIR, backupDir: files.backupDir })
    const audit = new AuditService(fresh)
    expect(finishReset(fresh, files.dbPath, audit, Date.now())).not.toBeNull()
    expect(finishReset(fresh, files.dbPath, audit, Date.now())).toBeNull() // once only

    expect(fresh.prepare('SELECT count(*) FROM users').pluck().get()).toBe(0)
    expect(fresh.prepare('SELECT count(*) FROM categories').pluck().get()).toBe(0)
    expect(fresh.prepare('SELECT license_id FROM licenses').pluck().get()).toBe(before.licenseId)
    expect(JSON.parse(fresh.prepare(`SELECT value_json FROM settings WHERE key = 'license.trial_started_at'`).pluck().get() as string)).toBe(setupAt)
    expect(fresh.prepare('SELECT action FROM audit_log').pluck().all()).toEqual(['system.database_reset'])
  })

  it('a reset never grants a new 30-day trial', async () => {
    const root = tmpDir('kposs-reset-trial-')
    const files = { dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }
    const t = createTestApp({ files, relaunch: () => {} })
    await t.setup()
    t.advance(40 * 86_400_000)
    expect((await t.call(1, 'license.status')).state).toBe('trial_expired')
    await t.call(1, 'system.resetDatabase', { confirm: 'RESET', password: 'admin-pass-1234' })
    t.db.close()
    applyPendingReset(files.dbPath)

    const t2 = createTestApp({ files, startAt: t.now() + 1_000 })
    finishReset(t2.db, files.dbPath, t2.app.audit, t2.now())
    t2.app.license.invalidate()
    await t2.setup()
    expect((await t2.call(1, 'license.status')).state).toBe('trial_expired')
  })
})
