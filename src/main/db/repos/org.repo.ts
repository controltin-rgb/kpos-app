import type { Db } from '../connection'

export interface BranchRow {
  id: string
  company_id: string
  code: string
  name: string
  company_name: string
}

/** companies, branches, settings */
export class OrgRepo {
  constructor(private readonly db: Db) {}

  firstBranch(): BranchRow | undefined {
    return this.db
      .prepare(
        `SELECT b.id, b.company_id, b.code, b.name, c.name AS company_name
         FROM branches b JOIN companies c ON c.id = b.company_id
         WHERE b.deleted_at IS NULL ORDER BY b.created_at LIMIT 1`,
      )
      .get() as BranchRow | undefined
  }

  branch(id: string): BranchRow | undefined {
    return this.db
      .prepare(
        `SELECT b.id, b.company_id, b.code, b.name, c.name AS company_name
         FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = ?`,
      )
      .get(id) as BranchRow | undefined
  }

  insertCompany(row: { id: string; name: string; now: number }): void {
    this.db
      .prepare('INSERT INTO companies (id, name, created_at, updated_at) VALUES (@id, @name, @now, @now)')
      .run(row)
  }

  insertBranch(row: { id: string; company_id: string; code: string; name: string; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO branches (id, company_id, code, name, created_at, updated_at)
         VALUES (@id, @company_id, @code, @name, @now, @now)`,
      )
      .run(row)
  }

  getSetting<T>(key: string, branchId: string | null = null): T | undefined {
    const row = this.db
      .prepare(
        `SELECT value_json FROM settings WHERE key = ? AND (branch_id IS ? OR branch_id IS NULL)
         ORDER BY branch_id IS NULL LIMIT 1`,
      )
      .pluck()
      .get(key, branchId) as string | undefined
    return row === undefined ? undefined : (JSON.parse(row) as T)
  }

  setSetting(row: { id: string; key: string; branchId: string | null; value: unknown; userId: string | null; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO settings (id, branch_id, key, value_json, updated_at, updated_by)
         VALUES (@id, @branchId, @key, @value_json, @now, @userId)
         ON CONFLICT (ifnull(branch_id, ''), key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by, rev = rev + 1`,
      )
      .run({ ...row, value_json: JSON.stringify(row.value) })
  }
}
