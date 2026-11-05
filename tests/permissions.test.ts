import { describe, expect, it } from 'vitest'
import {
  ALL_PERMISSIONS,
  grantsFor,
  hasPermission,
  isPermission,
  normalizePermissions,
  SYSTEM_ROLES,
  type Permission,
} from '@shared/permissions'

const role = (key: string) => {
  const r = SYSTEM_ROLES.find((x) => x.key === key)
  if (!r) throw new Error(key)
  return grantsFor(r)
}

describe('permission catalogue', () => {
  it('uses unique resource:action keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
    for (const p of ALL_PERMISSIONS) expect(p).toMatch(/^[a-z_]+:[a-z_]+$/)
  })
  it('validates keys', () => {
    expect(isPermission('pos:void')).toBe(true)
    expect(isPermission('pos:fly')).toBe(false)
  })
  it('makes create/update/delete imply view', () => {
    expect(normalizePermissions(['products:update'])).toEqual(['products:update', 'products:view'])
  })
})

describe('system roles (D6)', () => {
  it('has exactly the 5 confirmed roles, ordered by rank', () => {
    expect(SYSTEM_ROLES.map((r) => r.key)).toEqual(['super_admin', 'owner', 'branch_manager', 'head_barista', 'cashier'])
    const ranks = SYSTEM_ROLES.map((r) => r.rank)
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks)
  })

  it('Super Admin has everything, including permissions added later', () => {
    const g = role('super_admin')
    for (const p of ALL_PERMISSIONS) expect(hasPermission(g, p)).toBe(true)
    expect(hasPermission(g, 'future:thing' as Permission)).toBe(true)
  })

  it('Owner has everything except license:manage', () => {
    const g = role('owner')
    const missing = ALL_PERMISSIONS.filter((p) => !hasPermission(g, p))
    expect(missing).toEqual(['license:manage'])
  })

  it('Branch Manager cannot restore, manage licenses, or edit roles/settings', () => {
    const g = role('branch_manager')
    for (const p of ['backup:restore', 'license:manage', 'roles:update', 'settings:update', 'users:delete'] as const)
      expect(hasPermission(g, p), p).toBe(false)
    for (const p of ['pos:void', 'inventory:approve_count', 'orders:refund', 'users:create'] as const)
      expect(hasPermission(g, p), p).toBe(true)
  })

  it('Head Barista manages stock but cannot approve counts or void bills', () => {
    const g = role('head_barista')
    expect(hasPermission(g, 'inventory:update')).toBe(true)
    expect(hasPermission(g, 'kds:update')).toBe(true)
    expect(hasPermission(g, 'inventory:approve_count')).toBe(false)
    expect(hasPermission(g, 'pos:void')).toBe(false)
  })

  it('Cashier sells and closes own shift but cannot void, discount or see costs', () => {
    const g = role('cashier')
    for (const p of ['pos:create', 'shift:create', 'shift:update', 'expenses:create', 'shift:open_drawer'] as const)
      expect(hasPermission(g, p), p).toBe(true)
    for (const p of ['pos:void', 'pos:discount', 'reports:view_cost', 'shift:view_all', 'users:view'] as const)
      expect(hasPermission(g, p), p).toBe(false)
  })

  it('every system role grant list is already normalized and valid', () => {
    for (const r of SYSTEM_ROLES) {
      if (r.permissions === '*') continue
      expect(normalizePermissions(r.permissions)).toEqual([...r.permissions].sort())
    }
  })
})
