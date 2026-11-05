import { createHash } from 'node:crypto'
import type { Db } from '@main/db/connection'
import { AuditRepo, type AuditRow } from '@main/db/repos/audit.repo'
import { uuidv7 } from '@shared/id'
import type { Permission } from '@shared/permissions'

export const GENESIS_HASH = '0'.repeat(64)

export type AuditRisk = 'low' | 'medium' | 'high'

export interface AuditEntry {
  action: string
  permission?: Permission
  branchId?: string | null
  userId?: string | null
  deviceId?: string | null
  entity?: string | null
  entityId?: string | null
  before?: unknown
  after?: unknown
  reason?: string | null
  risk?: AuditRisk
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAtSeq: number; reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'sequence_gap' }
  | { ok: false; count: number; reason: 'head_mismatch' }

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

const toJson = (v: unknown) => (v === undefined || v === null ? null : canonicalJson(v))

/** hash = SHA256(prev_hash || canonical_json(row without hash)) — Implement.md §5.3 */
function computeHash(row: Omit<AuditRow, 'hash'>): string {
  const { prev_hash, ...rest } = row
  return createHash('sha256').update(prev_hash).update(canonicalJson(rest)).digest('hex')
}

/**
 * Append-only, hash-chained audit log.
 * `append` is synchronous and must be called INSIDE the caller's `BEGIN IMMEDIATE` transaction
 * so the audit row commits or rolls back together with the change it describes.
 */
export class AuditService {
  private readonly repo: AuditRepo

  constructor(
    db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.repo = new AuditRepo(db)
  }

  append(e: AuditEntry): { id: string; seq: number; prevHash: string; hash: string } {
    const last = this.repo.last()
    const base: Omit<AuditRow, 'hash'> = {
      id: uuidv7(),
      seq: (last?.seq ?? 0) + 1,
      branch_id: e.branchId ?? null,
      user_id: e.userId ?? null,
      device_id: e.deviceId ?? null,
      permission: e.permission ?? null,
      action: e.action,
      entity: e.entity ?? null,
      entity_id: e.entityId ?? null,
      before_json: toJson(e.before),
      after_json: toJson(e.after),
      reason: e.reason ?? null,
      risk: e.risk ?? 'low',
      created_at: this.now(),
      prev_hash: last?.hash ?? GENESIS_HASH,
    }
    const hash = computeHash(base)
    this.repo.insert({ ...base, hash })
    return { id: base.id, seq: base.seq, prevHash: base.prev_hash, hash }
  }

  /** Latest {seq, hash}; store it off-box (e.g. in backups) to detect truncation of the tail. */
  head(): { seq: number; hash: string } | null {
    return this.repo.last() ?? null
  }

  /** Recomputes the whole chain — backs the "ตรวจสอบความสมบูรณ์" button on the Audit page. */
  verifyChain(opts: { expectHead?: { seq: number; hash: string } | null } = {}): VerifyResult {
    let expectedSeq = 1
    let prev = GENESIS_HASH
    const count = this.repo.count()
    const broken = (seq: number, reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'sequence_gap') =>
      ({ ok: false, count, brokenAtSeq: seq, reason }) as const
    for (const row of this.repo.iterate()) {
      if (row.seq !== expectedSeq) return broken(row.seq, 'sequence_gap')
      if (row.prev_hash !== prev) return broken(row.seq, 'prev_hash_mismatch')
      const { hash, ...rest } = row
      if (computeHash(rest) !== hash) return broken(row.seq, 'hash_mismatch')
      prev = hash
      expectedSeq++
    }
    const expect = opts.expectHead
    if (expect && (expect.seq !== count || expect.hash !== prev)) return { ok: false, count, reason: 'head_mismatch' }
    return { ok: true, count }
  }
}
