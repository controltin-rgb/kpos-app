import { getMigrations } from 'better-auth/db/migration'
import { describe, expect, it } from 'vitest'
import { LOCK_DURATION_MS, MAX_FAILED_ATTEMPTS } from '@main/auth/auth.service'
import { hashPin, verifyPinHash } from '@main/auth/pin'
import { ADMIN, createTestApp } from '../helpers/app'

describe('BetterAuth schema (0002_auth.sql)', () => {
  it('matches what better-auth expects — nothing to create or add', async () => {
    const { app } = createTestApp()
    const m = await getMigrations(app.auth.options)
    expect(m.toBeCreated).toEqual([])
    expect(m.toBeAdded).toEqual([])
  })
})

describe('first-run setup', () => {
  it('creates shop, branch and a logged-in Super Admin once', async () => {
    const t = createTestApp()
    expect(await t.call(9, 'setup.status')).toEqual({ setupRequired: true, shopName: null, branchName: null })

    const me = await t.setup()
    expect(me).toMatchObject({ username: 'admin', roleKey: 'super_admin', permissions: ['*'], mustChangePassword: false })
    expect(await t.call(1, 'auth.me')).toMatchObject({ username: 'admin' })
    expect(await t.call(9, 'setup.status')).toEqual({ setupRequired: false, shopName: 'KPOSS Cafe', branchName: 'สาขาหลัก' })

    await t.fails('SETUP_ALREADY_DONE', 2, 'setup.complete', {
      shopName: 'x',
      branchName: 'y',
      username: 'intruder',
      displayName: 'x',
      password: 'intruder-1234',
    })
    expect(t.auditActions()).toEqual(['system.setup', 'auth.login'])
  })

  it('rejects weak passwords with field errors', async () => {
    const t = createTestApp()
    const err = await t.fails('INVALID_INPUT', 1, 'setup.complete', {
      shopName: 'a',
      branchName: 'b',
      username: 'admin',
      displayName: 'A',
      password: 'short',
    })
    expect(err.fields?.['password']).toBeDefined()
  })
})

describe('login / logout', () => {
  it('logs in, resolves the session per window, and logs out', async () => {
    const t = createTestApp()
    await t.setup()
    expect(await t.call(2, 'auth.me')).toBeNull()
    await t.fails('UNAUTHENTICATED', 2, 'users.list', {})

    await t.call(2, 'auth.login', ADMIN)
    expect((await t.call(2, 'users.list', {})).total).toBe(1)

    await t.call(2, 'auth.logout')
    expect(await t.call(2, 'auth.me')).toBeNull()
    await t.fails('UNAUTHENTICATED', 2, 'users.list', {})
    // window 1 keeps its own session
    expect(await t.call(1, 'auth.me')).toMatchObject({ username: 'admin' })
  })

  it('accepts the username case-insensitively', async () => {
    const t = createTestApp()
    await t.setup()
    await t.call(2, 'auth.login', { username: 'ADMIN', password: ADMIN.password })
  })

  it('does not reveal whether the username exists', async () => {
    const t = createTestApp()
    await t.setup()
    await t.fails('INVALID_CREDENTIALS', 2, 'auth.login', { username: 'nobody', password: 'whatever-123' })
    await t.fails('INVALID_CREDENTIALS', 2, 'auth.login', { username: 'admin', password: 'wrong-password' })
  })

  it(`locks the account for 5 minutes after ${MAX_FAILED_ATTEMPTS} failures (audited)`, async () => {
    const t = createTestApp()
    await t.setup()
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      await t.fails('INVALID_CREDENTIALS', 2, 'auth.login', { username: 'admin', password: 'wrong-password' })
    }
    const err = await t.fails('ACCOUNT_LOCKED', 2, 'auth.login', { username: 'admin', password: 'wrong-password' })
    expect(err.data?.['lockedUntil']).toBeTypeOf('number')
    // even the right password is refused while locked
    await t.fails('ACCOUNT_LOCKED', 2, 'auth.login', ADMIN)
    expect(t.auditActions()).toContain('auth.lockout')

    t.advance(LOCK_DURATION_MS + 1)
    await t.call(2, 'auth.login', ADMIN)
  })

  it('forces a password change before anything else, then clears the flag', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'newbie', 'cashier', { mustChangePassword: true })
    expect(await t.call(2, 'auth.me')).toMatchObject({ mustChangePassword: true })
    await t.fails('PASSWORD_CHANGE_REQUIRED', 2, 'users.list', {})

    await t.fails('INVALID_CREDENTIALS', 2, 'auth.changePassword', { currentPassword: 'nope-nope', newPassword: 'brand-new-1234' })
    const me = await t.call(2, 'auth.changePassword', { currentPassword: u.password, newPassword: 'brand-new-1234' })
    expect(me.mustChangePassword).toBe(false)

    await t.call(3, 'auth.login', { username: 'newbie', password: 'brand-new-1234' })
    await t.fails('INVALID_CREDENTIALS', 4, 'auth.login', { username: 'newbie', password: u.password })
  })

  it('ends sessions of a user who gets disabled', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'cashier1', 'cashier')
    expect(await t.call(2, 'auth.me')).toMatchObject({ username: 'cashier1' })

    await t.call(1, 'users.update', { id: u.id, active: false })
    expect(await t.call(2, 'auth.me')).toBeNull()
    await t.fails('ACCOUNT_DISABLED', 2, 'auth.login', { username: 'cashier1', password: u.password })
  })
})

describe('PIN', () => {
  it('hashes with scrypt and verifies', () => {
    const h = hashPin('1234')
    expect(h.startsWith('scrypt:')).toBe(true)
    expect(verifyPinHash('1234', h)).toBe(true)
    expect(verifyPinHash('4321', h)).toBe(false)
    expect(() => hashPin('12')).toThrow()
    expect(() => hashPin('12ab')).toThrow()
  })

  it('is set through users.setPin and checked with lockout', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'barista', 'head_barista')
    expect((await t.call(1, 'users.setPin', { id: u.id, pin: '2468' })).hasPin).toBe(true)

    expect(t.app.authService.verifyPin(u.id, '2468').username).toBe('barista')
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) expect(() => t.app.authService.verifyPin(u.id, '0000')).toThrow()
    expect(() => t.app.authService.verifyPin(u.id, '0000')).toThrow('ACCOUNT_LOCKED')
    expect(() => t.app.authService.verifyPin(u.id, '2468')).toThrow('ACCOUNT_LOCKED')
  })
})

describe('secrets never reach the audit log or the renderer', () => {
  it('keeps passwords, PIN and hashes out of audit rows and responses', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'cashier1', 'cashier')
    const detail = await t.call(1, 'users.setPin', { id: u.id, pin: '1357' })
    await t.call(1, 'users.resetPassword', { id: u.id, newPassword: 'reset-pass-999' })

    const dump = JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all())
    for (const secret of [ADMIN.password, u.password, '1357', 'reset-pass-999', 'scrypt']) expect(dump).not.toContain(secret)
    expect(JSON.stringify(detail)).not.toMatch(/scrypt|pin_hash|1357/)
    const me = await t.call(1, 'auth.me')
    expect(JSON.stringify(me)).not.toMatch(/token/i)
  })
})
