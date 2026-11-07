import type { Db } from '@main/db/connection'
import type { ParsedInput } from '@shared/api'
import { AUDIT_TYPE_PREFIXES, type AuditEntryDto, type AuditOverviewDto } from '@shared/api-system'

const DAY = 86_400_000
const ICT = 7 * 3_600_000
const bangkokDayStart = (ms: number) => Math.floor((ms + ICT) / DAY) * DAY - ICT

interface Row {
  id: string
  seq: number
  created_at: number
  user_id: string | null
  user_name: string | null
  device_name: string | null
  permission: string | null
  action: string
  entity: string | null
  entity_id: string | null
  reason: string | null
  risk: 'low' | 'medium' | 'high'
  before_json: string | null
  after_json: string | null
}

const parse = (s: string | null): unknown => (s === null ? null : (JSON.parse(s) as unknown))
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Read side of the Audit Log page (docs/design/Audit.dc.html). The log itself is append-only (rule 3). */
export class AuditQueryService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(input: ParsedInput<'audit.list'>): { items: AuditEntryDto[]; total: number } {
    const where: string[] = []
    const params: unknown[] = []
    if (input.userId === 'system') where.push('a.user_id IS NULL')
    else if (input.userId) {
      where.push('a.user_id = ?')
      params.push(input.userId)
    }
    if (input.risk !== 'all') {
      where.push('a.risk = ?')
      params.push(input.risk)
    }
    if (input.type !== 'all') {
      const prefixes = AUDIT_TYPE_PREFIXES[input.type]
      where.push(`(${prefixes.map(() => `a.action LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      params.push(...prefixes.map((p) => `${likeEscape(p)}%`))
    }
    if (input.q) {
      const q = `%${likeEscape(input.q)}%`
      where.push(
        `(a.action LIKE ? ESCAPE '\\' OR a.permission LIKE ? ESCAPE '\\' OR a.reason LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\'
          OR a.after_json LIKE ? ESCAPE '\\' OR a.before_json LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')`,
      )
      params.push(q, q, q, q, q, q, q)
    }
    const from = `FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN devices d ON d.id = a.device_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
    const total = this.db.prepare(`SELECT count(*) ${from}`).pluck().get(...params) as number
    const rows = this.db
      .prepare(
        `SELECT a.id, a.seq, a.created_at, a.user_id, u.display_name AS user_name, d.name AS device_name, a.permission, a.action,
                a.entity, a.entity_id, a.reason, a.risk, a.before_json, a.after_json
         ${from} ORDER BY a.seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as Row[]
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        createdAt: r.created_at,
        userId: r.user_id,
        userName: r.user_name,
        deviceName: r.device_name,
        permission: r.permission,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        reason: r.reason,
        risk: r.risk,
        before: parse(r.before_json),
        after: parse(r.after_json),
      })),
    }
  }

  overview(): AuditOverviewDto {
    const now = this.now()
    const today = bangkokDayStart(now)
    const one = (sql: string, ...p: unknown[]) => (this.db.prepare(sql).pluck().get(...p) as number | null) ?? 0
    const users = this.db
      .prepare(
        `SELECT a.user_id AS id, coalesce(u.display_name, u.username) AS name
         FROM (SELECT DISTINCT user_id FROM audit_log) a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.user_id IS NULL, name`,
      )
      .all() as { id: string | null; name: string | null }[]
    return {
      today: one('SELECT count(*) FROM audit_log WHERE created_at >= ?', today),
      high7d: one(`SELECT count(*) FROM audit_log WHERE risk = 'high' AND created_at >= ?`, today - 6 * DAY),
      // counts the system (user_id NULL) as one actor, like the prototype ("รวมระบบอัตโนมัติ")
      activeUsersToday: one(`SELECT count(*) FROM (SELECT DISTINCT ifnull(user_id, '') FROM audit_log WHERE created_at >= ?)`, today),
      total: one('SELECT count(*) FROM audit_log'),
      users: users.map((u) => ({ id: u.id, name: u.name ?? '' })),
    }
  }
}
