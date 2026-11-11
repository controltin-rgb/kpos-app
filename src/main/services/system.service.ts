import type { Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { stageReset } from '@main/backup/reset'
import { DEFAULT_ABOUT, parseAbout, type AboutInfo } from '@shared/about'
import type { ManualPageDto } from '@shared/api-system'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { BUILTIN_MANUAL, MANUAL_SLUG_RE } from '@shared/manual'
import type { AuditService } from './audit.service'

interface ManualRow {
  id: string
  slug: string
  title: string
  body: string
  sort: number
  custom: number
  hidden: number
  updated_at: number
  updated_by_name: string | null
}

/** System menu: About page (editable), user manual (built-in pages + shop edits), database reset. */
export class SystemService {
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly now: () => number = Date.now,
  ) {
    this.org = new OrgRepo(db)
  }

  // ---- About ---------------------------------------------------------------

  about(): { info: AboutInfo; edited: boolean; updatedAt: number | null } {
    const row = this.db.prepare(`SELECT value_json, updated_at FROM settings WHERE key = 'system.about' AND branch_id IS NULL`).get() as { value_json: string; updated_at: number } | undefined
    if (!row) return { info: DEFAULT_ABOUT, edited: false, updatedAt: null }
    return { info: parseAbout(JSON.parse(row.value_json)), edited: true, updatedAt: row.updated_at }
  }

  /** info = null → back to the shipped text */
  saveAbout(actor: Actor, info: AboutInfo | null) {
    const before = this.about()
    const at = this.now()
    this.db.transaction(() => {
      if (info) this.org.setSetting({ id: uuidv7(at), key: 'system.about', branchId: null, value: info, userId: actor.userId, now: at })
      else this.db.prepare(`DELETE FROM settings WHERE key = 'system.about' AND branch_id IS NULL`).run()
      this.audit.append({
        action: 'system.about_update',
        permission: 'system:update',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'settings',
        entityId: 'system.about',
        before: before.edited ? before.info : null,
        after: info,
        risk: 'low',
      })
    }).immediate()
    return this.about()
  }

  // ---- Manual --------------------------------------------------------------

  manual(includeHidden: boolean): ManualPageDto[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.slug, m.title, m.body, m.sort, m.custom, m.hidden, m.updated_at, u.display_name AS updated_by_name
         FROM manual_pages m LEFT JOIN users u ON u.id = m.updated_by`,
      )
      .all() as ManualRow[]
    const bySlug = new Map(rows.map((r) => [r.slug, r]))
    const pages: ManualPageDto[] = BUILTIN_MANUAL.map((d) => {
      const r = bySlug.get(d.slug)
      return r
        ? { slug: d.slug, title: r.title, body: r.body, sort: r.sort, builtin: true, edited: true, hidden: r.hidden === 1, updatedAt: r.updated_at, updatedByName: r.updated_by_name }
        : { slug: d.slug, title: d.title, body: d.body, sort: d.sort, builtin: true, edited: false, hidden: false, updatedAt: null, updatedByName: null }
    })
    const builtin = new Set(BUILTIN_MANUAL.map((d) => d.slug))
    for (const r of rows)
      if (!builtin.has(r.slug))
        pages.push({ slug: r.slug, title: r.title, body: r.body, sort: r.sort, builtin: false, edited: true, hidden: r.hidden === 1, updatedAt: r.updated_at, updatedByName: r.updated_by_name })
    return pages.filter((p) => includeHidden || !p.hidden).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title, 'th'))
  }

  /** slug null = new page (slug generated); a built-in slug stores the shop's version of that page */
  saveManualPage(actor: Actor, input: { slug: string | null; title: string; body: string; sort?: number | undefined; hidden?: boolean | undefined }): ManualPageDto {
    const at = this.now()
    const builtin = BUILTIN_MANUAL.find((d) => d.slug === input.slug)
    const existing = input.slug ? (this.db.prepare('SELECT * FROM manual_pages WHERE slug = ?').get(input.slug) as ManualRow | undefined) : undefined
    if (input.slug && !builtin && !existing) throw new AppError('NOT_FOUND')
    const slug = input.slug ?? `p${at.toString(36)}`
    if (!MANUAL_SLUG_RE.test(slug)) throw new AppError('INVALID_INPUT', { invalid: ['slug'] })
    // a new page goes after everything (built-in or the shop's)
    const last = () => Math.max(...BUILTIN_MANUAL.map((d) => d.sort), (this.db.prepare('SELECT ifnull(max(sort), 0) FROM manual_pages').pluck().get() as number)) + 10
    const sort = input.sort ?? existing?.sort ?? builtin?.sort ?? last()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO manual_pages (id, slug, title, body, sort, custom, hidden, created_at, updated_at, updated_by)
           VALUES (@id, @slug, @title, @body, @sort, @custom, @hidden, @at, @at, @user)
           ON CONFLICT (slug) DO UPDATE SET title = excluded.title, body = excluded.body, sort = excluded.sort,
             hidden = excluded.hidden, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run({ id: uuidv7(at), slug, title: input.title, body: input.body, sort, custom: builtin ? 0 : 1, hidden: input.hidden ? 1 : 0, at, user: actor.userId })
      this.audit.append({
        action: existing || builtin ? 'manual.update' : 'manual.create',
        permission: 'manual:update',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'manual_pages',
        entityId: slug,
        before: existing ? { title: existing.title, chars: existing.body.length, hidden: existing.hidden === 1 } : builtin ? { title: builtin.title, builtin: true } : null,
        after: { title: input.title, chars: input.body.length, hidden: !!input.hidden },
        risk: 'low',
      })
    }).immediate()
    return this.manual(true).find((p) => p.slug === slug)!
  }

  /** Built-in page → back to the shipped text; shop page → deleted. */
  resetManualPage(actor: Actor, slug: string): void {
    const row = this.db.prepare('SELECT * FROM manual_pages WHERE slug = ?').get(slug) as ManualRow | undefined
    if (!row) return
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM manual_pages WHERE slug = ?').run(slug)
      this.audit.append({
        action: row.custom ? 'manual.delete' : 'manual.reset',
        permission: 'manual:update',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'manual_pages',
        entityId: slug,
        before: { title: row.title, chars: row.body.length },
        risk: 'low',
      })
    }).immediate()
  }

  // ---- Reset database ------------------------------------------------------

  /**
   * Stages a full reset (Super Admin only, own password re-entered). The caller restarts the app;
   * applyPendingReset() removes the DB before it is opened again. No backup is taken (user decision);
   * snapshot files already on disk stay where they are.
   */
  async stageDatabaseReset(actor: Actor, password: string, dbPath: string | null): Promise<void> {
    if (actor.roleKey !== 'super_admin') throw new AppError('SUPER_ADMIN_ONLY')
    if (!dbPath) throw new AppError('BACKUP_UNAVAILABLE') // Client / in-memory: this process does not own a DB file
    await this.authService.verifyOwnPassword(actor, password)
    const at = this.now()
    // recorded in the old log (kept in any earlier backup) and again as the first entry of the new one
    this.db.transaction(() => {
      this.audit.append({ action: 'system.database_reset_requested', permission: 'backup:restore', userId: actor.userId, branchId: actor.branchId, entity: 'system', risk: 'high' })
    }).immediate()
    stageReset(this.db, dbPath, { userId: actor.userId, name: actor.displayName }, at)
  }
}
