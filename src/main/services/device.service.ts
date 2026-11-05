import type { Db } from '@main/db/connection'

export interface LocalDevice {
  /** stable id kept in userData/device.json */
  id: string
  name: string
  hardwareId: string
  role: 'standalone' | 'host' | 'client'
}

/**
 * The machine this app runs on. Its `devices` row is created lazily once a branch exists
 * (first-run setup creates the branch). Shifts and bills reference it.
 */
export class DeviceService {
  constructor(
    private readonly db: Db,
    readonly local: LocalDevice,
    private readonly now: () => number = Date.now,
  ) {}

  /** Ensures the local device row exists for the branch and returns its id. Safe inside a transaction. */
  ensure(branchId: string): string {
    const row = this.db.prepare('SELECT id FROM devices WHERE id = ?').pluck().get(this.local.id)
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO devices (id, branch_id, name, role, kind, hardware_id, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'pos', ?, ?, ?)`,
        )
        .run(this.local.id, branchId, this.local.name, this.local.role, this.local.hardwareId, this.now(), this.now())
    }
    return this.local.id
  }
}
