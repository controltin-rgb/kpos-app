import { describe, expect, it } from 'vitest'
import { auditTypeOf } from '@shared/api-system'
import { createTestApp } from '../helpers/app'

async function app() {
  const t = createTestApp()
  await t.setup()
  await t.userOn(2, 'cashier1', 'cashier')
  await t.fails('FORBIDDEN', 2, 'users.list') // auth.permission_denied (medium)
  await t.userOn(3, 'cashier2', 'cashier')
  await t.call(1, 'settings.update', { 'vat.rate_bp': 0 }) // settings.update (high: VAT)
  return t
}

describe('audit.list', () => {
  it('maps actions to the filter groups of the Audit page', () => {
    expect(auditTypeOf('bill.void')).toBe('bill')
    expect(auditTypeOf('waste.record')).toBe('stock')
    expect(auditTypeOf('roles.update')).toBe('auth')
    expect(auditTypeOf('backup.run')).toBe('config')
    expect(auditTypeOf('something.else')).toBeNull()
  })

  it('lists newest first with user names and parsed before/after', async () => {
    const t = await app()
    const { items, total } = await t.call(1, 'audit.list', {})
    expect(total).toBe(t.auditActions().length)
    expect(items.length).toBeLessThanOrEqual(7)
    expect(items[0]).toMatchObject({ action: 'settings.update', risk: 'high', userName: 'ผู้ดูแล', before: { 'vat.rate_bp': 700 }, after: { 'vat.rate_bp': 0 } })
    expect(items.map((i) => i.seq)).toEqual([...items.map((i) => i.seq)].sort((a, b) => b - a))
  })

  it('filters by type, risk, user and free text', async () => {
    const t = await app()
    const auth = await t.call(1, 'audit.list', { type: 'auth', pageSize: 50 })
    expect(auth.items.length).toBeGreaterThan(0)
    expect(auth.items.every((i) => /^(auth|users|roles)\./.test(i.action))).toBe(true)

    const high = await t.call(1, 'audit.list', { risk: 'high', pageSize: 50 })
    expect(high.items.every((i) => i.risk === 'high')).toBe(true)

    const cashierId = t.db.prepare(`SELECT id FROM users WHERE username = 'cashier1'`).pluck().get() as string
    const mine = await t.call(1, 'audit.list', { userId: cashierId, pageSize: 50 })
    expect(mine.items.length).toBeGreaterThan(0)
    expect(mine.items.every((i) => i.userId === cashierId)).toBe(true)

    const found = await t.call(1, 'audit.list', { q: 'vat.rate_bp' })
    expect(found.items.map((i) => i.action)).toEqual(['settings.update'])
    // LIKE wildcards in the search box are literal
    expect((await t.call(1, 'audit.list', { q: '%' })).total).toBe(0)
  })

  it('paginates 7 per page and needs audit:view', async () => {
    const t = await app()
    const p1 = await t.call(1, 'audit.list', { page: 1 })
    const p2 = await t.call(1, 'audit.list', { page: 2 })
    expect(p1.items).toHaveLength(7)
    expect(p2.items[0]!.seq).toBeLessThan(p1.items.at(-1)!.seq)
    await t.fails('FORBIDDEN', 2, 'audit.list', {})
  })

  it('overview counts today, high risk in 7 days and the users seen', async () => {
    const t = await app()
    const o = await t.call(1, 'audit.overview')
    expect(o.total).toBe(t.auditActions().length)
    expect(o.today).toBe(o.total)
    expect(o.high7d).toBeGreaterThanOrEqual(1)
    expect(o.users.map((u) => u.name)).toEqual(expect.arrayContaining(['ผู้ดูแล', 'cashier1']))
  })
})
