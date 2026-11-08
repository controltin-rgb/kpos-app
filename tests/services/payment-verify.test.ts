import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/db/connection'
import { migrate } from '@main/db/migrate'
import { seedSystemRoles } from '@main/services/seed'
import { MOCK_PAID_AFTER_MS } from '@main/services/payment-verify.service'
import { createTestApp } from '../helpers/app'
import { MIGRATIONS_DIR } from '../helpers/fixtures'
import { closeAfter, migrationsDir, tmpDir } from '../helpers/tmp'

describe('PromptPay automatic check (D41)', () => {
  it('manual mode never auto-confirms; test mode reports the money after a delay; unconnected providers fall back', async () => {
    const t = createTestApp()
    await t.setup()
    const since = t.now()
    const ask = () => t.call(1, 'pos.verifyPromptPay', { amountSatang: 4_500, since })

    expect(await ask()).toEqual({ status: 'unavailable', message: 'manual' }) // default: staff confirm

    await t.call(1, 'settings.update', { 'promptpay.verify_mode': 'auto', 'promptpay.provider': 'mock' })
    expect((await ask()).status).toBe('pending')
    t.advance(MOCK_PAID_AFTER_MS)
    expect((await ask()).status).toBe('paid')

    await t.call(1, 'settings.update', { 'promptpay.provider': 'kbank', 'promptpay.merchant_id': 'M-1' })
    expect(await ask()).toEqual({ status: 'unavailable', message: 'not_connected' })
  })

  it('stores the provider API key outside the database and audits the change', async () => {
    const t = createTestApp()
    await t.setup()
    expect(await t.call(1, 'payments.verifyInfo')).toEqual({ hasApiKey: false })
    expect(await t.call(1, 'payments.saveApiKey', { apiKey: 'sk_live_abc' })).toEqual({ hasApiKey: true })
    expect(JSON.stringify(t.db.prepare('SELECT value_json FROM settings').pluck().all())).not.toContain('sk_live_abc')
    expect(JSON.stringify(t.db.prepare('SELECT after_json FROM audit_log').pluck().all())).not.toContain('sk_live_abc')
    expect(t.auditActions()).toContain('settings.payment_api_key')
    expect(await t.call(1, 'payments.saveApiKey', { apiKey: null })).toEqual({ hasApiKey: false })

    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'payments.saveApiKey', { apiKey: 'x' })
  })
})

describe('migration 0009 on an existing shop', () => {
  it('lets the roles created before this version read the manual', () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    const old = migrationsDir(Object.fromEntries(all.filter((f) => f < '0009').map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')])))
    const dbPath = join(tmpDir('kposs-0009-'), 'kposs.sqlite')
    const db = closeAfter(openDatabase(dbPath))
    migrate(db, { dbPath, migrationsDir: old, backupDir: join(dbPath, '..', 'bk') })
    seedSystemRoles(db)
    db.prepare(`DELETE FROM role_permissions WHERE permission LIKE 'manual:%' OR permission = 'system:update'`).run() // as an older version left them
    migrate(db, { dbPath, migrationsDir: MIGRATIONS_DIR, backupDir: join(dbPath, '..', 'bk') })
    const has = (key: string) => (db.prepare(`SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ? AND rp.permission = 'manual:view'`).pluck().get(key) as number) === 1
    expect(['branch_manager', 'head_barista', 'cashier'].map(has)).toEqual([true, true, true])
  })
})
