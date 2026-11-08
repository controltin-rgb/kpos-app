import { describe, expect, it } from 'vitest'
import { ADMIN, createTestApp } from '../helpers/app'

describe('own profile and PIN (header menu, D48)', () => {
  it('lets any signed-in user edit their own name/contacts and PIN, audited, without users:update', async () => {
    const t = createTestApp()
    await t.setup()
    const cashier = await t.userOn(2, 'cashier1', 'cashier')

    const p = await t.call(2, 'profile.get')
    expect(p).toMatchObject({ username: 'cashier1', hasPin: false, email: null, phone: null })

    const u = await t.call(2, 'profile.update', { displayName: 'แคชเชียร์ หนึ่ง', email: 'c1@shop.test', phone: '0811111111' })
    expect(u).toMatchObject({ displayName: 'แคชเชียร์ หนึ่ง', email: 'c1@shop.test', phone: '0811111111' })
    expect((await t.call(2, 'auth.me'))!.displayName).toBe('แคชเชียร์ หนึ่ง')
    // '' clears; bad formats are refused
    expect((await t.call(2, 'profile.update', { displayName: 'แคชเชียร์ หนึ่ง', email: '', phone: '' })).email).toBeNull()
    await t.fails('INVALID_INPUT', 2, 'profile.update', { displayName: 'x', email: 'nope', phone: '' })
    await t.fails('INVALID_INPUT', 2, 'profile.update', { displayName: 'x', email: '', phone: '12' })
    // e-mail already used by someone else
    await t.call(1, 'profile.update', { displayName: ADMIN.displayName, email: 'owner@shop.test', phone: '' })
    await t.fails('INVALID_INPUT', 2, 'profile.update', { displayName: 'x', email: 'OWNER@shop.test', phone: '' })

    // PIN: needs the account password
    await t.fails('INVALID_CREDENTIALS', 2, 'profile.changePin', { currentPassword: 'wrong-password', newPin: '4321' })
    await t.fails('INVALID_INPUT', 2, 'profile.changePin', { currentPassword: cashier.password, newPin: '12' })
    expect((await t.call(2, 'profile.changePin', { currentPassword: cashier.password, newPin: '4321' })).hasPin).toBe(true)

    const actions = t.db.prepare("SELECT action FROM audit_log WHERE entity = 'users' AND entity_id = ? ORDER BY rowid").pluck().all(cashier.id)
    expect(actions).toEqual(expect.arrayContaining(['auth.profile_update', 'auth.pin_change']))
    // the PIN itself never reaches the audit trail
    expect(JSON.stringify(t.db.prepare("SELECT * FROM audit_log WHERE action = 'auth.pin_change'").all())).not.toContain('4321')

    // cashier still cannot touch other accounts
    await t.fails('FORBIDDEN', 2, 'users.setPin', { id: cashier.id, pin: '9999' })
  })
})
