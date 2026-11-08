import type { Db } from '../connection'

export interface UserRow {
  id: string
  branch_id: string
  role_id: string
  username: string
  display_name: string
  email: string | null
  phone: string | null
  pin_hash: string | null
  active: 0 | 1
  failed_login_count: number
  locked_until: number | null
  last_login_at: number | null
  auth_user_id: string | null
  must_change_password: 0 | 1
  created_at: number
  updated_at: number
  deleted_at: number | null
  rev: number
}

export interface UserWithRole extends UserRow {
  role_key: string | null
  role_name: string
  role_rank: number
}

export interface UserFilter {
  branchId: string
  search?: string | undefined
  roleId?: string | undefined
  status: 'all' | 'active' | 'inactive'
  limit: number
  offset: number
}

const SELECT_WITH_ROLE = `
  SELECT u.*, r.key AS role_key, r.name AS role_name, r.rank AS role_rank
  FROM users u JOIN roles r ON r.id = u.role_id`

export class UsersRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db.prepare('SELECT count(*) FROM users WHERE deleted_at IS NULL').pluck().get() as number
  }

  findById(id: string): UserWithRole | undefined {
    return this.db.prepare(`${SELECT_WITH_ROLE} WHERE u.id = ? AND u.deleted_at IS NULL`).get(id) as
      | UserWithRole
      | undefined
  }

  findByUsername(username: string): UserWithRole | undefined {
    return this.db.prepare(`${SELECT_WITH_ROLE} WHERE u.username = ? AND u.deleted_at IS NULL`).get(username) as
      | UserWithRole
      | undefined
  }

  findByAuthUserId(authUserId: string): UserWithRole | undefined {
    return this.db.prepare(`${SELECT_WITH_ROLE} WHERE u.auth_user_id = ? AND u.deleted_at IS NULL`).get(authUserId) as
      | UserWithRole
      | undefined
  }

  /** username uniqueness includes soft-deleted rows (the UNIQUE index does too) */
  usernameExists(username: string, exceptId?: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE username = ? AND id IS NOT ?').get(username, exceptId ?? null)
  }

  list(f: UserFilter): { rows: UserWithRole[]; total: number } {
    const where: string[] = ['u.deleted_at IS NULL', 'u.branch_id = @branchId']
    if (f.search) where.push(`(u.username LIKE @q ESCAPE '\\' OR u.display_name LIKE @q ESCAPE '\\')`)
    if (f.roleId) where.push('u.role_id = @roleId')
    if (f.status === 'active') where.push('u.active = 1')
    if (f.status === 'inactive') where.push('u.active = 0')
    const params = {
      branchId: f.branchId,
      q: f.search ? `%${f.search.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null,
      roleId: f.roleId ?? null,
      limit: f.limit,
      offset: f.offset,
    }
    const sqlWhere = where.join(' AND ')
    const rows = this.db
      .prepare(`${SELECT_WITH_ROLE} WHERE ${sqlWhere} ORDER BY r.rank DESC, u.display_name LIMIT @limit OFFSET @offset`)
      .all(params) as UserWithRole[]
    const total = this.db.prepare(`SELECT count(*) FROM users u WHERE ${sqlWhere}`).pluck().get(params) as number
    return { rows, total }
  }

  countActive(branchId: string): number {
    return this.db
      .prepare('SELECT count(*) FROM users WHERE branch_id = ? AND active = 1 AND deleted_at IS NULL')
      .pluck()
      .get(branchId) as number
  }

  countActiveWithRoleKey(roleKey: string): number {
    return this.db
      .prepare(
        `SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.key = ? AND u.active = 1 AND u.deleted_at IS NULL`,
      )
      .pluck()
      .get(roleKey) as number
  }

  insert(row: Omit<UserRow, 'failed_login_count' | 'locked_until' | 'last_login_at' | 'rev' | 'deleted_at'>): void {
    this.db
      .prepare(
        `INSERT INTO users (id, branch_id, role_id, username, display_name, email, phone, pin_hash, active,
           auth_user_id, must_change_password, created_at, updated_at)
         VALUES (@id, @branch_id, @role_id, @username, @display_name, @email, @phone, @pin_hash, @active,
           @auth_user_id, @must_change_password, @created_at, @updated_at)`,
      )
      .run(row)
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        UserRow,
        | 'role_id'
        | 'username'
        | 'display_name'
        | 'email'
        | 'phone'
        | 'pin_hash'
        | 'active'
        | 'must_change_password'
        | 'failed_login_count'
        | 'locked_until'
        | 'last_login_at'
        | 'deleted_at'
      >
    >,
    now: number,
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = @${k}`).join(', ')
    this.db
      .prepare(`UPDATE users SET ${sets}, updated_at = @__now, rev = rev + 1 WHERE id = @__id`)
      .run({ ...patch, __now: now, __id: id })
  }
}
