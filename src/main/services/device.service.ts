import type { Db } from '@main/db/connection'
import { remoteScope } from '@main/request-scope'

export interface LocalDevice {
  /** stable id kept in userData/device.json */
  id: string
  name: string
  hardwareId: string
  role: 'standalone' | 'host' | 'client'
}

/**
 * The machine a call acts for. Normally this machine (its `devices` row is created lazily once a
 * branch exists — first-run setup creates the branch); for a call from a paired Client over the LAN
 * it is that Client (request scope, D33). Shifts, bills and audit rows reference it.
 */
export class DeviceService {
  private localRegistered = false

  constructor(
    private readonly db: Db,
    readonly local: LocalDevice,
    private readonly now: () => number = Date.now,
  ) {}

  /** devices.id of the machine the current call acts for. */
  currentId(): string {
    return remoteScope()?.deviceId ?? this.local.id
  }

  /** Name of the current device (shown on the POS / receipts). */
  currentName(): string {
    const scope = remoteScope()
    if (!scope) return this.local.name
    return (this.db.prepare('SELECT name FROM devices WHERE id = ?').pluck().get(scope.deviceId) as string | undefined) ?? scope.deviceId
  }

  /** Ensures the current device row exists for the branch and returns its id. Safe inside a transaction. */
  ensure(branchId: string): string {
    const scope = remoteScope()
    if (scope) return scope.deviceId // paired Clients are registered at pairing time
    const row = this.db.prepare('SELECT id FROM devices WHERE id = ?').pluck().get(this.local.id)
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO devices (id, branch_id, name, role, kind, hardware_id, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'pos', ?, ?, ?)`,
        )
        .run(this.local.id, branchId, this.local.name, this.local.role, this.local.hardwareId, this.now(), this.now())
    }
    this.localRegistered = true
    return this.local.id
  }

  /** Device id for audit rows, only when a devices row exists (FK). */
  auditDeviceId(): string | null {
    const scope = remoteScope()
    if (scope) return scope.deviceId
    if (!this.localRegistered) this.localRegistered = !!this.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(this.local.id)
    return this.localRegistered ? this.local.id : null
  }
}
