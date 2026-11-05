import { expect } from 'vitest'
import { createAppContext } from '@main/app-context'
import type { Channel, Input, Output } from '@shared/api'
import type { Envelope, ErrorCode } from '@shared/errors'
import { migratedDb, T0 } from './fixtures'

export const ADMIN = { username: 'admin', password: 'admin-pass-1234', displayName: 'ผู้ดูแล' }

/** In-memory app (real migrations, real BetterAuth, real router) with a controllable clock. */
export function createTestApp() {
  const db = migratedDb()
  let t = T0
  const app = createAppContext({ db, authSecret: 'test-secret-'.padEnd(48, 'x'), now: () => t, log: process.env['KPOSS_TEST_LOG'] ? (m, e) => console.error(m, e) : () => {} })

  const raw = (sender: number, channel: string, input?: unknown) => app.dispatch(sender, channel, input)

  /** Calls and expects success. */
  async function call<C extends Channel>(sender: number, channel: C, input?: Input<C>): Promise<Output<C>> {
    const res = (await raw(sender, channel, input)) as Envelope<Output<C>>
    if (!res.ok) throw new Error(`${channel} failed: ${JSON.stringify(res.error)}`)
    return res.data
  }

  /** Calls and expects a specific error code. Returns the error payload. */
  async function fails<C extends Channel>(code: ErrorCode, sender: number, channel: C, input?: Input<C>) {
    const res = await raw(sender, channel, input)
    expect(res.ok, `${channel} should fail with ${code}`).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error.code).toBe(code)
    return res.error
  }

  /** Runs first-run setup on sender 1 (logged in as Super Admin). */
  async function setup() {
    return call(1, 'setup.complete', { shopName: 'KPOSS Cafe', branchName: 'สาขาหลัก', ...ADMIN })
  }

  async function roleId(key: string): Promise<string> {
    const r = db.prepare('SELECT id FROM roles WHERE key = ?').pluck().get(key) as string | undefined
    if (!r) throw new Error(`role ${key}`)
    return r
  }

  /** Admin (sender 1) creates a user; then logs that user in on `sender`. */
  async function userOn(sender: number, username: string, roleKey: string, opts: { mustChangePassword?: boolean } = {}) {
    const password = `${username}-pass-1234`
    const user = await call(1, 'users.create', {
      username,
      displayName: username,
      roleId: await roleId(roleKey),
      password,
      mustChangePassword: opts.mustChangePassword ?? false,
    })
    await call(sender, 'auth.login', { username, password })
    return { ...user, password }
  }

  const auditActions = () => db.prepare('SELECT action FROM audit_log ORDER BY seq').pluck().all() as string[]

  return {
    db,
    app,
    raw,
    call,
    fails,
    setup,
    roleId,
    userOn,
    auditActions,
    advance: (ms: number) => {
      t += ms
    },
  }
}
