import type { Db } from '../connection'

export interface AuditRow {
  id: string
  seq: number
  branch_id: string | null
  user_id: string | null
  device_id: string | null
  permission: string | null
  action: string
  entity: string | null
  entity_id: string | null
  before_json: string | null
  after_json: string | null
  reason: string | null
  risk: 'low' | 'medium' | 'high'
  created_at: number
  prev_hash: string
  hash: string
}

/** Data access for audit_log. Insert-only: there is deliberately no update/delete here. */
export class AuditRepo {
  private readonly insertStmt
  private readonly lastStmt
  private readonly iterStmt
  private readonly countStmt

  constructor(db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO audit_log (id, seq, branch_id, user_id, device_id, permission, action, entity, entity_id,
         before_json, after_json, reason, risk, created_at, prev_hash, hash)
       VALUES (@id, @seq, @branch_id, @user_id, @device_id, @permission, @action, @entity, @entity_id,
         @before_json, @after_json, @reason, @risk, @created_at, @prev_hash, @hash)`,
    )
    this.lastStmt = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
    this.iterStmt = db.prepare('SELECT * FROM audit_log ORDER BY seq')
    this.countStmt = db.prepare('SELECT count(*) FROM audit_log').pluck()
  }

  insert(row: AuditRow): void {
    this.insertStmt.run(row)
  }

  last(): { seq: number; hash: string } | undefined {
    return this.lastStmt.get() as { seq: number; hash: string } | undefined
  }

  count(): number {
    return this.countStmt.get() as number
  }

  iterate(): IterableIterator<AuditRow> {
    return this.iterStmt.iterate() as IterableIterator<AuditRow>
  }
}
