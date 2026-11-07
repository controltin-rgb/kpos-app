import { join } from 'node:path'
import { expect } from 'vitest'
import { createAppContext, type AppContextOptions } from '@main/app-context'
import type { Channel, Input, Output } from '@shared/api'
import type { Envelope, ErrorCode } from '@shared/errors'
import { openDatabase, type Db } from '@main/db/connection'
import { migrate } from '@main/db/migrate'
import type { BackupPaths } from '@main/backup/backup.service'
import { migratedDb, MIGRATIONS_DIR, T0 } from './fixtures'
import { closeAfter } from './tmp'
import { TEST_HW, TEST_LICENSE_KEYS } from './license'

export const ADMIN = { username: 'admin', password: 'admin-pass-1234', displayName: 'ผู้ดูแล' }

export interface TestAppOptions {
  /** use a database file (needed for backups) instead of :memory: */
  files?: BackupPaths
  relaunch?: () => void
  /** start the clock here (default T0) */
  startAt?: number
  /** licensing: this machine's id and the trusted public keys */
  hardwareId?: string
  licensePublicKeys?: readonly string[]
  /** Host/Client networking */
  lan?: AppContextOptions['lan']
  printHtml?: AppContextOptions['printHtml']
  saveFile?: AppContextOptions['saveFile']
  /** start the change journal (needs files) in <backupDir>/journal; restored = a restore was just swapped in */
  journal?: boolean | { restored: boolean }
  /** this machine's identity (default: POS-01, standalone) */
  device?: AppContextOptions['device']
}

/** In-memory app (real migrations, real BetterAuth, real router) with a controllable clock. */
export function createTestApp(opts: TestAppOptions = {}) {
  let db: Db
  if (opts.files) {
    db = closeAfter(openDatabase(opts.files.dbPath))
    migrate(db, { dbPath: opts.files.dbPath, migrationsDir: MIGRATIONS_DIR, backupDir: opts.files.backupDir })
  } else db = migratedDb()
  let t = opts.startAt ?? T0
  const app = createAppContext({
    db,
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    now: () => t,
    ...(opts.files ? { backupPaths: opts.files } : {}),
    ...(opts.files && opts.journal ? { journal: { dir: join(opts.files.backupDir, 'journal'), restored: typeof opts.journal === 'object' && opts.journal.restored } } : {}),
    ...(opts.relaunch ? { relaunch: opts.relaunch } : {}),
    hardwareId: opts.hardwareId ?? TEST_HW,
    licensePublicKeys: opts.licensePublicKeys ?? [TEST_LICENSE_KEYS.pub],
    ...(opts.lan ? { lan: opts.lan } : {}),
    ...(opts.printHtml ? { printHtml: opts.printHtml } : {}),
    ...(opts.saveFile ? { saveFile: opts.saveFile } : {}),
    ...(opts.device ? { device: opts.device } : {}),
    log: process.env['KPOSS_TEST_LOG'] ? (m, e) => console.error(m, e) : () => {},
  })

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
    now: () => t,
  }
}
