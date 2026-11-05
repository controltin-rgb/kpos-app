import type { Db } from '../connection'

export interface RoleRow {
  id: string
  key: string | null
  name: string
  description: string | null
  is_system: 0 | 1
  rank: number
  max_discount_bp: number
  max_discount_satang: number
  created_at: number
  updated_at: number
  deleted_at: number | null
  rev: number
}

export class RolesRepo {
  constructor(private readonly db: Db) {}

  list(): (RoleRow & { user_count: number })[] {
    return this.db
      .prepare(
        `SELECT r.*, (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count
         FROM roles r WHERE r.deleted_at IS NULL ORDER BY r.rank DESC, r.name`,
      )
      .all() as (RoleRow & { user_count: number })[]
  }

  findById(id: string): RoleRow | undefined {
    return this.db.prepare('SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL').get(id) as RoleRow | undefined
  }

  findByKey(key: string): RoleRow | undefined {
    return this.db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as RoleRow | undefined
  }

  permissions(roleId: string): string[] {
    return this.db
      .prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission')
      .pluck()
      .all(roleId) as string[]
  }

  activeUserCount(roleId: string): number {
    return this.db
      .prepare('SELECT count(*) FROM users WHERE role_id = ? AND deleted_at IS NULL')
      .pluck()
      .get(roleId) as number
  }

  insert(row: Omit<RoleRow, 'deleted_at' | 'rev' | 'max_discount_satang'>): void {
    this.db
      .prepare(
        `INSERT INTO roles (id, key, name, description, is_system, rank, max_discount_bp, created_at, updated_at)
         VALUES (@id, @key, @name, @description, @is_system, @rank, @max_discount_bp, @created_at, @updated_at)`,
      )
      .run(row)
  }

  update(
    id: string,
    patch: Partial<Pick<RoleRow, 'name' | 'description' | 'max_discount_bp' | 'deleted_at'>>,
    now: number,
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = @${k}`).join(', ')
    this.db
      .prepare(`UPDATE roles SET ${sets}, updated_at = @__now, rev = rev + 1 WHERE id = @__id`)
      .run({ ...patch, __now: now, __id: id })
  }

  replacePermissions(roleId: string, permissions: readonly string[]): void {
    this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId)
    const ins = this.db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)')
    for (const p of permissions) ins.run(roleId, p)
  }
}
