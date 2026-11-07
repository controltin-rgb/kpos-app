import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS } from '@shared/permissions'
import { createTestApp } from '../helpers/app'
import { installLicense } from '../helpers/license'

describe('IPC router', () => {
  it('rejects unknown channels', async () => {
    const t = createTestApp()
    await t.fails('NOT_FOUND', 1, 'db.exec' as never, 'DROP TABLE users' as never)
    await t.fails('NOT_FOUND', 1, '__proto__' as never)
  })

  it('validates input with zod', async () => {
    const t = createTestApp()
    await t.setup()
    const err = await t.fails('INVALID_INPUT', 1, 'users.create', { username: 'x', displayName: '', roleId: 'r', password: '1' })
    expect(Object.keys(err.fields ?? {})).toEqual(expect.arrayContaining(['username', 'displayName', 'password']))
  })

  it('refuses calls without the permission and audits the attempt (rule 5)', async () => {
    const t = createTestApp()
    await t.setup()
    await t.userOn(2, 'cashier1', 'cashier')
    const err = await t.fails('FORBIDDEN', 2, 'users.list', {})
    expect(err.data).toEqual({ permission: 'users:view' })
    await t.fails('FORBIDDEN', 2, 'roles.update', { id: 'x', permissions: ['*'] })
    const denied = t.db
      .prepare(`SELECT permission, risk FROM audit_log WHERE action = 'auth.permission_denied'`)
      .all()
    expect(denied).toEqual([
      { permission: 'users:view', risk: 'medium' },
      { permission: 'roles:update', risk: 'medium' },
    ])
  })

  it('hides internal error details', async () => {
    const t = createTestApp()
    await t.setup()
    t.db.exec('DROP TABLE role_permissions')
    const res = await t.raw(1, 'roles.list')
    expect(res).toEqual({ ok: false, error: { code: 'INTERNAL' } })
  })
})

describe('user management rules', () => {
  it('lets Owner manage lower ranks but not Super Admins', async () => {
    const t = createTestApp()
    await t.setup()
    await t.userOn(2, 'owner1', 'owner')
    const superAdminId = (await t.call(1, 'auth.me'))!.userId

    const cashier = await t.call(2, 'users.create', {
      username: 'cashier1',
      displayName: 'แคชเชียร์',
      roleId: await t.roleId('cashier'),
      password: 'cashier-1234',
    })
    expect(cashier.mustChangePassword).toBe(true) // default for accounts created by someone else

    await t.fails('RANK_FORBIDDEN', 2, 'users.update', { id: superAdminId, displayName: 'hacked' })
    await t.fails('RANK_FORBIDDEN', 2, 'users.resetPassword', { id: superAdminId, newPassword: 'takeover-123' })
    await t.fails('RANK_FORBIDDEN', 2, 'users.update', { id: cashier.id, roleId: await t.roleId('super_admin') })
    await t.fails('RANK_FORBIDDEN', 2, 'users.update', { id: cashier.id, roleId: await t.roleId('owner') })

    const options = await t.call(2, 'users.roleOptions')
    expect(options.filter((o) => o.assignable).map((o) => o.key)).toEqual(['branch_manager', 'head_barista', 'cashier'])
    expect((await t.call(2, 'users.get', { id: superAdminId })).editable).toBe(false)
  })

  it('never lets a user disable, delete or re-role themselves', async () => {
    const t = createTestApp()
    const me = await t.setup()
    await t.fails('CANNOT_MODIFY_SELF', 1, 'users.update', { id: me.userId, active: false })
    await t.fails('CANNOT_MODIFY_SELF', 1, 'users.update', { id: me.userId, roleId: await t.roleId('cashier') })
    await t.fails('CANNOT_MODIFY_SELF', 1, 'users.delete', { id: me.userId })
    // own display name is fine
    expect((await t.call(1, 'users.update', { id: me.userId, displayName: 'ชื่อใหม่' })).displayName).toBe('ชื่อใหม่')
  })

  it('keeps usernames unique, case-insensitively, including deleted accounts', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'cashier1', 'cashier')
    const create = { displayName: 'x', roleId: await t.roleId('cashier'), password: 'pass-12345' }
    await t.fails('USERNAME_TAKEN', 1, 'users.create', { username: 'CASHIER1', ...create })
    await t.call(1, 'users.delete', { id: u.id })
    await t.fails('USERNAME_TAKEN', 1, 'users.create', { username: 'cashier1', ...create })
  })

  it('enforces the employee cap on create and re-activation', async () => {
    const t = createTestApp()
    await t.setup()
    await installLicense(t, { features: { maxEmployees: 3 } }) // the cap comes from the license (D29)
    const create = (username: string) => ({ username, displayName: username, roleId: '', password: 'pass-12345' })
    const cashierRole = await t.roleId('cashier')
    const a = await t.call(1, 'users.create', { ...create('emp1'), roleId: cashierRole })
    await t.call(1, 'users.create', { ...create('emp2'), roleId: cashierRole })
    const err = await t.fails('EMPLOYEE_CAP_REACHED', 1, 'users.create', { ...create('emp3'), roleId: cashierRole })
    expect(err.data).toEqual({ cap: 3 })

    await t.call(1, 'users.update', { id: a.id, active: false })
    await t.call(1, 'users.create', { ...create('emp3'), roleId: cashierRole })
    await t.fails('EMPLOYEE_CAP_REACHED', 1, 'users.update', { id: a.id, active: true })
    const list = await t.call(1, 'users.list', {})
    expect([list.activeCount, list.employeeCap]).toEqual([3, 3])
  })

  it('paginates (7 per page by default) and filters', async () => {
    const t = createTestApp()
    await t.setup()
    t.db.prepare(`UPDATE settings SET value_json = '50' WHERE key = 'license.employee_cap'`).run()
    const cashierRole = await t.roleId('cashier')
    for (let i = 0; i < 9; i++)
      await t.call(1, 'users.create', { username: `cash${i}`, displayName: `แคชเชียร์ ${i}`, roleId: cashierRole, password: 'pass-12345' })
    const p1 = await t.call(1, 'users.list', {})
    expect([p1.items.length, p1.total, p1.pageSize]).toEqual([7, 10, 7])
    expect(p1.items[0]!.username).toBe('admin') // highest rank first
    const p2 = await t.call(1, 'users.list', { page: 2 })
    expect(p2.items.length).toBe(3)
    expect((await t.call(1, 'users.list', { roleId: cashierRole })).total).toBe(9)
    expect((await t.call(1, 'users.list', { search: 'cash1' })).total).toBe(1)
    expect((await t.call(1, 'users.list', { search: '%' })).total).toBe(0) // LIKE wildcards are escaped
  })

  it('audits user changes with before/after', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'cashier1', 'cashier')
    await t.call(1, 'users.update', { id: u.id, roleId: await t.roleId('head_barista') })
    const row = t.db
      .prepare(`SELECT before_json, after_json, risk FROM audit_log WHERE action = 'users.update'`)
      .get() as Record<string, string>
    expect(JSON.parse(row['before_json']!).roleKey).toBe('cashier')
    expect(JSON.parse(row['after_json']!).roleKey).toBe('head_barista')
    expect(row['risk']).toBe('high')
  })
})

describe('role management rules', () => {
  it('seeds locked roles: Super Admin = *, Owner = everything but license:manage', async () => {
    const t = createTestApp()
    const perms = (key: string) =>
      t.db
        .prepare('SELECT permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ?')
        .pluck()
        .all(key) as string[]
    expect(perms('super_admin')).toEqual(['*'])
    expect(new Set(perms('owner'))).toEqual(new Set(ALL_PERMISSIONS.filter((p) => p !== 'license:manage')))
  })

  it('refuses to edit locked roles, even for Super Admin', async () => {
    const t = createTestApp()
    await t.setup()
    await t.fails('ROLE_LOCKED', 1, 'roles.update', { id: await t.roleId('owner'), permissions: [] })
    await t.fails('ROLE_LOCKED', 1, 'roles.delete', { id: await t.roleId('super_admin') })
  })

  it('blocks privilege escalation', async () => {
    const t = createTestApp()
    await t.setup()
    await t.userOn(2, 'owner1', 'owner')
    const err = await t.fails('PRIVILEGE_ESCALATION', 2, 'roles.update', {
      id: await t.roleId('branch_manager'),
      permissions: ['license:manage', 'pos:view'],
    })
    expect(err.data).toEqual({ permissions: ['license:manage'] })
    await t.fails('INVALID_INPUT', 2, 'roles.update', { id: await t.roleId('cashier'), permissions: ['*'] })
  })

  it('applies permission changes immediately to logged-in users', async () => {
    const t = createTestApp()
    await t.setup()
    await t.userOn(2, 'cashier1', 'cashier')
    await t.fails('FORBIDDEN', 2, 'users.list', {})
    const cashier = (await t.call(1, 'roles.list')).find((r) => r.key === 'cashier')!
    await t.call(1, 'roles.update', { id: cashier.id, permissions: [...cashier.permissions, 'users:view'] })
    await t.call(2, 'users.list', {})
  })

  it('creates custom roles with implied view permissions and audits them', async () => {
    const t = createTestApp()
    await t.setup()
    const role = await t.call(1, 'roles.create', { name: 'ดูแลสต็อก', permissions: ['inventory:update', 'inventory:adjust'] })
    expect(role.permissions).toEqual(['inventory:adjust', 'inventory:update', 'inventory:view'])
    expect(role).toMatchObject({ isSystem: false, locked: false, editable: true, rank: 40 })
    expect(t.auditActions()).toContain('roles.create')
  })

  it('deletes custom roles only when unused; never system roles', async () => {
    const t = createTestApp()
    await t.setup()
    const role = await t.call(1, 'roles.create', { name: 'บัญชี', permissions: ['reports:view'] })
    const u = await t.call(1, 'users.create', { username: 'acc1', displayName: 'บัญชี', roleId: role.id, password: 'pass-12345' })
    await t.fails('ROLE_IN_USE', 1, 'roles.delete', { id: role.id })
    await t.call(1, 'users.update', { id: u.id, roleId: await t.roleId('cashier') })
    await t.call(1, 'roles.delete', { id: role.id })
    expect((await t.call(1, 'roles.list')).some((r) => r.id === role.id)).toBe(false)
    await t.fails('ROLE_LOCKED', 1, 'roles.delete', { id: await t.roleId('cashier') })
  })

  it('Branch Manager cannot edit roles at all', async () => {
    const t = createTestApp()
    await t.setup()
    await t.userOn(2, 'manager1', 'branch_manager')
    expect((await t.call(2, 'roles.list')).length).toBe(5)
    await t.fails('FORBIDDEN', 2, 'roles.update', { id: await t.roleId('cashier'), name: 'x' })
  })
})

describe('audit chain after a full session of admin work', () => {
  it('stays verifiable', async () => {
    const t = createTestApp()
    await t.setup()
    const u = await t.userOn(2, 'cashier1', 'cashier')
    await t.call(1, 'users.setPin', { id: u.id, pin: '1234' })
    await t.call(1, 'roles.create', { name: 'x', permissions: ['pos:view'] })
    const r = await t.call(1, 'audit.verify')
    expect(r).toMatchObject({ ok: true })
    expect(r.count).toBeGreaterThan(5)
  })
})
