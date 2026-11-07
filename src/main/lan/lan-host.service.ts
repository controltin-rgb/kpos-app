import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import type { LicenseService } from '@main/license/license.service'
import type { AuditService } from '@main/services/audit.service'
import type { DeviceService } from '@main/services/device.service'
import type { LanDeviceDto } from '@shared/api-lan'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { clientProof, hostProof, PAIRING_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, safeEqualHex, type PairRequest, type PairResponse } from './protocol'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const ONLINE_WINDOW_MS = 2 * 60_000
const TOUCH_EVERY_MS = 30_000

interface DeviceRow {
  id: string
  name: string
  kind: LanDeviceDto['kind']
  hardware_id: string
  last_seen_at: number | null
  created_at: number
  revoked_at: number | null
}

/**
 * Host side of the LAN (D34): pairing codes, device tokens, the list of Clients.
 * Tokens are random 256-bit values; only their SHA-256 is stored (devices.token_hash).
 */
export class LanHostService {
  private pairing: { code: string; expiresAt: number; attempts: number; startedBy: string } | null = null
  private readonly lastTouch = new Map<string, number>()
  private readonly org: OrgRepo
  /** device ids with an open event stream (set by the LAN server) */
  connected: ReadonlySet<string> = new Set()

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly license: LicenseService,
    private readonly devices: DeviceService,
    private readonly now: () => number = Date.now,
  ) {
    this.org = new OrgRepo(db)
  }

  startPairing(actor: Actor): { code: string; expiresAt: number } {
    const code = Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairing = { code, expiresAt, attempts: 0, startedBy: actor.userId }
    this.db
      .transaction(() => {
        this.audit.append({ action: 'lan.pairing_start', permission: 'settings:update', userId: actor.userId, branchId: actor.branchId, entity: 'device', after: { expiresAt }, risk: 'medium' })
      })
      .immediate()
    return { code, expiresAt }
  }

  cancelPairing(): void {
    this.pairing = null
  }

  activePairing(): { code: string; expiresAt: number } | null {
    if (this.pairing && this.pairing.expiresAt <= this.now()) this.pairing = null
    return this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null
  }

  /** Completes pairing for a Client that proved it knows the code for this certificate. */
  pair(req: PairRequest, certFingerprint: string): PairResponse {
    const p = this.activePairing() ? this.pairing! : null
    if (!p) throw new AppError('LAN_PAIRING_INVALID')
    if (!safeEqualHex(req.proof, clientProof(p.code, certFingerprint))) {
      // a wrong guess burns an attempt; too many closes pairing (no brute force within the 10 minutes)
      if (++p.attempts >= PAIRING_MAX_ATTEMPTS) this.pairing = null
      throw new AppError('LAN_PAIRING_INVALID')
    }
    const branch = this.org.firstBranch()
    if (!branch) throw new AppError('LAN_PAIRING_INVALID')

    const existing = this.db.prepare('SELECT id FROM devices WHERE branch_id = ? AND hardware_id = ?').pluck().get(branch.id, req.hardwareId) as string | undefined
    const active = this.db
      .prepare(`SELECT count(*) FROM devices WHERE role = 'client' AND revoked_at IS NULL AND id IS NOT ?`)
      .pluck()
      .get(existing ?? null) as number
    const max = this.license.status().features.maxClients
    if (active >= max) throw new AppError('LAN_CLIENT_LIMIT', { max })

    const token = randomBytes(32).toString('base64url')
    const at = this.now()
    const deviceId = existing ?? uuidv7(at)
    this.db
      .transaction(() => {
        if (existing) {
          this.db
            .prepare(`UPDATE devices SET name = ?, kind = ?, role = 'client', token_hash = ?, registered_by = ?, revoked_at = NULL, last_seen_at = ? WHERE id = ?`)
            .run(req.deviceName, req.kind, sha256(token), p.startedBy, at, deviceId)
        } else {
          this.db
            .prepare(
              `INSERT INTO devices (id, branch_id, name, role, kind, hardware_id, token_hash, registered_by, last_seen_at, created_at)
               VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?)`,
            )
            .run(deviceId, branch.id, req.deviceName, req.kind, req.hardwareId, sha256(token), p.startedBy, at, at)
        }
        this.audit.append({
          action: 'lan.pair',
          permission: 'settings:update',
          userId: p.startedBy,
          branchId: branch.id,
          entity: 'device',
          entityId: deviceId,
          after: { name: req.deviceName, kind: req.kind, hardwareId: req.hardwareId, repaired: !!existing },
          risk: 'high',
        })
      })
      .immediate()
    const code = p.code
    this.pairing = null // one code, one device
    return { deviceId, token, hostName: this.devices.local.name, shopName: branch.company_name, branchName: branch.name, hostProof: hostProof(code, certFingerprint, deviceId) }
  }

  /** Bearer token → device id (null when unknown or revoked). Updates last_seen_at at most every 30 s. */
  authenticate(token: string): string | null {
    if (!token || token.length > 100) return null
    const id = this.db.prepare(`SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL AND role = 'client'`).pluck().get(sha256(token)) as string | undefined
    if (!id) return null
    const at = this.now()
    if ((this.lastTouch.get(id) ?? 0) + TOUCH_EVERY_MS < at) {
      this.lastTouch.set(id, at)
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id)
    }
    return id
  }

  list(): LanDeviceDto[] {
    const rows = this.db.prepare(`SELECT id, name, kind, hardware_id, last_seen_at, created_at, revoked_at FROM devices WHERE role = 'client' ORDER BY revoked_at IS NOT NULL, created_at`).all() as DeviceRow[]
    const now = this.now()
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      hardwareId: r.hardware_id,
      lastSeenAt: r.last_seen_at,
      pairedAt: r.created_at,
      revoked: r.revoked_at !== null,
      online: r.revoked_at === null && (this.connected.has(r.id) || (r.last_seen_at ?? 0) > now - ONLINE_WINDOW_MS),
    }))
  }

  revoke(actor: Actor, id: string): void {
    const row = this.db.prepare(`SELECT id, name FROM devices WHERE id = ? AND role = 'client'`).get(id) as { id: string; name: string } | undefined
    if (!row) throw new AppError('NOT_FOUND')
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?').run(this.now(), id)
        this.audit.append({ action: 'lan.revoke', permission: 'settings:update', userId: actor.userId, branchId: actor.branchId, entity: 'device', entityId: id, before: { name: row.name, revoked: false }, after: { revoked: true }, risk: 'high' })
      })
      .immediate()
  }
}
